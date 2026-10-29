#!/usr/bin/env node
/**
 * SessionStart hook for the shared-memory MCP server.
 *
 * Runs at the start of every Claude Code session and injects a COMPACT project
 * index into context — summaries and metadata only, never full memory content.
 * Full verbatim content is fetched on demand via get_memory(id).
 *
 * Output is appended to the session context automatically.
 *
 * Env:
 *   MEM_PROJECT_ID   project/conversation id to load (default: derived from cwd)
 *   MEM_DB_PATH      path to the SQLite DB (default: ~/.claude/mem/db/mem.db)
 *   MEM_INDEX_LIMIT  max memories to include in the active clump (default: 15)
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, resolve } from 'node:path';
import { Database } from 'node:sqlite';

const DB_PATH = process.env.MEM_DB_PATH || `${homedir()}/.claude/mem/db/mem.db`;
const PROJECT_ID = process.env.MEM_PROJECT_ID || deriveProjectId(process.cwd());
const INDEX_LIMIT = Number(process.env.MEM_INDEX_LIMIT || 15);

function deriveProjectId(cwd) {
  // Use the immediate folder name as a stable project id.
  return basename(resolve(cwd)) || 'default';
}

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch (e) {
  process.stderr.write(`[shared-memory] DB unavailable: ${e.message}\n`);
  process.exit(0);
}

const out = [];
out.push(`## Shared memory index — project "${PROJECT_ID}"`);
out.push('(summaries only; call get_memory(id) for verbatim content)');

// --- Active clump (current chat batch) ---
const activeClump = db.prepare(
  'SELECT id, started_at FROM clumps WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
).get(PROJECT_ID);

if (activeClump) {
  const memories = db.prepare(
    `SELECT id, title, summary, updated_at
     FROM memories WHERE project_id = ? AND clump_id = ?
     ORDER BY updated_at DESC LIMIT ?`
  ).all(PROJECT_ID, activeClump.id, INDEX_LIMIT);
  const count = db.prepare(
    'SELECT COUNT(*) as n FROM memories WHERE project_id = ? AND clump_id = ?'
  ).get(PROJECT_ID, activeClump.id).n;

  out.push(`\n### Active clump: ${activeClump.id} (${count} memory${count === 1 ? '' : 's'})`);
  if (memories.length === 0) {
    out.push('(no memories yet — this is a fresh chat batch)');
  } else {
    for (const m of memories) {
      const line = m.summary ? `${m.title} — ${m.summary}` : m.title;
      out.push(`- ${line}  [id:${m.id}]`);
    }
    if (count > memories.length) {
      out.push(`- … ${count - memories.length} more (use get_project_index for the full list)`);
    }
  }
} else {
  out.push('\n(no active clump — run save_memory to start one)');
}

// --- Sealed clumps (past chat batches) ---
const sealed = db.prepare(
  `SELECT c.id, c.summary, c.token_estimate, c.ended_at,
          (SELECT COUNT(*) FROM memories m WHERE m.clump_id = c.id) as n
   FROM clumps c
   WHERE c.project_id = ? AND c.ended_at IS NOT NULL
   ORDER BY c.started_at DESC LIMIT 5`
).all(PROJECT_ID);

if (sealed.length) {
  out.push(`\n### Sealed clumps (past batches):`);
  for (const c of sealed) {
    const label = c.summary || `clump ${c.id}`;
    out.push(`- ${label} (${c.n} memory${c.n === 1 ? '' : 's'}, ~${c.token_estimate} tokens) [clump:${c.id}]`);
  }
  out.push('(call get_clump(clumpId) to reconstruct any sealed batch verbatim)');
}

// --- Other projects with memory (cross-project awareness) ---
const others = db.prepare(
  'SELECT project_id, COUNT(*) as n FROM memories WHERE project_id != ? GROUP BY project_id ORDER BY n DESC LIMIT 5'
).all(PROJECT_ID);
if (others.length) {
  out.push(`\n### Other projects in memory:`);
  for (const o of others) out.push(`- ${o.project_id} (${o.n} memory${o.n === 1 ? '' : 's'})`);
}

out.push(`\n_This index is auto-generated. To add a memory: save_memory("${PROJECT_ID}", "title", "content", "summary"). To seal this batch and start a new one: seal_clump("${PROJECT_ID}")._`);

process.stdout.write(out.join('\n') + '\n');