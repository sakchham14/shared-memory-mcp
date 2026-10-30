# TASKS — shared-memory-mcp pending work

Source: local claude mem DB (`/Users/mochi/.claude/mem/db/mem.db`), project `code`,
clump `clump_code_1793307741189_934f` (sealed). Last turn ended mid-task-list.
Repo: `sakchham14/shared-memory-mcp` @ `/Users/mochi/.claude/mem`, HEAD `e457b66`.

---

## A. Hybrid search engine (highest priority)

User asked for this explicitly (memory `mem_1793312906003_meunc`). All pieces exist
except the glue.

- [ ] **A1. Wire `embed.js` into the recall path.** It is written and loads
      all-MiniLM-L6-v2 (384-dim, cached under `~/.claude/mem/embeddings/`) but is
      not imported anywhere. Recall currently uses keyword `LIKE` only.
- [ ] **A2. RRF re-ranking (k=60).** Combine BM25 (FTS5) + vector cosine via
      Reciprocal Rank Fusion. Both channels must actually run.
- [ ] **A3. Cosine threshold < 0.72.** Discard vector results below the cutoff.
- [ ] **A4. Time decay `exp(-λ·age)`.** Lower relevance of stale memories unless
      keyword similarity is exceptionally high.
- [ ] **A5. Two-stage MCP tool interface.** Refactor `server.js` tools:
      - `search_memory_summary(query, limit=3)` — lightweight titles, timestamps,
        memory IDs only (prevents context pollution)
      - `fetch_memory_details(memory_ids)` — full conversation blocks on demand
- [ ] **A6. Parent-child chunking.** Index small child snippets (individual
      turns/facts) for high-accuracy matching, link them to parent conversation
      contexts for retrieval.

## B. Memory quality (from `mem_1793313033346_bqsxc`)

Current autosave stores raw `User: ... \n\n Assistant: ...` transcripts. Claude Code's
distilled-fact approach is better for recall quality.

- [ ] **B1. Store distilled facts, not raw transcripts.** `session-end.js` should
      extract the decision/fact from each turn, not dump the whole exchange.
- [ ] **B2. Real summaries.** `session-end.js` line ~111 currently does
      `summary = assistantMsg.slice(0, 120)` — a truncation, not a summary.
- [ ] **B3. Human-readable clump summaries on seal.** Sealed clumps currently get
      `"Auto-sealed after 8000 est tokens"`. Summarize what the batch was about.
- [ ] **B4. Deduplication.** Same topic across 3 turns = 3 overlapping rows.
- [ ] **B5. Memory typing.** Distinguish `user` (preferences), `feedback`
      (corrections), `project` (ongoing goals), `reference` (external pointers).
- [ ] **B6. Language filter.** Recall should filter to English-only (embedding
      model is English-only; Chinese produces poor vectors). See also C3.
- [ ] **B7. Cross-clump summarization.** After N sealed clumps, summarize across
      them so the index stays bounded instead of growing unboundedly.

## C. Hygiene / outstanding

- [ ] **C1. `claude-mem` observer still down.** Run `/login` in Claude Code to
      restore it. Unrelated to this system; works without it.
- [ ] **C2. Commit + push** any new files from this session.
- [ ] **C3. Clean Chinese memories from the DB** (or land B6 first so recall
      never returns them). One-liner:
      `sqlite3 /Users/mochi/.claude/mem/db/mem.db "DELETE FROM memories WHERE project_id='code';"`
- [ ] **C4. Session titles fail on `model:auto`** — harmless but noisy. Gateway
      occasionally returns no title.
- [ ] **C5. Consider `paraphrase-multilingual-MiniLM-L12-v2`** if Chinese memory
      storage is ever wanted (current all-MiniLM-L6-v2 is English-only).

---

## D. Hallucination / looping root cause (diagnosed 2026-10-30)

Two interacting defects. Full write-up: memory `mem-hallucination-loop-root-cause`.

**D1. Recall injects stale off-topic memories on every prompt.** `recall.js`
(UserPromptSubmit) matches ANY keyword, has no topic filter, no relevance
threshold, and orders only by hit-count tiebreak (not recency). A generic
prompt like "access local claude memory and find what is the reason causing it
to hallucinate and looping" matches 8/11 keywords and returns memories about
Gym-Coach-AI pricing, freellmapi proxies, and Oct 29 Chinese-language
debates — none about the actual request. The model then re-answers its own
past text → loop. **Verified by running the hook directly.**

**D2. The DB is contaminated (amplifier).** 39 memories / 72KB. Of 32 `code`
rows: 5 are raw JSON hook payloads (`{"session_id":...}`), 3 are `<pasted_content>`
blobs, 9 are Chinese turns (embedding model is English-only → garbage vectors),
3 in the active clump are `User: (no staged prompt)` dead rows.

### Fix order (do NOT ship hybrid search A1-A6 on top of this)

1. **Tighten recall** — require ≥50% keyword-hit share, weight recency, cap
   injection, and only return rows whose topic actually overlaps the prompt.
   Patch `recall.js` ORDER BY to `hits DESC, updated_at DESC` is already there;
   the missing piece is a hit-share floor + topic filter.
2. **Clean the DB** — delete raw-JSON, pasted-content, Chinese, and empty-prompt
   rows for `project_id='code'` (and audit other projects). Backup first.
3. **Then** build B1-B7 (distilled facts, real summaries, dedup, typing,
   language filter) so new rows are clean going forward.
4. **Then** A1-A6 hybrid search, which is worthless on contaminated data.