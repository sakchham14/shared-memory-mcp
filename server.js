import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Database } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const DB_PATH = process.env.MEM_DB_PATH || '/Users/mochi/.claude/mem/db/mem.db';
// Token threshold at which the active "clump" (chat batch) is sealed and a new one starts.
const CLUMP_THRESHOLD = Number(process.env.MEM_CLUMP_THRESHOLD_TOKENS || 8000);
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  content_zlib BLOB,
  summary TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_id);

CREATE TABLE IF NOT EXISTS change_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  action TEXT NOT NULL,
  summary TEXT NOT NULL,
  timestamp TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clumps (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  summary TEXT,
  token_estimate INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_clumps_project ON clumps(project_id);
`);

// Add content_zlib column to databases created before compression was introduced.
try {
  db.exec('ALTER TABLE memories ADD COLUMN content_zlib BLOB');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Add clump_id column to databases created before clumps were introduced.
try {
  db.exec('ALTER TABLE memories ADD COLUMN clump_id TEXT');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Index on the new column (must run after the ALTER above, since CREATE INDEX
// IF NOT EXISTS in node:sqlite does not tolerate a missing column).
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_memories_clump ON memories(clump_id)');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

// Backfill content_zlib for rows created before compression was added.
// Content stays in plaintext too so search can run on it without decompression.
const migrate = db.prepare('SELECT id, content FROM memories WHERE content_zlib IS NULL');
for (const row of migrate.all()) {
  db.prepare('UPDATE memories SET content_zlib = ? WHERE id = ?')
    .run(deflateSync(Buffer.from(row.content, 'utf8')), row.id);
}

// Assign every pre-clump memory to a single legacy clump so clump queries work.
const hasClumpCol = db.prepare("PRAGMA table_info(memories)").all().some(c => c.name === 'clump_id');
if (hasClumpCol) {
  const unassigned = db.prepare('SELECT id FROM memories WHERE clump_id IS NULL').all();
  if (unassigned.length) {
    const legacyId = `clump_legacy_${Date.now()}`;
    db.prepare('INSERT OR IGNORE INTO clumps (id, project_id, started_at, token_estimate) VALUES (?, ?, ?, ?)')
      .run(legacyId, '__legacy__', new Date().toISOString(), 0);
    const update = db.prepare('UPDATE memories SET clump_id = ? WHERE clump_id IS NULL');
    db.exec('BEGIN');
    for (const row of unassigned) update.run(legacyId);
    db.exec('COMMIT');
  }
}

// --- Clump helpers -----------------------------------------------------------

// Rough token estimate: ~4 chars per token. Cheap, no model call.
function estimateTokens(text) {
  return Math.ceil((text || '').length / 4);
}

function activeClump(projectId) {
  return db.prepare(
    'SELECT * FROM clumps WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
  ).get(projectId);
}

function totalClumpTokens(clumpId) {
  const row = db.prepare(
    "SELECT COALESCE(SUM(length(title)+length(content)+length(summary)),0) as bytes FROM memories WHERE clump_id = ?"
  ).get(clumpId);
  return estimateTokensFromBytes(row.bytes);
}

function estimateTokensFromBytes(bytes) {
  return Math.ceil((bytes || 0) / 4);
}

// Seal a clump: mark it ended, record a summary, and start a fresh one.
// Returns { sealed, started }.
function sealClump(projectId, summary = '') {
  const active = activeClump(projectId);
  if (!active) return { sealed: null, started: null };
  db.prepare('UPDATE clumps SET ended_at = ?, summary = ?, token_estimate = ? WHERE id = ?')
    .run(new Date().toISOString(), summary || `Clump sealed at threshold`, totalClumpTokens(active.id), active.id);
  const newId = `clump_${projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO clumps (id, project_id, started_at) VALUES (?, ?, ?)')
    .run(newId, projectId, new Date().toISOString());
  return { sealed: active.id, started: newId };
}

// Ensure a project has an active clump; create one if not.
function ensureClump(projectId) {
  const active = activeClump(projectId);
  if (active) return active;
  const id = `clump_${projectId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO clumps (id, project_id, started_at) VALUES (?, ?, ?)')
    .run(id, projectId, new Date().toISOString());
  return db.prepare('SELECT * FROM clumps WHERE id = ?').get(id);
}

const server = new Server(
  { name: 'shared-memory', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'save_memory',
        description: 'Save or update a memory entry for a project or conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project or conversation identifier' },
            title: { type: 'string', description: 'Short title of the memory' },
            content: { type: 'string', description: 'Full memory content' },
            summary: { type: 'string', description: 'Brief 1-2 sentence summary for token saving' },
            memoryId: { type: 'string', description: 'Optional memory ID to update existing entry' },
          },
          required: ['projectId', 'title', 'content'],
        },
      },
      {
        name: 'search_memories',
        description: 'Full-text search across memories in a project or globally.',
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search term' },
            projectId: { type: 'string', description: 'Optional project filter' },
            limit: { type: 'number', description: 'Max results (default 10)' },
          },
          required: ['query'],
        },
      },
      {
        name: 'get_project_summary',
        description: 'Get an ordered summary and history changelog for a project/conversation.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project or conversation identifier' },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'list_projects',
        description: 'List all projects and their memory counts.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'get_project_index',
        description:
          'CHEAP project index for session start. Returns ONLY summaries and metadata — ' +
          'never full content. Use this to load context with minimal tokens, then call ' +
          'get_memory(id) for the verbatim content of anything you actually need.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project or conversation identifier' },
            includeSealed: {
              type: 'boolean',
              description: 'Include summaries of sealed (past) clumps (default true)',
              default: true,
            },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'get_clump',
        description:
          'Fetch the full verbatim content of every memory in a clump (chat batch). ' +
          'Use to reconstruct a sealed conversation. Pass clumpId from get_project_index.',
        inputSchema: {
          type: 'object',
          properties: {
            clumpId: { type: 'string', description: 'Clump ID (from get_project_index)' },
          },
          required: ['clumpId'],
        },
      },
      {
        name: 'list_clumps',
        description: 'List all clumps (chat batches) for a project, newest first.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project or conversation identifier' },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'seal_clump',
        description:
          'Manually seal the active clump for a project and start a new one. ' +
          'Use at the end of a chat batch to freeze it before context compaction.',
        inputSchema: {
          type: 'object',
          properties: {
            projectId: { type: 'string', description: 'Project or conversation identifier' },
            summary: { type: 'string', description: 'Optional summary of the sealed clump' },
          },
          required: ['projectId'],
        },
      },
      {
        name: 'get_memory',
        description:
          'Fetch one memory by ID and return its EXACT, verbatim stored content. ' +
          'Use this instead of relying on the model to recall or summarize. The returned ' +
          'text is the authoritative record — quote it directly to avoid hallucination.',
        inputSchema: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Memory ID (from search_memories or get_project_summary)' },
          },
          required: ['id'],
        },
      },
      {
        name: 'memory_stats',
        description:
          'Report storage statistics: memory count, raw vs compressed bytes, and per-project ' +
          'breakdown. Useful to see how much of the token budget memory actually consumes.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name === 'save_memory') {
    const { projectId, title, content, summary = '', memoryId } = args;
    const now = new Date().toISOString();
    const id = memoryId || `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const existing = db.prepare('SELECT id FROM memories WHERE id = ?').get(id);
    if (existing) {
      db.prepare(`
        UPDATE memories SET title = ?, content = ?, content_zlib = ?, summary = ?, updated_at = ? WHERE id = ?
      `).run(title, content, deflateSync(Buffer.from(content, 'utf8')), summary, now, id);

      db.prepare(`
        INSERT INTO change_log (memory_id, project_id, action, summary, timestamp)
        VALUES (?, ?, 'UPDATE', ?, ?)
      `).run(id, projectId, summary || `Updated: ${title}`, now);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, memoryId: id, projectId, action: 'updated' }),
          },
        ],
      };
    }

    // New memory: attach to the active clump, sealing it first if over threshold.
    let clump = ensureClump(projectId);
    const before = totalClumpTokens(clump.id);
    const newTokens = estimateTokens(title + content + summary);
    let sealed = null;
    if (before + newTokens > CLUMP_THRESHOLD) {
      const result = sealClump(projectId, `Auto-sealed after ${before + newTokens} estimated tokens`);
      clump = db.prepare('SELECT * FROM clumps WHERE id = ?').get(result.started);
      sealed = result.sealed;
    }

    db.prepare(`
      INSERT INTO memories (id, project_id, title, content, content_zlib, summary, clump_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, projectId, title, content, deflateSync(Buffer.from(content, 'utf8')), summary, clump.id, now, now);

    db.prepare(`
      INSERT INTO change_log (memory_id, project_id, action, summary, timestamp)
      VALUES (?, ?, 'CREATE', ?, ?)
    `).run(id, projectId, summary || `Created: ${title}`, now);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            memoryId: id,
            projectId,
            action: 'created',
            clumpId: clump.id,
            clumpSealed: sealed,
            clumpTokens: totalClumpTokens(clump.id),
          }),
        },
      ],
    };
  }

  if (name === 'search_memories') {
    const { query, projectId, limit = 10 } = args;
    let sql = `
      SELECT m.id, m.project_id, m.title, m.summary, m.content, m.updated_at
      FROM memories m
      WHERE m.title LIKE ? OR m.content LIKE ? OR m.summary LIKE ?
    `;
    const params = [`%${query}%`, `%${query}%`, `%${query}%` ];

    if (projectId) {
      sql += ' AND m.project_id = ?';
      params.push(projectId);
    }
    sql += ' ORDER BY m.updated_at DESC LIMIT ?';
    params.push(limit);

    const rows = db.prepare(sql).all(...params);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ count: rows.length, results: rows }, null, 2),
        },
      ],
    };
  }

  if (name === 'get_project_summary') {
    const { projectId } = args;
    const memories = db.prepare(`
      SELECT id, title, summary, content, updated_at
      FROM memories
      WHERE project_id = ?
      ORDER BY updated_at DESC
    `).all(projectId);

    const changes = db.prepare(`
      SELECT action, summary, timestamp
      FROM change_log
      WHERE project_id = ?
      ORDER BY id DESC
      LIMIT 20
    `).all(projectId);

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ projectId, memoryCount: memories.length, memories, changeHistory: changes }, null, 2),
        },
      ],
    };
  }

  if (name === 'list_projects') {
    const rows = db.prepare(`
      SELECT project_id, COUNT(*) as count, MAX(updated_at) as last_updated
      FROM memories
      GROUP BY project_id
      ORDER BY last_updated DESC
    `).all();

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ projects: rows }, null, 2),
        },
      ],
    };
  }

  if (name === 'get_memory') {
    const { id } = args;
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
    if (!row) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Memory not found: ${id}` }) }],
      };
    }
    // Return the verbatim stored content, decompressing from the BLOB when present.
    const content = row.content_zlib
      ? inflateSync(Buffer.from(row.content_zlib)).toString('utf8')
      : row.content;
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              id: row.id,
              projectId: row.project_id,
              title: row.title,
              content, // authoritative, exact — quote this to avoid hallucination
              summary: row.summary,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'memory_stats') {
    const total = db.prepare('SELECT COUNT(*) as count FROM memories').get();
    const raw = db.prepare(
      "SELECT COALESCE(SUM(length(project_id)+length(title)+length(content)+length(summary)),0) as bytes FROM memories"
    ).get();
    const compressed = db.prepare(
      'SELECT COALESCE(SUM(length(content_zlib)),0) as bytes FROM memories'
    ).get();
    const byProject = db.prepare(`
      SELECT project_id, COUNT(*) as count,
             COALESCE(SUM(length(project_id)+length(title)+length(content)+length(summary)),0) as raw_bytes,
             COALESCE(SUM(length(content_zlib)),0) as compressed_bytes
      FROM memories GROUP BY project_id ORDER BY raw_bytes DESC
    `).all();
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              memoryCount: total.count,
              rawBytes: raw.bytes,
              compressedBytes: compressed.bytes,
              compressionRatio: raw.bytes ? (compressed.bytes / raw.bytes).toFixed(3) : 0,
              dbPath: DB_PATH,
              clumpThresholdTokens: CLUMP_THRESHOLD,
              byProject,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'get_project_index') {
    const { projectId, includeSealed = true } = args;
    const activeClumpRow = activeClump(projectId);
    const activeMemories = activeClumpRow
      ? db.prepare(`
          SELECT id, title, summary, clump_id, updated_at
          FROM memories WHERE project_id = ? AND clump_id = ?
          ORDER BY updated_at DESC
        `).all(projectId, activeClumpRow.id)
      : [];

    const clumps = db.prepare(
      'SELECT id, started_at, ended_at, summary, token_estimate FROM clumps WHERE project_id = ? ORDER BY started_at DESC'
    ).all(projectId);

    const sealedSummaries = includeSealed
      ? clumps
          .filter(c => c.ended_at && c.id !== (activeClumpRow ? activeClumpRow.id : null))
          .map(c => ({
            clumpId: c.id,
            startedAt: c.started_at,
            endedAt: c.ended_at,
            summary: c.summary,
            tokenEstimate: c.token_estimate,
            memoryCount: db.prepare('SELECT COUNT(*) as n FROM memories WHERE clump_id = ?').get(c.id).n,
          }))
      : [];

    const activeClumpObj = activeClumpRow
      ? {
          clumpId: activeClumpRow.id,
          startedAt: activeClumpRow.started_at,
          tokenEstimate: totalClumpTokens(activeClumpRow.id),
          memoryCount: activeMemories.length,
          memories: activeMemories,
        }
      : null;

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              projectId,
              activeClump: activeClumpObj,
              sealedClumps: sealedSummaries,
              totalMemories: activeMemories.length + sealedSummaries.reduce((s, c) => s + c.memoryCount, 0),
              totalClumps: clumps.length,
              note: 'This index contains summaries only. Call get_memory(id) for verbatim content.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'get_clump') {
    const { clumpId } = args;
    const clump = db.prepare('SELECT * FROM clumps WHERE id = ?').get(clumpId);
    if (!clump) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `Clump not found: ${clumpId}` }) }],
      };
    }
    const memories = db.prepare(
      'SELECT id, title, content, summary, clump_id, created_at, updated_at FROM memories WHERE clump_id = ? ORDER BY created_at ASC'
    ).all(clumpId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              clump,
              memoryCount: memories.length,
              memories,
              note: 'Full verbatim content of every memory in this clump.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'list_clumps') {
    const { projectId } = args;
    const rows = db.prepare(
      'SELECT id, started_at, ended_at, summary, token_estimate FROM clumps WHERE project_id = ? ORDER BY started_at DESC'
    ).all(projectId);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              projectId,
              clumps: rows.map(r => ({
                ...r,
                memoryCount: db.prepare('SELECT COUNT(*) as n FROM memories WHERE clump_id = ?').get(r.id).n,
                isActive: !r.ended_at,
              })),
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  if (name === 'seal_clump') {
    const { projectId, summary = '' } = args;
    const result = sealClump(projectId, summary);
    if (!result.sealed) {
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: `No active clump for project: ${projectId}` }) }],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            success: true,
            sealedClumpId: result.sealed,
            newActiveClumpId: result.started,
            projectId,
          }),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
