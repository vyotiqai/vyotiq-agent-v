# 11 — M7 remediation: hast-util-sanitize on the highlighted-code path (APPLIED)

**Status:** applied in the main tree by the parent round-3 run and verified (this file documents what shipped). The originally spawned M7 child instance was cancelled before commit and its worktree pruned, so the parent authored the change directly from the child's verified transcript evidence (recorded below) and verified it end to end.

## 1. Audit premise, corrected (child-verified)

- The markdown **body** path was already sanitized: `src/renderer/src/lib/ui/MarkdownContent.tsx:16` imports `rehype-sanitize` and `:112-114` wires `[[rehypeSanitize, markdownSanitizeSchema]]`, with `markdownSanitizeSchema = defaultSchema` (GitHub schema) at `markdownSanitize.ts:4`. The audit's "does not sanitize yet" framing was stale.
- The real open gap (audit M7, `AUDIT-REPORT-2026-09-10.md:123-125`): the **highlighted-code path** runs only a regex sanitizer (`sanitizeHighlightedHtml`, `markdownSanitize.ts:145`) before `dangerouslySetInnerHTML` (`MarkdownContent.tsx:213`). The file's own NOTE said to route it through hast-util-sanitize; that NOTE is now implemented.

## 2. Applied change (exact pairs, as landed)

**`src/renderer/src/lib/markdown/markdownSanitize.ts`** — two edits:

1. Import block + new structural schema:

```
import { fromHtml } from 'hast-util-from-html'
import { toHtml } from 'hast-util-to-html'
import { defaultSchema, sanitize, type Schema } from 'hast-util-sanitize'
...
export const highlightSanitizeSchema: Schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    pre: ['className', 'style', 'tabIndex'],
    span: ['className', 'style']
  }
}
```

2. `sanitizeHighlightedHtml` now opens with the structural belt (belt 1) and keeps the regex chain as the value-check belt (belt 2):

```
const tree = sanitize(fromHtml(html, { fragment: true }), highlightSanitizeSchema)
let out = toHtml(tree)
```

**`package.json`** — three devDependencies added (see §4). **`tests/renderer/chat/markdownSanitize.test.tsx`** — import extended with `highlightSanitizeSchema`, `defaultSchema` (from `hast-util-sanitize`), plus a new `describe('highlightSanitizeSchema — belt 1 structural pass')` with 6 tests.

Schema semantics verified from `node_modules/.pnpm/hast-util-sanitize@5.0.2/.../lib/index.js` before landing: `attributes[tag]` *replaces* the default per tag (hence the rebuild/spread), `strip: ['script']` drops script **content**, non-allowlisted tags are dropped wholesale, camelCase property keys (`className`, `tabIndex`) are what the schema matches (the library maps them to HTML spellings), and regex `class`-value patterns were **not** extended to shiki token classes — style *values* are not pattern-checkable by hast-util-sanitize, so belt 2's per-declaration rebuild (`ALLOWED_STYLE_PROPS` + `UNSAFE_STYLE_VALUE`) remains the value-level guarantee, exactly as the file NOTE prescribed ("keep the regex pass as a second belt").

## 3. Why the schema is exactly `pre`/`span` + className/style/tabIndex

Shiki's classic structure (verified in `@shikijs/core@4.4.3/dist/index.mjs:830-834, 892-937`) emits only: `pre` with `class="shiki <theme>"`, `style="background-color:…;color:…"` and `tabindex="0"`; `code`; per-line `span.line`; token `span`s with `style` color declarations; text nodes. Hostile HTML that reaches `sanitizeHighlightedHtml` can only come from a compromised highlighter or a future caller — the structural schema constrains the tree to that shape and the value belt constrains declarations to `color/background-color/font-style/font-weight/text-decoration` with `url()/expression()/@import` rejected.

## 4. Dependency spec (security-default compatible)

Added as devDependencies: `hast-util-sanitize@^5.0.2`, `hast-util-from-html@^2.0.3`, `hast-util-to-html@^9.0.5`. All three were **already resolved in pnpm-lock.yaml** (transitive deps of `rehype-sanitize@6.0.0` / `@shikijs/core@4.4.3` / `react-markdown@10.1.0`) at exactly those versions before this change — no resolution drift; `pnpm install` only rewrote the importers block (lockfile delta: +9 lines). Under `nodeLinker: isolated` the packages must be direct deps to be importable from workspace code — hence the explicit entries. `minimumReleaseAge: 1440` was never touched and never blocked (versions are long-published); `pnpm-workspace.yaml` is untouched; `pnpm install` exited 0 with all postinstall syncs green. `pnpm audit --audit-level high` coverage unaffected (CI gate unchanged).

## 5. Verification checklist (all executed this run)

| Check | Command | Result |
|---|---|---|
| Belt-1 unit suite | `pnpm exec vitest run tests/renderer/chat/markdownSanitize.test.tsx` | **43/43 passed** (37 pre-existing + 6 new structural tests) |
| Adjacent markdown suites | `streamingMarkdown.test.tsx` + `messageList.markdown.test.tsx` | **41/41 passed** |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Install | `pnpm install` | exit 0; 3 packages root-resolvable (`node_modules/hast-util-*` present) |
| Full suite | `pnpm test` | see remediation/test-run-round3.log |

Out of scope, unchanged: `MermaidDiagram.tsx:69` (the other `dangerouslySetInnerHTML` site — mermaid `securityLevel: 'strict'`, audit-verified) and `useDiffHighlight.ts` (renders token lists via React, no HTML injection).
