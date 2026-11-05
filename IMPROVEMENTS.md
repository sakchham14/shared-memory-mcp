# Improvement plan for shared-memory-mcp

Source comparison: smm (MCP + hooks, ~/.claude/mem) vs billion-context (proxy plugin, model-driven compression).

## Tasks (apply one at a time; test between each)

1. Wire embed.js into search_memories: hybrid LIKE + vector (via @xenova/transformers). Test: search accuracy on existing memories.
2. Deterministic sorted index injection in session-start.js for prefix-cache stability. Test: byte-identical output across runs.
3. Auto-capture pass in session-end.js: extract structured facts/decisions from session, save_memory. Test: memories created after a session.
4. Hierarchical summaries in seal_clump: per-turn -> session -> project rollup. Test: clump summary content.
5. Reversible decompression for auto-captured content (store original pointers). Test: get_memory returns original.
6. Recall quality gates: relevance threshold + dedup before injection. Test: no low-confidence injection.
7. Extend redact.js to scrub secrets/paths, not just PII. Test: redacted output.
8. Project briefing memory auto-injected and auto-updated. Test: briefing present on session start.
9. Metrics/observability: injected token count, usage. Test: diagnostic output.
10. Doctor command: verify hooks, DB, MCP registration, node version; auto-repair. Test: doctor on clean + broken setups.

## Open question: convert MCP server to plugin?

billion-context is a proxy plugin rewriting streams; smm is an MCP server + hooks. Recommendation: do NOT fully convert. Instead keep MCP as the memory API (cross-agent, explicit), and add a plugin/bundle layer for auto-capture + compression hooks (session lifecycle). Hybrid: MCP for memory CRUD, plugin-style hooks for automation. Revisit if single-agent proxy compression is needed.
