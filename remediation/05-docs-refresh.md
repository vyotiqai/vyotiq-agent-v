# Docs refresh — exact replacement pairs (audit finding M8, docs rot)

Generated 2026-09-10. Exact `old_string` → `new_string` pairs for every stale doc claim in
finding M8, grouped per file, in application order (sections 1–5). Each pair carries a one-line
source-evidence note.

## How to apply

- Apply each pair as an **exact-match replacement** in the named file. Every `old_string` was
  copied verbatim from the **MAIN-TREE** content on 2026-09-10 (terminal read of
  `C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V\<file>`) — or, for the two clean
  files, from the current worktree tree — and its **occurrence count in that file was verified
  programmatically** (substring counts; every count is 1, noted per pair).
- **Line endings:** `RELEASE-RUNBOOK.md` and `PRODUCTION-READINESS.md` are **CRLF**
  (verified: 230 and 129 CR==LF counts respectively); `AGENTS.md` is **LF** (97 LF, 0 CR).
  `README.md` and `landing/src/content/docs/start/install.md` pairs are single-line, so line
  endings do not matter there. Where a pair spans lines, the embedded newlines must use the
  target file's own line ending (CRLF for the two files above).
- **Em dash:** `PRODUCTION-READINESS.md`'s v1.1.1 history row contains **U+2014** (verified char
  code 8212) where terminal rendering showed a plain hyphen. Pair P3's `old_string` and the
  appended rows preserve it.
- **Minimal diffs only:** fix exactly what is listed; do not reflow or rewrite anything else.
  The runbook's in-flight edits (the renumbered verify step and the release-notes editing step)
  are deliberately untouched by these pairs.

---

## 1. `RELEASE-RUNBOOK.md` (main tree, dirty — CRLF)

### R1 — header publish target (repo name)

`old_string` (occurs 1×):

````
GitHub Releases at `vyotiqai/vyotiq-agent-v`,
````

`new_string`:

````
GitHub Releases at `vyotiqai/vyotiq-agent-v-releases`,
````

Evidence: releases publish to the releases-only repo `vyotiqai/vyotiq-agent-v-releases`
(`.github/workflows/release.yml:79`); main-tree substring count for the old text = 1,
line verified all-ASCII.

### R2 — §2 publish secret

`old_string` (occurs 1×):

````
with `GH_TOKEN: secrets.GITHUB_TOKEN`,
````

`new_string`:

````
with `GH_TOKEN: secrets.RELEASES_TOKEN`,
````

Evidence: `.github/workflows/release.yml:79` passes `GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}`;
main-tree count of `GH_TOKEN: secrets.GITHUB_TOKEN` = 1.

### R3 — §4 post-release verification API target

`old_string` (occurs 1× — disambiguated from the §7 copy by the trailing code fence and
`**Expected assets**`; newlines are CRLF):

````
gh api repos/vyotiqai/vyotiq-agent-v/releases/tags/vX.Y.Z --jq '.assets[] | [.name, .size] | @tsv'
```

**Expected assets**
````

`new_string`:

````
gh api repos/vyotiqai/vyotiq-agent-v-releases/releases/tags/vX.Y.Z --jq '.assets[] | [.name, .size] | @tsv'
```

**Expected assets**
````

Evidence: release assets live in the releases repo (live v1.1.3 verified there with all
installers + `latest*.yml`), so the `gh api` verification command must target it; the bare
command alone occurs 2× (§4 and §7) but this context-extended form occurs exactly once
(verified count = 1).

### R4 — §7 quick-reference verification API target

`old_string` (occurs 1× — three-line context; newlines are CRLF):

````
# 4. Verify the release
gh release view vX.Y.Z
gh api repos/vyotiqai/vyotiq-agent-v/releases/tags/vX.Y.Z
````

`new_string`:

````
# 4. Verify the release
gh release view vX.Y.Z
gh api repos/vyotiqai/vyotiq-agent-v-releases/releases/tags/vX.Y.Z
````

Evidence: same releases-repo target as R3; the three-line context (comment + two commands)
occurs exactly once in the main tree (verified count = 1).

### Header verification claim — no text change needed (by design)

The header claims: "Every command, workflow name, secret name, and path below was verified
against the actual `.github/workflows/release.yml`, …". That claim is false today only because
the content drifted (publish repo + token + `gh api` targets). After applying R1–R4, every
command, workflow name, and secret name in the runbook matches the current workflow files again,
so the claim becomes **true without editing it** — per the remediation instruction, the content is
made to match the claim, and the claim itself stays.

---

## 2. `README.md` (clean — worktree copy matches main tree)

### M1 — tool count 61 → 60

`old_string` (occurs 1×):

````
**61** tools
````

`new_string`:

````
**60** tools
````

Evidence: the registry has exactly 60 tools (`src/main/agent/schemas/tools.ts:974-1257`;
`tests/main/unit/toolsSchema.test.ts:67` asserts 60); grep of README.md finds `61` only on
line 7 ("- **Workspace tools** - **61** tools for read/edit/search, glob, grep,
codebase_search, list_dir, and terminal access, …"), so the bare fragment is unique.
Number-only change; surrounding wording untouched.

---

## 3. `AGENTS.md` (gitignored, main tree — LF)

### A1 — publish repo in the release-flow bullet

`old_string` (occurs 1×):

````
publishes to GitHub Releases (`vyotiqai/vyotiq-agent-v`).
````

`new_string`:

````
publishes to GitHub Releases (`vyotiqai/vyotiq-agent-v-releases`).
````

Evidence: main-tree read 2026-09-10; `vyotiqai/vyotiq-agent-v` occurs exactly once in AGENTS.md
(verified count = 1); publish target per `.github/workflows/release.yml:79` is the releases-only
repo.

### A2 — "Released so far / Next" state line

`old_string` (occurs 1×):

````
Released so far: `v1.0.0` (tag + GitHub Release exist). Next: patch bump (1.0.1) for fixes, minor (1.1.0+) for features.
````

`new_string`:

````
Released so far: `v1.0.0` -> `v1.1.3` (current), all via tag push, publishing to the releases-only repo `vyotiqai/vyotiq-agent-v-releases`. Next: patch bump (1.1.4) for fixes, minor (1.2.0+) for features.
````

Evidence: root `package.json` version = 1.1.3; `gh api repos/vyotiqai/vyotiq-agent-v/releases`
(2026-09-10) lists v1.0.0, v1.1.0, v1.1.1, v1.1.2, v1.1.3 as published — v1.1.3 is current;
the old line occurs verbatim exactly once (verified count = 1). ASCII `->` matches the file's
existing alias notation (`@shared` -> `src/shared`).

---

## 4. `PRODUCTION-READINESS.md` (main tree, dirty — CRLF)

### P1 — §4 landing "Blocked" bullet → deployed state

`old_string` (occurs 1×; full bullet byte-verified all-ASCII):

````
- **Blocked:** the workflow requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; as of 2026-09-08 both are empty in the repo, so deploy run 34254965003 failed at wrangler auth. The build itself succeeds.
````

`new_string`:

````
- **Deploying:** the workflow requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; as of 2026-09-10 both are set in the repo and deploys succeed — the live site's download CTA points at `vyotiqai/vyotiq-agent-v-releases/releases/latest`.
````

Evidence: verified 2026-09-10 state — landing deploy working, live CTA points at the releases
repo's latest release (`vyotiqai/vyotiq-agent-v-releases/releases/latest`); full bullet
byte-checked (no non-ASCII chars) and unique (verified count = 1).

### P2 — §8 known-issues item 2 → resolved

`old_string` (occurs 1×; byte-verified all-ASCII):

````
2. **Landing deploy blocked** on the two empty Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
````

`new_string`:

````
2. **Landing deploy resolved** (2026-09-10): both Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are set and deploys succeed; the live download CTA points at `vyotiqai/vyotiq-agent-v-releases/releases/latest`.
````

Evidence: same verified 2026-09-10 state as P1; the item is byte-unique in the main tree
(verified count = 1).

### P3 — §5 release-history table: add v1.1.2 and v1.1.3 rows

`old_string` (occurs 1× — note the **em dash U+2014** between "Complete" and "published"):

````
| v1.1.1 | Complete — published 2026-09-08, Release run 34254964752 success. |
````

`new_string` (the two appended rows are separated by CRLF, matching the file):

````
| v1.1.1 | Complete — published 2026-09-08, Release run 34254964752 success. |
| v1.1.2 | Complete — published 2026-09-08. Desktop update-check crash fix, blue default accent color. |
| v1.1.3 | Complete — published 2026-09-10 to the releases repo, current release. Memory tool reliability, OS-aware landing download button, accessible theme switcher, 19 accessibility findings resolved. |
````

Evidence: dates from `gh api` (2026-09-10) — v1.1.2 published 2026-09-08T18:51:14Z; v1.1.3
published 2026-09-10T02:12:25Z in `vyotiqai/vyotiq-agent-v-releases` (a 2026-09-09 copy of the
v1.1.3 release also exists in the source repo). Highlights from the untracked main-tree notes:
`scripts/tmp-release-notes-v112.md` (update-check crash fix + blue default accent) and
`scripts/tmp-release-notes-v113.md` (memory tool reliability, OS-detecting download button,
accessible theme switcher, 19 accessibility/compliance findings resolved). Row format matches the
existing table; the old row was byte-verified (em dash = char 8212) and is unique (count = 1).

---

## 5. `landing/src/content/docs/start/install.md` (clean — worktree copy matches main tree)

All seven pairs are single-line. `Vyotiq-<version>-…` matches the naming template already
documented lower on the same page (`${productName}-${version}-setup.${ext}` etc.) and in
RELEASE-RUNBOOK.md. Evidence for all seven: worktree grep finds exactly one occurrence of each
string (lines 37, 39, 40, 41, 55, 64, 72); the file is clean in the main tree.

### L1 — table header drops the pinned version

`old_string` (1×): `| Script | Target | Artifact name (1.0.0) |`
`new_string`: `| Script | Target | Artifact name |`

### L2 — Windows table row

`old_string` (1×): `` | `pnpm pack:win` | Windows NSIS | Vyotiq-1.0.0-setup.exe | ``
`new_string`: `` | `pnpm pack:win` | Windows NSIS | Vyotiq-<version>-setup.exe | ``

### L3 — macOS table row

`old_string` (1×): `` | `pnpm pack:mac` | macOS DMG | Vyotiq-1.0.0-<arch>.dmg | ``
`new_string`: `` | `pnpm pack:mac` | macOS DMG | Vyotiq-<version>-<arch>.dmg | ``

### L4 — Linux table row

`old_string` (1×): `` | `pnpm pack:linux` | Linux AppImage | Vyotiq-1.0.0.AppImage | ``
`new_string`: `` | `pnpm pack:linux` | Linux AppImage | Vyotiq-<version>.AppImage | ``

### L5 — Windows install step

`old_string` (1×): `1. Run Vyotiq-1.0.0-setup.exe from the output directory.`
`new_string`: `1. Run Vyotiq-<version>-setup.exe from the output directory.`

### L6 — macOS install step

`old_string` (1×): `1. Open Vyotiq-1.0.0-<arch>.dmg and install the application.`
`new_string`: `1. Open Vyotiq-<version>-<arch>.dmg and install the application.`

### L7 — Linux install step

`old_string` (1×): `1. Mark Vyotiq-1.0.0.AppImage executable using your desktop file manager or shell.`
`new_string`: `1. Mark Vyotiq-<version>.AppImage executable using your desktop file manager or shell.`

---

## Post-application verification checklist

- `RELEASE-RUNBOOK.md`: `vyotiqai/vyotiq-agent-v` (without `-releases`) 0×; `secrets.GITHUB_TOKEN` 0×; `secrets.RELEASES_TOKEN` 1×.
- `README.md`: the string `61` 0×; `**60** tools` present.
- `AGENTS.md`: `vyotiqai/vyotiq-agent-v` (without `-releases`) 0×; `v1.1.3` present in the "Released so far" line.
- `PRODUCTION-READINESS.md`: `Landing deploy blocked` 0×; `Landing deploy resolved` 1×; history table has v1.1.2 and v1.1.3 rows.
- `landing/src/content/docs/start/install.md`: `1.0.0` 0×.
