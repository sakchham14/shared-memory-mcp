#!/usr/bin/env node
/**
 * UserPromptSubmit hook — stages each user prompt for later autosave.
 *
 * Appends a compact JSON line to ~/.claude/mem/staging/<projectId>.jsonl.
 * session-end.js consumes this file and saves it as a memory at session end.
 *
 * Bounded: caps the staging file at MEM_STAGING_MAX entries (default 25) so a
 * long session never grows it unboundedly.
 *
 * Env:
 *   MEM_PROJECT_ID   project/conversation id (default: derived from cwd)
 *   MEM_STAGING_MAX  max staged prompts per session (default: 25)
 */
import { readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, basename, resolve } from 'node:path';

const MEM_DIR = process.env.MEM_DIR || `${homedir()}/.claude/mem`;
const STAGING_DIR = `${MEM_DIR}/staging`;
const PROJECT_ID = process.env.MEM_PROJECT_ID || deriveProjectId(process.cwd());
const STAGING_MAX = Number(process.env.MEM_STAGING_MAX || 25);
const STAGING_FILE = `${STAGING_DIR}/${PROJECT_ID}.jsonl`;

function deriveProjectId(cwd) {
  return basename(resolve(cwd)) || 'default';
}

mkdirSync(STAGING_DIR, { recursive: true });

// Read the user prompt from stdin (Claude Code passes the hook payload as JSON).
let prompt = '';
try {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('').trim();
  try {
    const payload = JSON.parse(raw);
    prompt = (payload.prompt || raw).trim();
  } catch {
    prompt = raw;
  }
} catch {
  // Non-interactive — nothing to stage.
  process.exit(0);
}

if (!prompt) process.exit(0);

const line = JSON.stringify({
  ts: new Date().toISOString(),
  projectId: PROJECT_ID,
  prompt: prompt.slice(0, 2000), // cap per-prompt size
}) + '\n';

// Append, then trim to the max.
try {
  appendFileSync(STAGING_FILE, line);
} catch {
  process.exit(0);
}

try {
  const existing = readFileSync(STAGING_FILE, 'utf8').split('\n').filter(Boolean);
  if (existing.length > STAGING_MAX) {
    writeFileSync(STAGING_FILE, existing.slice(-STAGING_MAX).join('\n') + '\n');
  }
} catch {
  // Best-effort trimming; never fail the hook.
}

process.stdout.write(`[mem] staged prompt for project "${PROJECT_ID}"\n`);