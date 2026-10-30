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

// --- Recall quality gates (added 2026-10-30 to stop hallucination/looping) ---
// Without these, ANY keyword match injects a memory — including stale,
// off-topic rows from other conversations. The model then re-answers its own
// past text and loops. Verified: the unpatched hook returned 8 memories for a
// generic prompt, most unrelated to the actual request.
//
//   MIN_HIT_SHARE  — fraction of keywords that must hit before we inject at all.
//                    0.5 = at least half the prompt's content words matched.
//   MAX_AGE_DAYS   — hard cutoff; anything older is too stale to trust.
//   MAX_HITS       — max keyword hits a row can have before it is suspicious
//                    (a row matching ALL keywords is usually a generic
//                    "memory about memory" meta-row, not an answer).
const MIN_HIT_SHARE = Number(process.env.MEM_RECALL_MIN_HIT_SHARE || 0.5);
const MAX_AGE_DAYS = Number(process.env.MEM_RECALL_MAX_AGE_DAYS || 90);
// Reject rows that match ALL keywords — that signature belongs to generic
// "memory about memory" meta-rows, not to an answer. (A prior attempt used a
// fixed MAX_HITS ceiling, which wrongly rejected genuinely on-topic rows.)
const MATCH_ALL_RATIO = Number(process.env.MEM_RECALL_MATCH_ALL_RATIO || 0.9);
// Reject rows whose body is predominantly non-Latin-script (Chinese, etc.).
// The embedding model is English-only, so these produce garbage vectors and
// pollute recall. Measured as a share of alphabetic characters.
const MAX_NON_LATIN_SHARE = Number(process.env.MEM_RECALL_MAX_NON_LATIN_SHARE || 0.3);

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

// Fetch candidates generously, then apply the quality gates in JS. The SQL
// ORDER BY keeps the most-recently-matching rows on top so the LIMIT doesn't
// discard everything before the age filter runs.
const candidateCount = RECALL_MAX * 4;
const cutoffDate = new Date();
cutoffDate.setDate(cutoffDate.getDate() - MAX_AGE_DAYS);
const cutoffISO = cutoffDate.toISOString();

// Rows whose user input was empty ("no staged prompt") hold real assistant
// knowledge but have no query anchor, so they dominate recall. Tag them and
// down-rank rather than drop them.
const emptyPromptCase =
  "CASE WHEN m.content LIKE 'User: (no staged prompt)%' THEN 1 ELSE 0 END";

const rows = db.prepare(`
  SELECT m.id, m.project_id, m.title, m.summary, m.content, m.updated_at,
         (${hitCases}) as hits,
         (${emptyPromptCase}) as empty_prompt
  FROM memories m
  WHERE m.project_id = ? AND (${whereClause})
  ORDER BY
    hits DESC,
    empty_prompt ASC,
    m.updated_at DESC
  LIMIT ?
`).all(PROJECT_ID, candidateCount);

// --- Quality gates (post-filter) ---
const totalKeywords = keywords.length;
function latinShare(body) {
  // Share of alphabetic characters that are in Latin script (a-z, A-Z).
  // CJK ideographs and other scripts count against this share.
  let letters = 0, latin = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body.charCodeAt(i);
    const isLetter = (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
    if (isLetter) { letters++; latin++; }
    else if (c >= 0x4e00 && c <= 0x9fff) { letters++; } // CJK ideographs
    else if (c >= 0x3040 && c <= 0x30ff) { letters++; } // kana
  }
  return letters ? latin / letters : 1;
}

const filtered = rows.filter(r => {
  if (r.hits <= 0) return false;
  if (r.hits / totalKeywords >= MATCH_ALL_RATIO) return false; // generic/meta row
  if (r.updated_at < cutoffISO) return false;          // stale
  if (r.hits / totalKeywords < MIN_HIT_SHARE) return false; // not on topic
  // Reject rows that are raw hook envelopes or pasted blobs, not user intent.
  const body = (r.content || '').slice(0, 600);
  if (/^\s*\{"session_id"/.test(body)) return false;   // raw JSON payload
  if (/<pasted_content/.test(body)) return false;      // pasted transcript
  if (/^\s*User:\s*\(no staged prompt\)/.test(body)) return false; // dead row
  if (latinShare(body) < 1 - MAX_NON_LATIN_SHARE) return false; // non-English
  return true;
});

if (filtered.length === 0) {
  process.stdout.write(
    `[mem] ${rows.length} raw match(es) but none passed recall gates ` +
    `(hit-share≥${MIN_HIT_SHARE}, age≤${MAX_AGE_DAYS}d, non-match-all, ` +
    `≥${(1 - MAX_NON_LATIN_SHARE).toFixed(2)} Latin); ` +
    `keywords: ${keywords.join(', ')}\n`
  );
  process.exit(0);
}

// --- Build the recall block (compact, never full content unless it fits) ---
const lines = [];
lines.push(
  `## Memory recall — ${filtered.length} relevant of ${rows.length} raw match(es), ` +
  `${keywords.length} keywords [${keywords.join(', ')}]`
);
lines.push('(relevant memories from shared memory; quote ids for verbatim fetch)');
for (const r of filtered.slice(0, RECALL_MAX)) {
  const summary = r.summary ? r.summary : r.content.slice(0, RECALL_CHARS).replace(/\n/g, ' ');
  const snippet = summary.length > RECALL_CHARS ? summary.slice(0, RECALL_CHARS) + '…' : summary;
  lines.push(`- ${r.title} — ${snippet} [id:${r.id}]`);
}
lines.push('(call get_memory(id) for the full verbatim text of any entry above)');

process.stdout.write(lines.join('\n') + '\n');