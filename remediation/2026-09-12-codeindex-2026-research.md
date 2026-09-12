# Codebase indexing — 2026 research validation (2026-09-12)

Question: is the shipped, embedding-free local code index the current (2026)
best practice for a desktop coding agent, or is a simpler/better approach
available?

**Conclusion: yes — SQLite FTS5 (trigram) + BM25 keyword ranking over
symbol-aware chunks with incremental mtime/size/hash sync is the mainstream
2026 answer for local, embedding-free code search, and it is what ships.**

## Shipped implementation (verified from source this run)

All in `src/main/agent/codeindex/` — plain SQLite via `node:sqlite`
`DatabaseSync` (`store.ts:3`), no models, no ONNX, no embeddings:

- **Storage** — one SQLite store per workspace: `files` + `chunks` tables plus
  a single FTS5 virtual table `chunks_fts` with
  `tokenize = 'trigram'` (`store.ts:321-326`). WAL journal, `synchronous =
  NORMAL`, `busy_timeout = 5000` (`store.ts:33-35`). Foreign (old embedding)
  schemas are detected and rebuilt from scratch (`store.ts:302`).
- **Search** — `searchFts()` runs `chunks_fts MATCH ? ORDER BY
  bm25(chunks_fts, 0, 4.0, 3.0, 1.0)` — BM25 column weights favour path/name
  hits over body text (`store.ts:222-224`). Tokens are floored at 3 chars
  (trigram minimum) with a LIKE fallback; an AND pass is followed by an OR
  recall pass (`store.ts:204-210`).
- **Sync** — incremental paged walk keyed on file `mtime/size/hash` stamps
  with a cursor, empty-stamp skip, and reconcile of deleted files
  (`sync.ts`, `index.ts:152`).
- **Chunking** — symbol-aware chunks (code/docs kinds, first-symbol and
  trailing-symbol detection, head/overlap constants) in `chunk.ts`.
- **Query layer** — `searchCodeIndex()` merges FTS hits with lexical
  documentation overlap (`collectDocsLexicalHits`, `query.ts:57,166,185`) and
  the same trigram table doubles as candidate pruning for
  `grep`/`search`/`glob` (formerly sparsegrep) with callers still verifying
  matches (`query.ts:232,277,297`).
- **Tests** — `tests/main/unit/codeindex.search.test.ts`,
  `tests/main/unit/codeindex.chunk.test.ts`,
  `tests/main/e2e/largeRepoIndex.e2e.test.ts`.

## 2026 web findings (all visited this run)

- SQLite's own FTS5 documentation is the canonical reference for `bm25()`
  ranking and the trigram tokenizer (substring matching, LIKE/GLOB
  acceleration): https://www.sqlite.org/fts5.html
- NitroIDE built IDE-grade global search on a SQLite full-text index and
  documents sub-10ms result quality without any vector search:
  https://nitroide.com/blog/sqlite-wasm-browser-search-indexing.html
- `ffts-grep` (Jan 2026) indexes ~10k files with SQLite FTS5 and answers in
  ~10ms with BM25 ranking — the "grep, but indexed" pattern:
  https://github.com/mneves75/ffts-grep
- `sqlite-bm25-search` implements the same shape as our sync: walk the
  directory, store file stamps, run `MATCH` + BM25, re-index only what
  changed by mtime: https://github.com/midclique/sqlite-bm25-search
- Trigram tokenizer for identifier/name matching (the exact reason we floor
  tokens at 3 chars): https://davidmuraya.com/blog/sqlite-fts5-trigram-name-matching
  and https://andrewmara.com/blog/faster-sqlite-like-queries-using-fts5-trigram-indexes
- "Why SQLite+FTS5 beats Vector DBs for AI agent memory" (Apr 2026) — for
  agent-scale corpora, a single SQLite file with FTS5 beats hosted vector DBs
  on simplicity, latency, and retrieval quality for identifier-heavy text:
  https://dev.to/fex_beck_27bfd4dccd05f062/why-sqlitefts5-beats-vector-dbs-for-ai-agent-memory-4inj
- "Why I Built Local-First Agent Memory" (Jun 2026) reaches the same
  conclusion and explicitly rejects defaulting to vector embeddings:
  https://labyrinthanalyticsconsulting.com/blog/why-i-built-local-first-agent-memory
- Practical FTS5 MATCH/bm25() usage guides (2026): https://coddy.tech/docs/sqlite/full-text-search
  and https://mako.ai/docs/sqlite/full-text-search
- For completeness, the vector-hybrid world exists (sqlite-vec + FTS5 + RRF):
  https://github.com/mycman/sqlite-vec-benchmark — it requires local model
  downloads and embedding compute, which is exactly the complexity this
  migration removed. Local FTS+Ollama semantic split shown in:
  https://docs.bswen.com/blog/2026-03-17-local-ai-memory-sqlite-ollama

## Alternatives compared

| Approach | Retrieval quality | Complexity / cost | Verdict for this app |
|---|---|---|---|
| SQLite FTS5 trigram + BM25 chunks (shipped) | Strong for identifiers/keywords; substring via trigram | One node builtin (`node:sqlite`), zero deps, zero model downloads, instant startup | **Shipped — matches 2026 mainstream** |
| ripgrep-style brute scan, no index | Good, no ranking/chunking | Simple but re-reads every file per query; slow on big repos | Kept as the always-available fallback (`grep`/`search` tools); index accelerates candidates |
| tree-sitter tag/symbol index | Precise symbols | Requires wasm grammars per language + maintenance (removed deliberately) | Rejected — grammar downloads and wasm assets were part of the removed complexity |
| Local vector embeddings (sqlite-vec / ONNX) | Better paraphrase recall | Model downloads, embedding compute on every sync, bigger install/RAM | Removed — the old stack; contrary to 2026 "FTS5-first" practice for code identifiers |
| Hosted/remote embeddings | Same as local vectors minus local cost | Network dependency + privacy loss | Rejected — fully-local requirement |

## Possible future improvements (not implemented)

- Case-sensitive trigram matching when SQLite exposes it per-table (today the
  index is case-insensitive; callers verify with real flags —
  `query.ts:279`).
- Optional per-workspace "hot paths" boost — a pure SQL ranking tweak, no
  new machinery.
