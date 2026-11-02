#!/usr/bin/env node
/**
 * PreToolUse hook — block Read of large / secret / binary files.
 *
 * Reads the hook payload from stdin (tool_name, tool_input). For Read calls
 * whose file_path matches a skip pattern or exceeds a size threshold, exits 2
 * with a message telling Claude to use grep / targeted queries instead.
 *
 * Exit 2 blocks the tool call and feeds the message back to Claude.
 * Exit 0 allows it.
 *
 * Env:
 *   SKIP_MAX_BYTES  max bytes a file may be before Read is blocked (default 200000)
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const MAX_BYTES = Number(process.env.SKIP_MAX_BYTES || 200_000);

// Patterns: anything matching is blocked outright (secrets, binaries, env, db).
const SKIP_PATTERNS = [
  /\.env(\.|$)/,
  /\.env\./,
  /(^|\/)secrets?(\/|\.|$)/,
  /(^|\/)credentials(\/|\.|$)/,
  /(^|\/)\.netrc$/,
  /\.pem$/, /\.key$/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.crt$/,
  /(^|\/)id_rsa/, /(^|\/)id_ed25519/, /(^|\/)id_ecdsa/,
  /(^|\/)freellmapi-keys/,
  /\.db$/, /\.sqlite$/, /\.sqlite3$/,
  /(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)\.DS_Store$/,
  /\.png$/, /\.jpe?g$/, /\.gif$/, /\.svg$/, /\.ico$/, /\.webp$/, /\.bmp$/,
  /\.mp[34]$/, /\.wav$/, /\.ogg$/, /\.pdf$/,
  /\.zip$/, /\.tar$/, /\.gz$/, /\.tgz$/, /\.7z$/, /\.rar$/,
  /\.exe$/, /\.dll$/, /\.so$/, /\.dylib$/, /\.a$/, /\.o$/, /\.obj$/, /\.wasm$/,
  /\.min\.(js|css)$/, /\.map$/,
];

function isSkipped(filePath) {
  const base = filePath.split('/').pop() || filePath;
  for (const re of SKIP_PATTERNS) {
    if (re.test(filePath) || re.test(base)) return true;
  }
  return false;
}

async function main() {
  const chunks = [];
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = chunks.join('').trim();
  if (!raw) process.exit(0);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const { tool_name, tool_input } = payload;
  if (tool_name !== 'Read' && tool_name !== 'read') process.exit(0);
  const filePath = tool_input?.file_path || tool_input?.path;
  if (!filePath) process.exit(0);

  if (isSkipped(filePath)) {
    process.stderr.write(
      `[skip-large-files] Blocked Read of "${filePath}" — matches a skip pattern. ` +
      `Use grep / targeted queries instead of reading the whole file.\n`
    );
    process.exit(2);
  }

  let size;
  try {
    if (!existsSync(filePath)) process.exit(0);
    size = statSync(filePath).size;
  } catch {
    process.exit(0);
  }

  if (size > MAX_BYTES) {
    process.stderr.write(
      `[skip-large-files] Blocked Read of "${filePath}" — ${size} bytes exceeds ` +
      `${MAX_BYTES} byte limit. Read a specific line range, or grep for what you need.\n`
    );
    process.exit(2);
  }

  process.exit(0);
}

main().catch(() => process.exit(0));