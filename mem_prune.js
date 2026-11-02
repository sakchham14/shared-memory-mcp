/**
 * mem_prune.js — remove rows that can never be useful for recall.
 *
 * Usage: node mem_prune.js <db_path> [projectId]
 *
 * Removes, per project (or globally when projectId is omitted):
 *   1. Raw hook envelopes: content starts with {"session_id" — the old
 *      prompt-stage.js stored the whole JSON payload, not the prompt text.
 *   2. Pasted transcripts: content contains <pasted_content> — bulk pastes,
 *      not user intent.
 *   3. Dead rows: content starts with "User: (no staged prompt)" — sessions
 *      where the staging file was empty, so nothing real was said.
 *   4. Non-Latin-script rows: body is predominantly CJK/kana. The embedding
 *      model (all-MiniLM-L6-v2) is English-only, so these produce garbage
 *      vectors and pollute recall.
 *
 * A --dry-run flag prints what would be removed without writing.
 */
import { Database } from 'node:sqlite';

const dbPath = process.argv[2];
const projectId = process.argv[3] || null;
const dryRun = process.argv.includes('--dry-run');
if (!dbPath) {
  console.error('usage: node mem_prune.js <db_path> [projectId] [--dry-run]');
  process.exit(2);
}

const db = new Database(dbPath);

function latinShare(body) {
  let letters = 0, latin = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) { letters++; latin++; }
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3040 && c <= 0x30ff)) letters++;
  }
  return letters ? latin / letters : 1;
}

function classify(content) {
  const body = (content || '').slice(0, 600);
  if (/^\s*\{"session_id"/.test(body)) return 'raw-json-payload';
  if (/<pasted_content/.test(body)) return 'pasted-transcript';
  if (latinShare(body) < 0.7) return 'non-latin-script';
  // "no staged prompt" rows are NOT removed: they hold real assistant
  // knowledge (task lists, analysis, decisions). They are only down-weighted
  // in recall, because they lack a user-query anchor and so dominate results.
  return null;
}

const where = projectId
  ? 'WHERE project_id = ?'
  : '';
const rows = db.prepare(`SELECT id, project_id, content FROM memories ${where}`).all(projectId || null);

const toRemove = [];
for (const r of rows) {
  const kind = classify(r.content);
  if (kind) toRemove.push({ ...r, kind });
}

console.log(`scanned ${rows.length} rows, ${toRemove.length} to remove`);
for (const r of toRemove) {
  console.log(`  [${r.kind}] ${r.id}  project=${r.project_id}`);
}

if (dryRun || toRemove.length === 0) {
  if (!dryRun) console.log('nothing to remove');
  db.close();
  process.exit(0);
}

const delLog = db.prepare('DELETE FROM change_log WHERE memory_id = ?');
const delMem = db.prepare('DELETE FROM memories WHERE id = ?');
db.exec('BEGIN');
let n = 0;
for (const r of toRemove) {
  delLog.run(r.id);
  if (delMem.run(r.id).changes) n++;
}
db.exec('COMMIT');
const counts = db.prepare(
  'SELECT project_id, COUNT(*) as n FROM memories GROUP BY project_id ORDER BY project_id'
).all();
console.log(`removed ${n} rows; remaining: ${JSON.stringify(counts)}`);
db.close();