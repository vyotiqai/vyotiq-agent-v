# L8 remediation — release.yml tag↔package.json version guard

**Finding**: `.github/workflows/release.yml` triggers on tag push (`v*`) and publishes via electron-builder with `--publish always`, deriving the version entirely from `package.json`. Nothing compares the pushed tag to the package version. A tag/version mismatch publishes assets named for the old version onto the release derived from the tag — colliding assets and no user update (RELEASE-RUNBOOK.md §1, `.github/workflows/../../RELEASE-RUNBOOK.md:17`, runbook:30-31, failure-mode row a at runbook:185).

**Fix**: ONE new step in the existing `package` job that fails the job on tag/version mismatch, skipped entirely on manual dispatch.

---

## 1. Current workflow shape (evidence)

| Claim | Evidence |
|---|---|
| Trigger: tag pushes matching `v*`, plus manual `workflow_dispatch` | `.github/workflows/release.yml:3-7` (`on:` / `push:` / `tags:` / `- 'v*'` / `workflow_dispatch:`) |
| Exactly ONE job: `package` (no other jobs, no `needs:` graph) | `.github/workflows/release.yml:17-18` (`jobs:` / `package:`); the `jobs:` block ends with this job's `steps:` at :49 |
| `package` is a 3-leg matrix (windows-x64, linux-x64, macOS) with `fail-fast: false` | `.github/workflows/release.yml:24-47` (strategy/matrix) |
| Steps begin: checkout → setup-node (Node 22) → Enable pnpm → setup-node (cache) → install → build | `.github/workflows/release.yml:49-53` (checkout, `persist-credentials: false` at :52), `:54-56` (setup-node, `node-version: 22` at :56), `:58-61` (Enable pnpm), `:63-66` (setup-node + `cache: pnpm`), `:68-69` (install), `:71-72` (build) |
| Version is consumed and published in the `Package installers` step | `.github/workflows/release.yml:74-93`; the run command at :88-90 evaluates `startsWith(github.ref, 'refs/tags/') && '--publish always' || '--publish never'` |
| Dispatch path is deliberately degraded | `.github/workflows/release.yml:84-87` (comment: `--publish always` only on real tag pushes) and the same expression at :89-90 — a manual dispatch gets `--publish never` |
| `package.json` version field | `package.json:3` — `"version": "1.2.0"` |
| Job has `permissions: contents: write`; top level `contents: read` | `.github/workflows/release.yml:9-10`, `:21-23` |

`github.ref_name` is available on every event and equals the tag name without the `refs/tags/` prefix on a tag push (`v1.2.0`), so the guard can compare it to `package.json`'s `version` directly.

## 2. Placement decision

**Placement: inside the single `package` job, as a step immediately after the first `actions/setup-node` (:54-56) and before `Enable pnpm` (:58).** Justification from the file:

- There is only one job (`package`, :17-18), so "first step of the build job that consumes the version" and "the whole job graph" are the same thing. A separate early guard job would require adding a new job **and** a `needs:` key to `package` — two structural edits, violating the one-step minimality rule. The redundant per-leg execution (3×) costs milliseconds and needs no other change.
- It must run **after** checkout (:50-53) — `package.json` must exist on disk.
- It must run **after** setup-node (:54-56) — Node must be on PATH for the comparison script; pinning to the workflow's own Node 22 beats relying on the runner image's preinstalled node.
- It must run **before** everything that consumes the version: `Install dependencies` (:68), `Build bundles` (:71), and above all `Package installers` (:74-93), which is where `--publish always` executes. Failing here means no build time is wasted and **no publish ever happens** on a mismatch — the exact failure mode the runbook calls the worst release mistake (row a, runbook:185).

## 3. Exact old_string → new_string pair

`old_string` is verbatim from the current clean tree, lines `.github/workflows/release.yml:54-58`. It is **unique**: the other `actions/setup-node` block (:63-66) is followed by `cache: pnpm` instead of a blank line + `Enable pnpm`, so it does not match.

**old_string**

```yaml
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22

      - name: Enable pnpm
```

**new_string**

```yaml
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22

      - name: Verify tag matches package.json version
        if: startsWith(github.ref, 'refs/tags/')
        shell: bash
        env:
          GITHUB_REF_NAME: ${{ github.ref_name }}
        run: |
          node -e "const pkg=require('./package.json');const tag=process.env.GITHUB_REF_NAME.replace(/^v/,'');if(tag!==pkg.version){console.error('Tag v'+tag+' does not match package.json version '+pkg.version+'. electron-builder would publish '+pkg.version+'-named assets onto the v'+tag+' release. Bump package.json to '+tag+' and re-tag, or move the tag to v'+pkg.version+'.');process.exit(1)}console.log('Tag v'+tag+' matches package.json version '+pkg.version)"

      - name: Enable pnpm
```

## 4. Resulting step (quoted copy)

```yaml
      - name: Verify tag matches package.json version
        if: startsWith(github.ref, 'refs/tags/')
        shell: bash
        env:
          GITHUB_REF_NAME: ${{ github.ref_name }}
        run: |
          node -e "const pkg=require('./package.json');const tag=process.env.GITHUB_REF_NAME.replace(/^v/,'');if(tag!==pkg.version){console.error('Tag v'+tag+' does not match package.json version '+pkg.version+'. electron-builder would publish '+pkg.version+'-named assets onto the v'+tag+' release. Bump package.json to '+tag+' and re-tag, or move the tag to v'+pkg.version+'.');process.exit(1)}console.log('Tag v'+tag+' matches package.json version '+pkg.version)"
```

Exact run script (single line, `bash -e`):

```bash
node -e "const pkg=require('./package.json');const tag=process.env.GITHUB_REF_NAME.replace(/^v/,'');if(tag!==pkg.version){console.error('Tag v'+tag+' does not match package.json version '+pkg.version+'. electron-builder would publish '+pkg.version+'-named assets onto the v'+tag+' release. Bump package.json to '+tag+' and re-tag, or move the tag to v'+pkg.version+'.');process.exit(1)}console.log('Tag v'+tag+' matches package.json version '+pkg.version)"
```

Behaviour: on a tag push where `github.ref_name` (minus the leading `v`) equals `require('./package.json').version`, the step logs the match and exits 0. On mismatch it prints a clear remediation message and exits 1, failing the matrix leg; with `fail-fast: false` (:26) all three legs still report, but every one of them fails before `Package installers` — so nothing is uploaded to the release. With `package.json` at `1.2.0` (`package.json:3`), tag `v1.2.0` passes; `v1.3.0` fails.

### Script-safety notes (rule 4)

- The only command is the `node -e` invocation; its exit code **is** the step's exit code (`bash -e` + last command). There is no `exit "…"` bare-string trap and no trailing bare string literal.
- Failure path uses `process.exit(1)` inside Node, not a shell exit, so no quoting issue can turn an error message into an exit code.
- Tag text never reaches the shell: `github.ref_name` is passed through `env: GITHUB_REF_NAME` (:`env` block) rather than interpolated into the script, so a maliciously-crafted tag name cannot inject shell code — the same GitHub-recommended pattern the existing `GH_TOKEN` env usage follows (:77-83).
- Single quotes appear only inside the double-quoted `-e` argument; no `!` (history expansion), no backticks, no `$` followed by a shell-variable-looking name — safe under bash on all three matrix OSes (`shell: bash` normalizes the windows-latest leg, whose default would otherwise be PowerShell).
- Guard requires no extra permissions; the job already grants `contents: write` (:21-23) and the guard only reads local files.

## 5. YAML-structural reasoning

- **Indentation**: the new step's keys sit at the same depth as sibling steps — `-` at 6 spaces (col 7) matching `- uses: actions/checkout…` (:50) and `- name: Enable pnpm` (:58); scalar keys (`name`/`if`/`shell`/`env`/`run`) at 8 spaces matching `with:` (:55) and `run:` (:59). `env:`'s child mapping `GITHUB_REF_NAME` at 10 spaces, mirroring how `with:` children indent at :52/:56.
- **Placement**: the block is inserted between the setup-node step (:54-56) and `Enable pnpm` (:58), separated by the same single blank line the file already uses between steps (:57, :62, :67). It is list item 3 of `steps:` — all subsequent steps keep their relative order.
- **Step syntax**: `name:`, `if:`, `shell:`, `env:`, `run:` are all valid top-level keys of an actions workflow step. `if:` takes a bare expression (no `${{ }}` needed, no quotes around `startsWith(...)`), matching GitHub's documented form — and it reuses the exact predicate `startsWith(github.ref, 'refs/tags/')` the workflow already applies at :89-90, so the two conditions cannot drift apart.
- **`run: |`** is a literal block scalar; the single long line is a valid scalar (YAML has no line-length limit) and the single-line script avoids block-scalar indentation pitfalls entirely.
- **Nothing else changes**: the pair only inserts a step between two unchanged existing lines; triggers (:3-7), permissions (:9-10, :21-23), env (:12-15), the matrix (:24-47), and every existing step from checkout (:50) through Upload artifacts (:94-99) are untouched, including all secrets usage (:77-83, :91-93).

## 6. Dispatch-path analysis

- On `workflow_dispatch` the ref is a branch (e.g. `refs/heads/main`), so `startsWith(github.ref, 'refs/tags/')` is false and the step is **skipped** — zero effect on the dispatch path.
- This is deliberately the same predicate the publish step already uses to degrade itself to `--publish never` on dispatch (:89-90, comment :84-87). A dispatch run therefore behaves exactly as before: full build, artifacts uploaded (:94-99), no publish.
- On a tag push both the guard and `--publish always` activate under the identical condition — a mismatched tag can no longer reach the publish command at all.

## 7. Parent verification checklist (structural only — CI validates on the next push)

1. **Uniqueness**: search release.yml for the exact `old_string` — it must match exactly once (the second setup-node block at :63-66 contains `cache: pnpm`, so it does not match). Verified in this tree; re-verify with a grep before applying.
2. **Apply + parse**: apply the pair, then confirm the workflow file still parses as YAML (e.g. `node -e "require('js-yaml')"` if available, or GitHub's `actionlint` if present — do not run pnpm/vitest). Structural spot-check: the new step appears between the first `setup-node` and `Enable pnpm`, with no tabs and consistent 2-space-per-level indentation.
3. **No collateral diff**: `git diff` on `.github/workflows/release.yml` must show ONLY the inserted step (one contiguous hunk); trigger lines, secrets lines, and publish command byte-identical.
4. **Script sanity** (optional, local-only): `node -e` snippet against the current `package.json` with `GITHUB_REF_NAME=v1.2.0` should exit 0 and print the match line; with `GITHUB_REF_NAME=v9.9.9` it should exit 1 with the mismatch message. Pure stdlib, no install needed.
5. **CI is the real gate**: the guard is validated on the next tag push (pass case) — mismatch behaviour is exercised only if someone pushes a bad tag, which is precisely what the guard now prevents. Note this in the PR description.
