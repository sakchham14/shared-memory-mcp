# Shared Memory MCP Server

This directory contains the shared memory MCP server for Claude Code.

## Structure
- `server.js` - Main MCP server entry point
- `mem.db` - SQLite database
- `session-start.js`, `session-end.js` - Hook scripts
- `skip-large-files.js` - Read hook
- `mem_prune.js` - Cleanup utility
- `mem_backup.js` - Backup utility
- `recall.js` - Memory retrieval
- `redact.js` - PII redaction
- `embed.js` - Embedding generation
- `prompt-stage.js` - Prompt staging
- `data/` - Database backups
- `projects/` - Per-project memory caches
- `cache/` - ONNX embedding model cache