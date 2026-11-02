# Shared Memory MCP Server for Claude Code

A small SQLite-backed memory layer that injects only **summaries** into Claude Code's context window, keeping token usage low across long sessions.

## How it reduces token usage

- **Compact index injection** — On session start, only memory titles + summaries are injected (not full content). Full verbatim content is fetched on demand via `get_memory(id)`.
- **Clump archival** — Memories are grouped into "clumps" (chat batches). When a clump grows large, `seal_clump()` archives it; only its label remains in context.
- **Skip-large-files hook** — A `PreToolUse` hook blocks `Read` of large/binary/secret files, forcing targeted `grep` instead of dumping whole files into context.
- **Redaction** — `redact.js` strips PII from stored memories before they're indexed.

## Layout

```
~/.claude/mem/
├── server.js          # MCP server entry point
├── session-start.js   # SessionStart hook (injects compact index)
├── session-end.js     # Stop hook (archives session)
├── skip-large-files.js # PreToolUse hook (blocks large file reads)
├── mem_backup.js      # DB backup utility
├── mem_prune.js       # Cleanup old memories
├── recall.js          # Memory retrieval logic
├── redact.js          # PII redaction
├── embed.js           # Embedding generation
├── prompt-stage.js    # Prompt staging
├── package.json       # Dependencies
├── data/              # SQLite DB (gitignored)
├── cache/             # ONNX model cache (gitignored)
└── projects/          # Per-project memory caches (gitignored)
```

## Setup

1. **Install dependencies**
   ```bash
   cd ~/.claude/mem
   npm install
   ```

2. **Configure Claude Code hooks** in `~/.claude/settings.json`:
   ```json
   {
     "hooks": {
       "SessionStart": [
         { "hooks": [
           { "type": "command", "command": "node ~/.claude/mem/session-start.js", "timeout": 5000 }
         ]}
       ],
       "Stop": [
         { "hooks": [
           { "type": "command", "command": "node ~/.claude/mem/mem_backup.js ~/.claude/mem/data/mem.db", "timeout": 5000 },
           { "type": "command", "command": "node ~/.claude/mem/session-end.js", "timeout": 5000 }
         ]}
       ],
       "PreToolUse": [
         { "hooks": [
           { "type": "command", "command": "node ~/.claude/mem/skip-large-files.js", "timeout": 2000 }
         ]}
       ]
     },
     "mcpServers": {
       "shared-memory": {
         "command": "node",
         "args": ["~/.claude/mem/server.js"],
         "env": { "MEM_DB_PATH": "~/.claude/mem/data/mem.db" }
       }
     }
   }
   ```

3. **Restart Claude Code** — the SessionStart hook will inject the compact index automatically.

## Usage

| Tool | Purpose |
|------|---------|
| `save_memory(projectId, title, content, summary)` | Store a memory (summary injected into context) |
| `get_memory(id)` | Fetch full verbatim content on demand |
| `search_memories(query)` | LIKE-based search across title/content/summary |
| `seal_clump(projectId)` | Archive current batch, start fresh |
| `get_project_summary(projectId)` | Full index for a project |

## Token-reduction tips

- Always provide a **summary** when saving — it's what stays in context.
- Seal clumps when a session grows large (`seal_clump`).
- Let the skip-large-files hook block big reads; use `grep` instead.
- Run `mem_prune.js` periodically to drop stale memories.

## License

ISC