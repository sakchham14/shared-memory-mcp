import { Database } from 'node:sqlite';
import { deflateSync, inflateSync } from 'node:zlib';
import { redact } from '/Users/mochi/.claude/mem/redact.js';
import { embed, cosine } from '/Users/mochi/.claude/mem/embed.js';

const DB = process.env.MEM_DB_PATH || `${process.env.HOME}/code/.claude/mem/data/mem.db`;
const db = new Database(DB);
const pid = 'smm-test-' + Date.now();
const now = new Date().toISOString();
const content = 'The quick brown fox jumps over the lazy dog. Decision: use hybrid search. TODO: ship it.';
const { text, secrets } = redact(content);
const id = 'mem_test_' + Date.now();
db.prepare(`INSERT INTO memories (id, project_id, title, content, content_zlib, summary, memory_type, pinned, redaction, clump_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, pid, 'Test memory', text, deflateSync(Buffer.from(text,'utf8')), 'test summary', 'fact', 0, secrets.length?JSON.stringify(secrets):null, null, now, now);
console.log('saved id:', id);

const row = db.prepare('SELECT * FROM memories WHERE id=?').get(id);
const got = row.content_zlib ? inflateSync(Buffer.from(row.content_zlib)).toString('utf8') : row.content;
console.log('retrieved:', got === text ? 'MATCH' : 'MISMATCH');
console.log('raw bytes:', Buffer.byteLength(text));
console.log('compressed bytes:', row.content_zlib.length);
console.log('ratio:', (row.content_zlib.length / Buffer.byteLength(text)).toFixed(3));

const qv = await embed('hybrid search');
const mv = await embed(text);
console.log('cosine(query,memory):', cosine(qv, mv).toFixed(3));

// cleanup
db.prepare('DELETE FROM memories WHERE id=?').run(id);
db.prepare('DELETE FROM clumps WHERE project_id=?').run(pid);
console.log('cleanup done');
