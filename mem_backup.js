/**
 * mem_backup.js — snapshot the shared memory DB before each autosave.
 *
 * Runs as a PreToolUse/Stop hook. Copies mem.db to
 * ~/.claude/mem/backups/mem.db.<ISO timestamp> and prunes backups older
 * than MEM_BACKUP_RETENTION_DAYS (default 30).
 *
 * Usage: node mem_backup.js <db_path> [backup_dir] [retention_days]
 */
import { copyFileSync, readdirSync, statSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';

const dbPath = process.argv[2];
const backupDir = process.argv[3] || `${homedir()}/code/.claude/mem/data/backups`;
const retentionDays = Number(process.argv[4] || process.env.MEM_BACKUP_RETENTION_DAYS || 30);
if (!dbPath) {
  console.error('usage: node mem_backup.js <db_path> [backup_dir] [retention_days]');
  process.exit(2);
}

mkdirSync(backupDir, { recursive: true });

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = `${backupDir}/mem.db.${stamp}`;
copyFileSync(dbPath, dest);
console.log(`[mem] backup -> ${dest}`);

// Prune old backups (keep newest MEM_BACKUP_RETENTION_DAYS).
const cutoff = Date.now() - retentionDays * 86400000;
let pruned = 0;
try {
  for (const f of readdirSync(backupDir)) {
    if (!f.startsWith('mem.db.')) continue;
    const full = `${backupDir}/${f}`;
    if (statSync(full).mtimeMs < cutoff) {
      unlinkSync(full);
      pruned++;
    }
  }
} catch { /* best-effort */ }
if (pruned) console.log(`[mem] pruned ${pruned} backup(s) older than ${retentionDays}d`);