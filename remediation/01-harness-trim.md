# H2 Remediation: trim `resources/harness/default.md` from 2003 → 1981 tokens

**Target:** `tests/main/unit/toolsSchema.test.ts:260` asserts `estimateTextTokens(harness) < 2000`.
**Measured result:** 2003 → **1981** estimateTextTokens (o200k_base BPE), a −22 margin under the 2000 gate and −14 under the requested ≤1995 target.

## How these numbers were measured (not estimated)

- The test calls `estimateTextTokens(harness)` with no model → `encodingForModel(undefined)` returns `'o200k_base'` (`src/main/agent/context/tokenizer.ts`, `encodingForModel`), and `countTextTokens` runs a real BPE via `gpt-tokenizer/encoding/o200k_base` (`src/main/agent/context/tokenizer.ts:countTextTokens`; `src/main/agent/context/estimate.ts:13-15`). The 100k-char chars/4 heuristic does not apply (file is 10,214 chars).
- I ran a throwaway Node script (written to the OS temp dir, outside both repos — no repo file was touched) that imported the main checkout's installed `gpt-tokenizer@3.4.0` ESM module (`esm/encoding/o200k_base.js` — the exact module `tokenizer.ts` imports), read the main-tree `resources/harness/default.md`, and applied each pair in order, recounting after each.
- Observed output: `BASE TOKENS: 2003` … `FINAL TOKENS: 1981`, `VALIDITY ERRORS: none`.
- Every `old_string` below was verified to occur **exactly once** in the main-tree file (both via PowerShell ordinal count and via the measurement script's `split(o).length - 1 === 1` check). All pairs are pure ASCII (no curly quotes / em dashes), so there are no encoding pitfalls when applying them.
- The main-tree file is LF-only (no CRLF) and starts with `# Agent V\n`.

## The pairs (apply in this order)

Deltas are as measured cumulatively in this order; the pairs do not overlap, so order does not change the result.

### Pair 1 — tool_policy, opening line (−1)

```text
old: Inspect the affected files, behaviour, or runtime evidence before making repository-specific claims or changes.
new: Inspect affected files, behaviour, or runtime evidence before making repository-specific claims or changes.
```

Delta: −1 (` the`). Rationale: drops a grammatical article only; the directive (inspect before claiming/changing) is unchanged.

### Pair 2 — tool_policy, multi-file edits paragraph (−2)

```text
old: and batch the independent calls together: edit carries either contents or diff, never both
new: and batch independent calls: edit carries either contents or diff, never both
```

Delta: −2 (` the`, ` together`). Rationale: "batch the independent calls together" and "batch independent calls" mean the same thing; "together" is redundant with "batch".

### Pair 3 — tool_policy, budget-blocking tools paragraph (−1)

```text
old: if a required decision is missing, continue other verifiable work and surface the question or blocker in the reply
new: if a required decision is missing, continue verifiable work and surface the question or blocker in the reply
```

Delta: −1 (` other`). Rationale: "continue verifiable work" carries the instruction; "other" was implied by "continue".

### Pair 4 — tool_policy, zoom-lens paragraph (−1)

```text
old: then combine the verified details into the final answer or diff
new: then combine verified details into the final answer or diff
```

Delta: −1 (` the`). Rationale: article removal only; "verified details" keeps the requirement that combined details be verified.

### Pair 5 — work_style, delegation paragraph opening (−1)

```text
old: every single time, no matter how small the request
new: every time, no matter how small the request
```

Delta: −1 (` single`). Rationale: "every time" is unambiguous; "single" adds emphasis, not meaning.

### Pair 6 — work_style, delegation task decomposition (−5)

```text
old: then decompose the plan into a structured set of very small, atomic, independent tasks
new: then decompose the plan into small, atomic, independent tasks
```

Delta: −5 (` a`, ` structured`, ` set`, ` of`, ` very`). Rationale: "a structured set of very small, atomic, independent tasks" and "small, atomic, independent tasks" denote the same thing; the qualifiers that carry semantics — small, atomic, independent, one-deliverable-each (kept in the following parenthetical) — all survive.

### Pair 7 — work_style, delegation fan-out sentence (−3)

```text
old: spawn all of them in one step with complete structured briefs
new: spawn them in one step with complete briefs
```

Delta: −3 (` all`, ` of`, ` structured`). Rationale: "spawn them" (object: all the decomposed tasks, from the preceding sentence) plus "fan every task out" later in the sentence retains totality; the briefs' structure is specified by the `(outcome, sub-tasks, done-when, affected paths)` parenthetical that follows, so "structured" was redundant.

### Pair 8 — memory, opening sentence (−3)

```text
old: user preferences, and so on in structured forms and formats
new: user preferences, etc. in structured formats
```

Delta: −3 (` and so on in structured forms and formats` → `etc. in structured formats` per measured fragment delta). Rationale: "and so on" ≡ "etc."; "forms and formats" was a redundant pair — "structured formats" keeps the full meaning.

### Pair 9 — memory, durable-memory sentence (−2)

```text
old: Use durable memory only when it is available, permitted by the current mode, and useful for future work
new: Use durable memory only when available, permitted by the current mode, and useful for future work
```

Delta: −2 (` it`, ` is`). Rationale: "when available" is the standard compression of "when it is available"; all three conditions are preserved.

### Pair 10 — tool_policy, prerequisites paragraph (−3)

```text
old: run it or drop that path instead of retrying the failed call
new: run it or drop that path instead of retrying
```

Delta: −3 (` the`, ` failed`, ` call`). Rationale: "instead of retrying" — the antecedent (the failed call that named the missing prerequisite) is established earlier in the same sentence, so the trailing noun phrase was redundant.

## Token math

| Pair | Measured Δ |
|------|------------|
| 1    | −1 |
| 2    | −2 |
| 3    | −1 |
| 4    | −1 |
| 5    | −1 |
| 6    | −5 |
| 7    | −3 |
| 8    | −3 |
| 9    | −2 |
| 10   | −3 |
| **Total** | **−22** |

2003 − 22 = **1981** < 2000 (test gate) and ≤ 1995 (requested margin). Character count falls 10,214 → 10,100.

## Post-trim validity (verified, not asserted)

The measurement script re-ran the exact checks from `validateHarnessMarkdown` (`scripts/sync-harness.mjs`) on the trimmed text and reported `VALIDITY ERRORS: none`:

- still starts with `# Agent V\n` (first line untouched);
- no `## ` headings introduced (all pairs edit in-paragraph prose);
- `<role>`, `<capabilities>`, `<tool_policy>`, `<constraints>`, `<work_style>`, `<memory>`, `<output_format>` each appear exactly once as an open/close pair (no pair touches a tag line);
- no `<workspace_harness>` wrapper introduced.

## Semantics

All ten pairs are forward-only language compression: article/pronoun deletions, redundancy removal ("together" after "batch", "single" after "every", "and so on" → "etc.", "forms and formats" → "formats"), and one trailing-noun-phrase ellipsis with the antecedent intact. No directive, list, tag, heading, tool name, code identifier, or example was removed or altered. Nothing from the pre-in-flight (deleted/old) text was restored.

## Suggested verification after the parent applies the pairs

1. `node scripts/sync-harness.mjs` → expect `[sync-harness] canonical resources/harness/default.md is valid`.
2. Run `tests/main/unit/toolsSchema.test.ts` → expect the harness-ceil assertion to pass (1981 < 2000).
