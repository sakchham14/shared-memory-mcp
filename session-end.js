#!/usr/bin/env node
/**
 * Stop / SessionEnd hook — autosaves the current turn to shared memory.
 *
 * Pairs the latest staged user prompt (from prompt-stage.js, fired on
 * UserPromptSubmit) with the assistant's last message (from this hook's
 * payload) and writes one memory per turn. Direct SQLite write — no MCP
 * server or model call needed, so it costs zero tokens.
 *
 * Skips when stop_hook_active is true (a stop hook is asking for another
 * turn) to avoid saving intermediate loop iterations.
 *
 * Env:
 *   MEM_PROJECT_ID   project/conversation id (default: derived from cwd)
 *   MEM_DB_PATH      path to the SQLite DB
 *   MEM_AUTOSAVE     set to "0" to disable autosave for this session
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'node:sqlite';
import { deflateSync } from 'node:zlib';
import { redact } from './redact.js';

const DB_PATH = process.env.MEM_DB_PATH || `${homedir()}/code/.claude/mem/data/mem.db`;
const MEM_DIR = process.env.MEM_DIR || `${homedir()}/code/.claude/mem`;
const STAGING_DIR = `${MEM_DIR}/projects`;
const PROJECT_ID = process.env.MEM_PROJECT_ID || deriveProjectId(process.cwd());

if (process.env.MEM_AUTOSAVE === '0') process.exit(0);

function deriveProjectId(cwd) {
  return basename(resolve(cwd)) || 'default';
}

// --- Read hook payload from stdin ---
let payload = {};
try {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  payload = JSON.parse(chunks.join('') || '{}');
} catch {
  process.exit(0);
}

// Never autosave during a stop-hook continuation loop.
if (payload.stop_hook_active) process.exit(0);

const assistantMsg = (payload.last_assistant_message || '').trim();
const stagingFile = `${STAGING_DIR}/${PROJECT_ID}.jsonl`;

// Nothing to save if there's no assistant message and no staged prompts.
if (!assistantMsg && !existsSync(stagingFile)) process.exit(0);

// --- Open DB (same schema as server.js) ---
mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');
db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL,
    content TEXT NOT NULL, content_zlib BLOB, summary TEXT,
    memory_type TEXT DEFAULT 'turn',
    pinned INTEGER DEFAULT 0,
    redaction TEXT,
    clump_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clumps (
    id TEXT PRIMARY KEY, project_id TEXT NOT NULL, started_at TEXT NOT NULL,
    ended_at TEXT, summary TEXT, token_estimate INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS change_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL,
    project_id TEXT NOT NULL, action TEXT NOT NULL, summary TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );
`);
for (const col of ['content_zlib BLOB', 'clump_id TEXT']) {
  try { db.exec(`ALTER TABLE memories ADD COLUMN ${col}`); } catch (e) { if (!/duplicate column/i.test(e.message)) throw e; }
}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_memories_clump ON memories(clump_id)'); } catch {}

// --- Clump management (mirrors server.js) ---
function activeClump(pid) {
  return db.prepare('SELECT * FROM clumps WHERE project_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1').get(pid);
}
function ensureClump(pid) {
  let c = activeClump(pid);
  if (c) return c;
  const id = `clump_${pid}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO clumps (id, project_id, started_at) VALUES (?, ?, ?)').run(id, pid, new Date().toISOString());
  return db.prepare('SELECT * FROM clumps WHERE id = ?').get(id);
}
function totalClumpTokens(clumpId) {
  const row = db.prepare("SELECT COALESCE(SUM(length(title)+length(content)+length(summary)),0) as bytes FROM memories WHERE clump_id = ?").get(clumpId);
  return Math.ceil((row.bytes || 0) / 4);
}
const CLUMP_THRESHOLD = Number(process.env.MEM_CLUMP_THRESHOLD_TOKENS || 8000);

// Load staged prompts for THIS project.
let staged = [];
try {
  staged = readFileSync(stagingFile, 'utf8').split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(s => s && s.projectId === PROJECT_ID);
} catch {}

const latestPrompt = staged.length ? staged[staged.length - 1].prompt : '(no staged prompt)';

// --- Build the memory ---
const title = `Turn ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`;
const rawContent = `User: ${latestPrompt}\n\nAssistant: ${assistantMsg}`;
// Redact secrets: real credential values never enter the DB. They are replaced
// with ${VAR_NAME} (for env vars) or [REDACTED:n] (for generic patterns). The
// mapping is recorded in the change_log so a future reader knows how to
// restore them from the process environment.
const { text: content, secrets } = redact(rawContent);
const summary = ((assistantMsg.slice(0, 120) || latestPrompt.slice(0, 120)).replace(/\n/g, ' '));

// --- Save (with clump rollover) ---
let clump = ensureClump(PROJECT_ID);
const before = totalClumpTokens(clump.id);
const newTokens = Math.ceil(content.length / 4);
let sealed = null;
if (before + newTokens > CLUMP_THRESHOLD) {
  const active = clump;
  db.prepare('UPDATE clumps SET ended_at = ?, summary = ?, token_estimate = ? WHERE id = ?')
    .run(new Date().toISOString(), `Auto-sealed after ${before + newTokens} est tokens`, totalClumpTokens(active.id), active.id);
  const newId = `clump_${PROJECT_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  db.prepare('INSERT INTO clumps (id, project_id, started_at) VALUES (?, ?, ?)').run(newId, PROJECT_ID, new Date().toISOString());
  clump = db.prepare('SELECT * FROM clumps WHERE id = ?').get(newId);
  sealed = active.id;
}

const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
const now = new Date().toISOString();
db.prepare(`
  INSERT INTO memories (id, project_id, title, content, content_zlib, summary, memory_type, pinned, redaction, clump_id, created_at, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(id, PROJECT_ID, title, content, deflateSync(Buffer.from(content, 'utf8')), summary, 'turn', 0, secrets.length ? JSON.stringify(secrets) : null, clump.id, now, now);
db.prepare(`
  INSERT INTO change_log (memory_id, project_id, action, summary, timestamp)
  VALUES (?, ?, 'CREATE', ?, ?)
`).run(id, PROJECT_ID, secrets.length ? `Saved with ${secrets.length} redaction(s)` : summary, now);

// --- Structured fact auto-capture (heuristic, zero tokens) ---
// Extract decision/note/todo/constraint lines from the assistant message and
// save each as a separate 'fact' memory so they are retrievable later.
const factPatterns = [
  /\b(?:Decision|Decided|Conclusion|Result|Outcome|Constraint|Rule|Note|TODO|Action item|Next step)s?\s*[:\-]\s*(.+)/gi,
];
const facts = new Set();
for (const re of factPatterns) {
  let m;
  while ((m = re.exec(assistantMsg)) !== null) {
    const fact = m[1].trim().slice(0, 500);
    if (fact.length > 10) facts.add(fact);
  }
}

function saveFact(text) {
  const fid = `fact_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const fnow = new Date().toISOString();
  let fclump = ensureClump(PROJECT_ID);
  const fbefore = totalClumpTokens(fclump.id);
  const fnew = Math.ceil(text.length / 4);
  if (fbefore + fnew > CLUMP_THRESHOLD) {
    const active = fclump;
    db.prepare('UPDATE clumps SET ended_at = ?, summary = ?, token_estimate = ? WHERE id = ?')
      .run(new Date().toISOString(), `Auto-sealed after ${fbefore + fnew} est tokens`, totalClumpTokens(active.id), active.id);
    const newId = `clump_${PROJECT_ID}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    db.prepare('INSERT INTO clumps (id, project_id, started_at) VALUES (?, ?, ?)').run(newId, PROJECT_ID, new Date().toISOString());
    fclump = db.prepare('SELECT * FROM clumps WHERE id = ?').get(newId);
  }
  const { text: fcontent, secrets: fsecrets } = redact(text);
  db.prepare(`
    INSERT INTO memories (id, project_id, title, content, content_zlib, summary, memory_type, pinned, redaction, clump_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fid, PROJECT_ID, `Fact: ${text.slice(0, 60)}`, fcontent, deflateSync(Buffer.from(fcontent, 'utf8')), text.slice(0, 120), 'fact', 0, fsecrets.length ? JSON.stringify(fsecrets) : null, fclump.id, fnow, fnow);
  db.prepare(`INSERT INTO change_log (memory_id, project_id, action, summary, timestamp) VALUES (?, ?, 'CREATE', ?, ?)`).run(fid, PROJECT_ID, `Auto-captured fact`, fnow);
  return fid;
}

const capturedFactIds = [];
for (const f of facts) capturedFactIds.push(saveFact(f));

// --- Project briefing memory (auto-maintained, always available) ---
// Maintain a single 'briefing' memory per project summarizing recent activity.
const briefingTitle = 'Project briefing';
const existingBriefing = db.prepare("SELECT id FROM memories WHERE project_id = ? AND memory_type = 'reference' AND title = ?").get(PROJECT_ID, briefingTitle);
const briefingContent = `Auto-maintained briefing for project "${PROJECT_ID}".\nLast turn: ${new Date().toISOString()}\nRecent facts captured: ${capturedFactIds.length}\nLast assistant summary: ${assistantMsg.slice(0, 300)}`;
const bnow = new Date().toISOString();
if (existingBriefing) {
  db.prepare(`UPDATE memories SET content = ?, content_zlib = ?, summary = ?, updated_at = ? WHERE id = ?`)
    .run(briefingContent, deflateSync(Buffer.from(briefingContent, 'utf8')), `Briefing updated ${bnow}`, bnow, existingBriefing.id);
} else {
  const bid = `briefing_${PROJECT_ID}`;
  let bclump = ensureClump(PROJECT_ID);
  db.prepare(`
    INSERT INTO memories (id, project_id, title, content, content_zlib, summary, memory_type, pinned, redaction, clump_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(bid, PROJECT_ID, briefingTitle, briefingContent, deflateSync(Buffer.from(briefingContent, 'utf8')), `Briefing updated ${bnow}`, 'reference', 0, null, bclump.id, bnow, bnow);
  db.prepare(`INSERT INTO change_log (memory_id, project_id, action, summary, timestamp) VALUES (?, ?, 'CREATE', ?, ?)`).run(bid, PROJECT_ID, 'Briefing created', bnow);
}
// --- end auto-capture ---
try {
  if (staged.length <= 1) {
    unlinkSync(stagingFile);
  } else {
    writeFileSync(stagingFile, staged.slice(0, -1).map(s => JSON.stringify(s)).join('\n') + '\n');
  }
} catch {}

process.stdout.write(`[mem] autosaved turn for "${PROJECT_ID}" (memory ${id}${sealed ? `, sealed clump ${sealed}` : ''})\n`);