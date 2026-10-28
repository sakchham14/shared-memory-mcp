import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Database } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deflateSync, inflateSync } from 'node:zlib';

const DB_PATH = process.env.MEM_DB_PATH || '/Users/mochi/.claude/mem/db/mem.db';
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
`);

// Add content_zlib column to databases created before compression was introduced.
try {
  db.exec('ALTER TABLE memories ADD COLUMN content_zlib BLOB');
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
    } else {
      db.prepare(`
        INSERT INTO memories (id, project_id, title, content, content_zlib, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, projectId, title, content, deflateSync(Buffer.from(content, 'utf8')), summary, now, now);

      db.prepare(`
        INSERT INTO change_log (memory_id, project_id, action, summary, timestamp)
        VALUES (?, ?, 'CREATE', ?, ?)
      `).run(id, projectId, summary || `Created: ${title}`, now);
    }

    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({ success: true, memoryId: id, projectId, action: existing ? 'updated' : 'created' }),
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
              byProject,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
