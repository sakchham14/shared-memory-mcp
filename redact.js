/**
 * redact.js — replace secrets in memory text with env-var placeholders.
 *
 * The real secret values never enter the SQLite DB. Two passes:
 *
 *   1. Known env vars. For every env var whose NAME looks like a secret
 *      (TOKEN/KEY/SECRET/AUTH/CREDENTIAL/PASSWORD) and whose VALUE is long
 *      enough to be a real credential, if that value appears in the text it is
 *      replaced with `${VAR_NAME}`. The caller can then read the value back
 *      from the process environment at recall time.
 *
 *   2. Generic secret patterns (OpenAI/AWS/GitHub keys, Bearer tokens, private
 *      key blocks, `password = ...` assignments). These are replaced with
 *      `[REDACTED:<n>]` and returned in the `secrets` list so the caller can
 *      record a mapping (placeholder -> env var the user should set).
 *
 * Text that already contains `${...}` placeholders is left alone.
 *
 * Env:
 *   MEM_REDACT_ALLOW  comma-separated list of regex patterns to NEVER redact
 *                     (e.g. "sk-test-.*")
 *   MEM_REDACT_ENV    comma-separated list of env var names to scan for values
 *                     (default: all secret-ish names)
 *
 * Usage:
 *   import { redact } from './redact.js';
 *   const { text, secrets } = redact(originalText);
 */

// Generic secret patterns. Each entry is [regex, label].
const PATTERNS = [
  [/sk-[A-Za-z0-9A-Za-z_-]{16,}/g, 'openai_key'],
  [/sk-ant-[A-Za-z0-9A-Za-z_-]{16,}/g, 'anthropic_key'],
  [/AKIA[0-9A-Z]{16}/g, 'aws_access_key'],
  [/ghp_[A-Za-z0-9]{30,}/g, 'github_token'],
  [/gho_[A-Za-z0-9]{30,}/g, 'github_oauth'],
  [/xox[baprs]-[A-Za-z0-9-]{10,}/g, 'slack_token'],
  [/Bearer\s+[A-Za-z0-9._~+/=-]{20,}/g, 'bearer_token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, 'private_key'],
  [/\/(?:Users|home|root)\/[^\s'"]{6,}/g, 'filesystem_path'],
  [/\/(?:etc|var|tmp)\/[^\s'"]{6,}/g, 'filesystem_path'],
  [
    /(password|passwd|pwd|api[_-]?key|secret|auth[_-]?token|access[_-]?token|client[_-]?secret)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
    'credential_assignment',
  ],
];

const SECRET_NAME_RE = /(token|key|secret|auth|credential|password|passwd|api)/i;

function defaultAllowList() {
  const raw = process.env.MEM_REDACT_ALLOW;
  if (!raw) return [];
  return raw.split(',').map(s => s.trim()).filter(Boolean).map(s => new RegExp(s, 'i'));
}

function defaultEnvList() {
  const raw = process.env.MEM_REDACT_ENV;
  if (raw) return raw.split(',').map(s => s.trim()).filter(Boolean);
  return Object.keys(process.env).filter(k => SECRET_NAME_RE.test(k));
}

/**
 * Redact a single string. Returns { text, secrets } where secrets is a list of
 * { placeholder, envVar?, kind, snippet }.
 */
export function redact(text) {
  if (!text) return { text, secrets: [] };
  const allow = defaultAllowList();
  const envNames = defaultEnvList();
  const secrets = [];
  let out = text;

  // Pass 1: env var values -> ${VAR_NAME}
  for (const name of envNames) {
    const val = process.env[name];
    if (!val || val.length < 12) continue;
    if (allow.some(re => re.test(val))) continue;
    // Don't redact values that are just filesystem paths or booleans.
    if (/^(true|false|yes|no|on|off)$/i.test(val)) continue;
    if (/^[\w./-]+$/.test(val) && val.includes('/')) continue; // looks like a path
    const placeholder = `${'${'}${name}${'}'}`;
    // Escape for regex; replace all occurrences.
    const re = new RegExp(escapeRegEx(val), 'g');
    if (re.test(out)) {
      out = out.replace(re, placeholder);
      secrets.push({ placeholder, envVar: name, kind: 'env_var', snippet: val.slice(0, 8) + '…' });
    }
  }

  // Pass 2: generic patterns -> [REDACTED:<n>]
  let n = 0;
  for (const [re, label] of PATTERNS) {
    // Reset lastIndex for global regexes (regexes with /g carry state).
    const matcher = new RegExp(re.source, re.flags);
    out = out.replace(matcher, (match) => {
      // Skip if it's already a placeholder or env var reference.
      if (/^\$\{[A-Z0-9_]+\}$/.test(match)) return match;
      n += 1;
      const placeholder = `[REDACTED:${n}]`;
      secrets.push({ placeholder, kind: label, snippet: match.slice(0, 8) + '…' });
      return placeholder;
    });
  }

  return { text: out, secrets };
}

function escapeRegEx(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}