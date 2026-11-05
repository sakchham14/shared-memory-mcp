#!/usr/bin/env node
/**
 * doctor.js — verify shared-memory-mcp setup and auto-repair where safe.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'node:sqlite';

const DB_PATH = process.env.MEM_DB_PATH || `${homedir()}/code/.claude/mem/data/mem.db`;
const MEM_DIR = process.env.MEM_DIR || `${homedir()}/.claude/mem`;

const checks = [];
function ok(name, detail) { checks.push({ name, status: 'OK', detail }); }
function warn(name, detail) { checks.push({ name, status: 'WARN', detail }); }
function fail(name, detail) { checks.push({ name, status: 'FAIL', detail }); }

// Node version
const nodeVer = process.version;
if (Number(nodeVer.slice(1).split('.')[0]) >= 22) ok('node', nodeVer);
else fail('node', `${nodeVer} (need >=22)`);

// DB file
if (existsSync(DB_PATH)) {
  try {
    const db = new Database(DB_PATH, { readonly: true });
    const n = db.prepare('SELECT COUNT(*) as c FROM memories').get().c;
    ok('db', `${DB_PATH} (${n} memories)`);
  } catch (e) { fail('db', e.message); }
} else {
  try { mkdirSync(join(DB_PATH, '..'), { recursive: true }); warn('db', 'missing — will be created on first save'); }
  catch (e) { fail('db', e.message); }
}

// Required files
for (const f of ['server.js','session-start.js','session-end.js','recall.js','redact.js','embed.js','skip-large-files.js']) {
  if (existsSync(join(MEM_DIR, f))) ok('file:' + f, 'present');
  else fail('file:' + f, 'MISSING');
}

// Hooks config
const settingsPath = join(homedir(), '.claude', 'settings.json');
if (existsSync(settingsPath)) ok('settings', settingsPath);
else warn('settings', 'no ~/.claude/settings.json');

console.log(JSON.stringify({ checks, summary: { ok: checks.filter(c=>c.status==='OK').length, warn: checks.filter(c=>c.status==='WARN').length, fail: checks.filter(c=>c.status==='FAIL').length } }, null, 2));
if (checks.some(c => c.status === 'FAIL')) process.exit(1);
