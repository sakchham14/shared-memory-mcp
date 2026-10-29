# Shared Memory MCP Server

A self-contained MCP server for **local, cross-agent memory** using SQLite.

## The problem it solves

When an LLM is switched through an API gateway (or between providers), the new
session has no context. The naive fix is to re-read every file into context —
that burns input tokens on the *same* files every time, and at 130:1
input:output ratios it's expensive fast.

This server gives each agent a **durable local memory** instead:

- **No re-reading.** Facts, decisions, and prior session state are stored once
  and fetched on demand — a few hundred bytes instead of megabytes of file
  content.
- **No hallucination.** Memory is fetched **verbatim**, not regenerated from
  weights. An agent reads what was actually stored, not what it *remembers*.
- **Compressed on disk.** Content is stored both as plaintext (for search) and
  as a deflate BLOB. Typical compression is ~44% of raw size — kilobytes, not
  megabytes.

## Storage

Memory lives in a single SQLite file, no server process required:

```
~/.claude/mem/db/mem.db
```

| Metric | Value |
|---|---|
| Raw memory text (3 entries) | 3,783 bytes |
| Compressed (deflate) | 1,664 bytes (44%) |
| DB file size | 40 KB (SQLite page overhead) |
| Per-memory cost | ~1.3 KB raw / ~550 bytes compressed |

The DB file grows as memories are added; SQLite's practical ceiling is ~140 TB,
so this is a non-issue for years. `VACUUM` reclaims free pages if needed.

## Tools

| Tool | Purpose |
|---|---|
| `save_memory(projectId, title, content, summary?)` | Create or update a memory |
| `search_memories(query, projectId?, limit?)` | Keyword search (LIKE on title/content/summary) |
| `get_project_summary(projectId)` | All memories + change history for a project |
| `list_projects()` | All projects with memory counts |
| `get_memory(id)` | **Verbatim** full content of one memory |
| `get_project_index(projectId, includeSealed?)` | **Cheap index** — summaries + metadata only, never full content. Use at session start |
| `list_clumps(projectId)` | All clumps (chat batches) for a project, newest first |
| `get_clump(clumpId)` | **Verbatim** full content of every memory in a clump |
| `seal_clump(projectId, summary?)` | Seal the active clump and start a new one |
| `memory_stats()` | Storage stats: count, raw vs compressed bytes, per-project breakdown |

## Clumps (chat batches)

Memories are grouped into **clumps** — a running chat batch. When the estimated
token total of the active clump exceeds `MEM_CLUMP_THRESHOLD_TOKENS`
(default 8000), the next `save_memory` **auto-seals** it and starts a fresh one.
Sealed clumps keep their summary and are reconstructable via `get_clump`.

- **Auto-rollover:** `save_memory` returns `clumpSealed` (the id of the clump
  that was just sealed) and `clumpId` (the clump the new memory landed in).
- **Manual seal:** `seal_clump(projectId, summary)` — call it at the end of a
  chat batch to freeze it before context compaction.
- **Reconstruct:** `get_clump(clumpId)` returns every memory in a clump,
  verbatim, in creation order.

```text
save_memory("my-project", "decision", "full content...", "one-line summary")
  → { clumpId: "clump_...", clumpSealed: "clump_..." | null }
get_project_index("my-project")   → cheap summaries, for session start
get_clump("clump_...")            → full content of a sealed batch
```

## Session-start hook

`session-start.js` runs on every Claude Code `SessionStart` (registered in
`~/.claude/settings.json`) and injects a **compact index** into context:
active-clump summaries, sealed-clump summaries, and other projects. It never
loads full memory content — that's fetched on demand via `get_memory(id)`,
keeping the session-start cost to a few hundred tokens.

Override the project id per session with `MEM_PROJECT_ID=<name>`.

## Usage pattern

```text
1. On session start:  get_project_index("my-project")  → cheap context
2. When asked a fact: get_memory(id)                   → verbatim answer
3. When something is decided: save_memory(...)          → persists for next session
4. At end of a batch:  seal_clump("my-project")        → freeze before compaction
```

### Verbatim fetch — the anti-hallucination guarantee

`get_memory(id)` returns the **exact** stored text. Use it whenever an agent
needs authoritative data instead of a summary:

```json
{
  "content": "# Session 2026-10-29 — Shared Memory Server & FreeLLMAPI Fork\n..."
}
```

The returned `content` is the record. Quote it directly — the agent never
reconstructs it from memory, so it can't drift or invent details.

`get_project_summary` also returns full content (not just summaries), so an
agent starting a session can load the real state without guessing.

## Setup

```bash
cd /Users/mochi/.claude/mem
npm install
npm start
```

Register as an MCP server in your agent config (stdio launch, no port):

```json
"mcpServers": {
  "mem": {
    "command": "node",
    "args": ["/Users/mochi/.claude/mem/server.js"]
  }
}
```

Set `MEM_DB_PATH` to point at a different database.

## Direct access

The DB is plain SQLite — any tool can query it:

```bash
sqlite3 /Users/mochi/.claude/mem/db/mem.db \
  "SELECT project_id, title FROM memories WHERE content LIKE '%token%'"
```

Search uses `LIKE` on title/content/summary (no FTS5 — works reliably across
all SQLite builds).

## Design notes

- **Zero dependencies beyond `@modelcontextprotocol/sdk`.** Compression uses
  Node's built-in `node:zlib`; the DB uses `node:sqlite`.
- **Search runs on plaintext**, so keyword search never needs decompression.
  The BLOB is only read when you fetch a specific memory verbatim.
- **WAL journaling** for safe concurrent reads.
- **Change log** tracks every create/update per project.

## Usage pattern

```text
1. On session start:  get_project_summary("my-project")  → real context
2. When asked a fact: get_memory(id)                     → verbatim answer
3. When something is decided: save_memory(...)           → persists for next session
```

## Notes

- **No credentials needed** — it's a local MCP server.
- For production, add HTTPS and authentication.
- This does not replace gateway compression — it works alongside it for
  agent-to-agent memory.