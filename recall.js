#!/usr/bin/env node
/**
 * UserPromptSubmit hook — keyword-based memory recall.
 *
 * On every prompt, extracts keywords from the user's message and runs a
 * targeted search against the shared memory DB. Only matching memories are
 * injected (never the full index), so a long project costs a few hundred
 * tokens at most — the "few 100 paths, find the full chat" pattern.
 *
 * Output goes to stdout, which Claude Code appends to context before the
 * model sees the prompt.
 *
 * Env:
 *   MEM_PROJECT_ID   project/conversation id (default: derived from cwd)
 *   MEM_DB_PATH      path to the SQLite DB
 *   MEM_RECALL_MAX   max memories to inject (default: 8)
 *   MEM_RECALL_CHARS max chars per memory in the recall block (default: 400)
 *   MEM_RECALL_MIN_LEN min word length to treat as a keyword (default: 3)
 */
import { existsSync } from 'node:fs';
import { dirname, basename, resolve } from 'node:path';
import { homedir } from 'node:os';
import { Database } from 'node:sqlite';

const DB_PATH = process.env.MEM_DB_PATH || `${homedir()}/.claude/mem/db/mem.db`;
const PROJECT_ID = process.env.MEM_PROJECT_ID || deriveProjectId(process.cwd());
const RECALL_MAX = Number(process.env.MEM_RECALL_MAX || 8);
const RECALL_CHARS = Number(process.env.MEM_RECALL_CHARS || 400);
const MIN_LEN = Number(process.env.MEM_RECALL_MIN_LEN || 3);

function deriveProjectId(cwd) {
  return basename(resolve(cwd)) || 'default';
}

// --- Read the prompt from stdin (Claude Code passes the hook payload as JSON) ---
let prompt = '';
try {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const payload = JSON.parse(chunks.join('') || '{}');
  prompt = (payload.prompt || '').trim();
} catch {
  process.exit(0);
}
if (!prompt) process.exit(0);

// --- Open DB (read-only, no schema changes) ---
if (!existsSync(DB_PATH)) process.exit(0);
const db = new Database(DB_PATH, { readonly: true });

// --- Extract keywords: lowercase, strip punctuation, drop stopwords ---
const STOPWORDS = new Set([
  'the','a','an','is','are','was','were','be','been','being','have','has','had',
  'do','does','did','will','would','could','should','may','might','can','shall',
  'i','you','he','she','it','we','they','them','their','there','here','this','that',
  'these','those','what','which','who','whom','when','where','why','how','all',
  'each','few','more','most','other','some','such','no','nor','not','only','own',
  'same','so','than','too','very','just','and','but','if','or','as','at','by','for',
  'with','about','against','between','into','through','during','before','after',
  'above','below','to','from','up','down','in','out','on','off','over','under',
  'again','further','then','once','here','there','any','both','each','few','more',
  'most','other','some','such','only','own','same','so','than','also','its','it\'s',
  'my','your','his','her','our','me','him','us','am','im','youre','dont','doesnt',
]);

const keywords = [...new Set(
  prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)
    .filter(w => w.length >= MIN_LEN && !STOPWORDS.has(w))
)].slice(0, 12); // cap keyword count

if (keywords.length === 0) {
  process.stdout.write(`[mem] no keywords to recall from prompt\n`);
  process.exit(0);
}

// --- Search: match memories whose title OR content OR summary contains any keyword ---
// Ordered by relevance (number of keyword hits) then recency. Bounded.
//
// NOTE: patterns are inlined into the SQL string rather than bound as ? params.
// node:sqlite silently fails on bound LIKE params (returns empty results) —
// verified bug, same class as the FTS5 issue. Inline literals work correctly.
function likePattern(kw) {
  return '%' + kw.replace(/[%_]/g, '\\$&') + '%';
}
const whereClause = keywords.map(kw =>
  `(m.title LIKE '${likePattern(kw)}' ESCAPE '\\' OR m.content LIKE '${likePattern(kw)}' ESCAPE '\\' OR m.summary LIKE '${likePattern(kw)}' ESCAPE '\\')`
).join(' OR ');
const hitCases = keywords.map(kw =>
  `CASE WHEN m.title LIKE '${likePattern(kw)}' ESCAPE '\\' OR m.content LIKE '${likePattern(kw)}' ESCAPE '\\' OR m.summary LIKE '${likePattern(kw)}' ESCAPE '\\' THEN 1 ELSE 0 END`
).join(' + ');

const rows = db.prepare(`
  SELECT m.id, m.project_id, m.title, m.summary, m.content, m.updated_at,
         (${hitCases}) as hits
  FROM memories m
  WHERE m.project_id = ? AND (${whereClause})
  ORDER BY hits DESC, m.updated_at DESC
  LIMIT ?
`).all(PROJECT_ID, RECALL_MAX);

if (rows.length === 0) {
  process.stdout.write(`[mem] no memories matched keywords: ${keywords.join(', ')}\n`);
  process.exit(0);
}

// --- Build the recall block (compact, never full content unless it fits) ---
const lines = [];
lines.push(`## Memory recall — matched ${rows.length} of ${keywords.length} keywords [${keywords.join(', ')}]`);
lines.push('(relevant memories from shared memory; quote ids for verbatim fetch)');
for (const r of rows) {
  const summary = r.summary ? r.summary : r.content.slice(0, RECALL_CHARS).replace(/\n/g, ' ');
  const snippet = summary.length > RECALL_CHARS ? summary.slice(0, RECALL_CHARS) + '…' : summary;
  lines.push(`- ${r.title} — ${snippet} [id:${r.id}]`);
}
lines.push('(call get_memory(id) for the full verbatim text of any entry above)');

process.stdout.write(lines.join('\n') + '\n');