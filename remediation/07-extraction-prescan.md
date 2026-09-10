# M10 remediation — `tar -tf` entry pre-scan before extraction (zip-slip prevention)

- **Finding (M10):** `extractArchive` relies on the platform tar binary's defaults to refuse `..` entries. Windows bsdtar 3.8.8 refuses them (probe, round 1), but GNU tar on Linux is documented to **extract** them outside `destDir`, and `assertExtractContained` only walks `destDir`, so an escape is invisible to the backstop.
- **Fix:** PRE-SCAN the archive's entry list (`tar -tf`) inside `extractArchive` and reject any escaping entry BEFORE tar runs. `assertExtractContained` stays as the post-extract backstop.
- **Files touched:** `src/main/marketplace/install.ts` (1 pair), `tests/main/unit/marketplaceRegistryIntegrity.test.ts` (3 pairs).
- **No new dependencies.** No new imports needed (`execFileAsync`, `extname` already imported — `install.ts:15,17,51`).

All line numbers below are MAIN-TREE line numbers, verified this run by reading the main-tree files via terminal (worktree copies are stale per round-1 dirty-file rule).

---

## 1. Evidence (main tree, read this run)

### 1.1 Extraction call sites in `src/main/marketplace/install.ts`

`extractArchive` (private, not exported) at `install.ts:189-202`; every archive extraction in the file goes through it, so placing the scan **inside** `extractArchive` covers all sources with one change:

| Source branch | Call site | Notes |
|---|---|---|
| `zip` | `install.ts:534` | `await extractArchive(target, extractDir)` |
| `npm` | `install.ts:575` | npm-pack tgz via `extractArchive(tgzPath, extractDir)` |
| `registry` (zip attempt) | `install.ts:622` | download named `pkg.zip`, `extractArchive(archivePath, extractDir)` |
| `registry` (tgz retry) | `install.ts:628` | rename to `pkg.tgz`, `extractArchive(tgzPath, extractDir)` |

Non-archive sources call `assertExtractContained` directly and are unaffected by the pre-scan: `path` (`install.ts:471`), `git` clone dir (`install.ts:549`).

### 1.2 Existing containment machinery (unchanged)

- `assertExtractContained(destDir)` — `install.ts:169-187`: walks `destDir` only; rejects symlinks and realpath escapes. **Stays as the post-extract backstop.**
- `isContainmentOrSymlinkError` — `install.ts:161-164`: regex `/symlink|escaped destination|extract rejected|Archive extract/i`. The new pre-scan error message `Archive extract rejected escaping entry: <entry>` matches ("Archive extract" and "extract rejected"), so the registry retry branch (`install.ts:623-624`) rethrows it immediately **without** the rename-to-`.tgz` retry — a hostile archive is aborted on the first scan.
- Digest verification (round 1) — `install.ts:610-619` — runs before `extractArchive` in the registry branch, so the full order after this fix is: download → **sha256 verify** → **pre-scan** → extract → `assertExtractContained`. Round-1 ordering preserved; no digest-block edits.

### 1.3 Probe results (this run, local machine: bsdtar 3.8.8 / libarchive 3.8.8)

Built a plain uncompressed USTAR tarball **by hand** with entries `SKILL.md` + `../evil.txt` (a manual USTAR header with name `../evil.txt`, checksum computed over the 512-byte header), then:

```
tar -tf  <hostile>.zip  => exit 0, stdout: "SKILL.md\r\n../evil.txt\r\n"   <- LISTS the .. entry
tar -tzf <hostile>.zip  => exit 0, stdout: "SKILL.md\r\n../evil.txt\r\n"   <- (bsdtar tolerates -z on plain tar)
tar -tvf <hostile>.zip  => exit 0, long-format listing shows "../evil.txt"
tar -tf  <benign>.tgz   => exit 0, stdout: "SKILL.md\r\n"                  <- gz fixture lists with -tf too
```

Key fact: **`tar -tf` lists `..` entries even though extraction refuses them** — so the pre-scan sees hostile entries on bsdtar and rejects with a deterministic error before tar's own behavior (or GNU tar's lack of refusal) matters. The USTAR byte builder in the test below is the exact builder verified by this probe.

### 1.4 Existing tests that must keep passing

- `tests/main/unit/marketplaceSafePath.test.ts:163-170` — `isContainmentOrSymlinkError` truth table incl. `'tar: Error opening archive' => false`. New message ⇒ true, consistent.
- `tests/main/unit/marketplaceInstallSecurity.test.ts:111-140` — `assertExtractContained` unit tests. Export untouched.
- `tests/main/unit/marketplaceRegistryIntegrity.test.ts:174-198` — round-1 digest tests. The benign fixture is a real gz tgz (single entry `SKILL.md`, built at `:54-77`) named `pkg.zip` — the pre-scan (`-tf`) lists it cleanly, so **all three digest tests remain green**.

---

## 2. Design: entry-normalization + rejection rules

Scan runs once at the top of `extractArchive`, before `mkdirSync(destDir)` and before any tar extraction:

1. List entries: `execFileAsync('tar', ext === '.zip' ? ['-tf', path] : ['-tzf', path])` — the flag **mirrors the existing extract branching** (`-xf` for `.zip` at `install.ts:197`, `-xzf` otherwise at `:199`). bsdtar reads zip via `-tf`; GNU tar auto-detects compression when reading (so `-tf` on a gz tarball and `-tzf` both work), and real-zip support remains bsdtar-only — identical to today's extraction capability, so no regression.
2. Parse: split stdout on `/\r?\n/`, trim each line, skip blank lines (line-splitting noise, not entries).
3. **Normalize** each entry (`normalizeArchiveEntryName`): trim; replace `\` → `/`; strip any run of leading `./` segments.
4. **Reject** (`assertArchiveEntryNameContained`, throws `Archive extract rejected escaping entry: <raw entry>` — same `new Error(...)` style as `:177,:181`, and matched by `isContainmentOrSymlinkError`) if the normalized name:
   - is **empty** (fail-closed; e.g. an entry that was just `./`),
   - contains a `..` **path segment** (`name.split('/').includes('..')` — catches `../evil.txt`, `..`, `a/../b`, and backslash forms after normalization),
   - starts with `/` (POSIX-absolute and UNC `\\…` after normalization), or
   - matches `/^[A-Za-z]:/` (Windows drive letter, incl. drive-relative `C:x`).

**Scope choice (documented, per the corrected round-1 comment at `install.ts:192-195`):** bsdtar refuses `..` and *sanitizes* absolute entries (drive letter stripped, contained under destDir). The pre-scan rejects `..` and true-absolute names **fail-closed** — the guarantee must not depend on which tar implementation runs. A bare `.` entry (explicit archive root, normalizes to `.` not empty) is **allowed**; an entry that normalizes to empty (`./`) is rejected as malformed.

**Structural reasoning — why this closes the hole:** `assertExtractContained` can only see what lands *inside* `destDir`; GNU tar writes `../evil.txt` to `destDir/../evil.txt`, outside its walk, so the backstop is structurally blind to exactly the case it must catch. The pre-scan inverts the direction of proof: instead of inspecting the filesystem *after* writes (which may already have escaped), it inspects the *declared names* *before* any write occurs. Every write tar performs is addressed by an entry name from the list; if no listed name can address anything outside `destDir` (no `..` segment, not absolute, no drive letter), no write can land outside `destDir` — regardless of tar implementation, symlink contents, or platform path semantics. The backstop remains for defense in depth (symlinks inside the archive that resolve outward, which list-mode alone doesn't classify).

**Perf note (required):** the pre-scan adds one bounded, one-shot `tar -tf` subprocess per `extractArchive` call, reading the already-downloaded local archive (marketplace packages are small). Extraction already spawns one tar per archive; worst case (registry zip→tgz retry, which now aborts before retrying on containment errors) is one extra scan. No network, no unbounded work — acceptable.

---

## 3. Pair 1 — `src/main/marketplace/install.ts`

One contiguous pair: inserts `normalizeArchiveEntryName` + `assertArchiveEntryNameContained` (exported, `@internal`, for unit tests — same convention as `assertExtractContained` at `install.ts:168-169`) + `assertArchiveEntriesContained` (private), updates the now-stale tar comment (its "it refuses `..` entry paths" claim is exactly finding M10), and wires the scan into the top of `extractArchive`.

`old_string` is unique (`walk(destDir)` occurs once; em-dashes are literal `—`, verified via byte-exact read of main-tree lines).

### old_string

```ts
  walk(destDir)
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  mkdirSync(destDir, { recursive: true })
  const ext = extname(archivePath).toLowerCase()
  // Prefer tar/libarchive for zip and tgz — it refuses `..` entry paths and sanitizes
  // absolute entries (drive letter stripped, contained under destDir); the
  // assertExtractContained call below is the post-extract backstop.
  // Avoid Expand-Archive / unzip which do not enforce zip-slip containment.
  if (ext === '.zip') {
```

### new_string

```ts
  walk(destDir)
}

/** Normalize a tar-listed entry name: backslashes and leading `./` are packaging variance. */
function normalizeArchiveEntryName(entry: string): string {
  return entry.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '')
}

/**
 * @internal Exported for unit tests — archive entry pre-scan gate. Rejects
 * `..` path segments and true-absolute names (leading `/`, UNC `\\`, drive
 * letter) before tar runs: bsdtar refuses `..` entries itself, but GNU tar
 * (Linux) extracts them outside destDir where assertExtractContained cannot
 * see them. Absolute entries are rejected fail-closed even though tar
 * sanitizes them; an entry that is empty after normalization is malformed.
 */
export function assertArchiveEntryNameContained(entry: string): void {
  const name = normalizeArchiveEntryName(entry)
  if (!name || name.split('/').includes('..') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new Error(`Archive extract rejected escaping entry: ${entry}`)
  }
}

/**
 * Pre-scan an archive's entry list with `tar -tf` and reject any entry that
 * would extract outside destDir, BEFORE extraction (the zip-vs-tgz flag
 * mirrors the extract branching in extractArchive). One bounded, one-shot
 * subprocess per archive. assertExtractContained remains the post-extract
 * backstop (symlinks, realpath escapes inside destDir).
 */
async function assertArchiveEntriesContained(archivePath: string): Promise<void> {
  const ext = extname(archivePath).toLowerCase()
  const { stdout } = await execFileAsync(
    'tar',
    ext === '.zip' ? ['-tf', archivePath] : ['-tzf', archivePath]
  )
  for (const line of stdout.split(/\r?\n/)) {
    const entry = line.trim()
    if (!entry) continue
    assertArchiveEntryNameContained(entry)
  }
}

async function extractArchive(archivePath: string, destDir: string): Promise<void> {
  await assertArchiveEntriesContained(archivePath)
  mkdirSync(destDir, { recursive: true })
  const ext = extname(archivePath).toLowerCase()
  // Prefer tar/libarchive for zip and tgz — the pre-scan above refuses `..`
  // entry paths up front (bsdtar also refuses them, but GNU tar on Linux
  // extracts them) and tar sanitizes absolute entries; the
  // assertExtractContained call below is the post-extract backstop.
  // Avoid Expand-Archive / unzip which do not enforce zip-slip containment.
  if (ext === '.zip') {
```

---

## 4. Pairs 2-4 — `tests/main/unit/marketplaceRegistryIntegrity.test.ts`

Fixture strategy (robust cross-platform): the hostile archive's bytes are **built by hand** (USTAR headers + payload, verified by this run's probe) because `tar -cf` refuses to *create* `..` member names portably (bsdtar and GNU tar both reject them at creation time), and `--transform`-style flags differ between bsdtar and GNU tar. The builder is pure JS — no tar behavior involved in constructing the fixture. It is served through the registry download mock as an **uncompressed** tarball named `pkg.zip` (same download naming as the benign round-1 fixture at `:608`; `tar -tf`/`-xf` auto-detect the format on both bsdtar and GNU tar).

### Pair 2 — fixture builder + hostile archive variable (after `archiveSha256`, before `beforeAll`)

`old_string` is unique (`let archiveBytes` occurs once, at `test:51-52`).

#### old_string

```ts
let archiveBytes: Buffer = Buffer.alloc(0)
let archiveSha256 = ''
```

#### new_string

```ts
let archiveBytes: Buffer = Buffer.alloc(0)
let archiveSha256 = ''

let hostileArchiveBytes: Buffer = Buffer.alloc(0)

/** Build one 512-byte USTAR header for a regular file (checksum included). */
function ustarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512)
  buf.write(name, 0, 100, 'utf8')
  buf.write('0000644\0', 100)
  buf.write('0000000\0', 108)
  buf.write('0000000\0', 116)
  buf.write(size.toString(8).padStart(11, '0') + '\0', 124, 12)
  buf.write('00000000000\0', 136, 12)
  buf.write('        ', 148, 8)
  buf.write('0', 156, 1)
  buf.write('ustar\0', 257, 6)
  buf.write('00', 263, 2)
  let sum = 0
  for (const byte of buf) sum += byte
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8)
  return buf
}

/**
 * Pack entries into an uncompressed USTAR tarball by hand. `tar -cf` cannot
 * portably create `..` member names (bsdtar and GNU tar both refuse them at
 * creation), so the hostile fixture's bytes are constructed directly.
 */
function ustarArchive(entries: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = []
  for (const entry of entries) {
    parts.push(ustarHeader(entry.name, entry.data.length), entry.data)
    const pad = (512 - (entry.data.length % 512)) % 512
    if (pad) parts.push(Buffer.alloc(pad))
  }
  parts.push(Buffer.alloc(1024))
  return Buffer.concat(parts)
}
```

### Pair 3 — build the hostile fixture in `beforeAll` (after the benign tgz fixture's `finally`)

`old_string` is unique (the `rmSync(srcDir, ...)` finally appears once, at `test:74-77`).

#### old_string

```ts
  } finally {
    rmSync(srcDir, { recursive: true, force: true })
  }
})
```

#### new_string

```ts
  } finally {
    rmSync(srcDir, { recursive: true, force: true })
  }

  // Hostile fixture: plain USTAR tarball carrying a `../evil.txt` member next
  // to a valid skill root. Served through the registry download mock as
  // pkg.zip; `tar -tf` lists both members so the pre-scan sees the escape.
  hostileArchiveBytes = ustarArchive([
    {
      name: 'SKILL.md',
      data: Buffer.from(
        `---\nname: ${PKG_ID}\ndescription: Hostile archive fixture.\n---\n\nInstructions.\n`,
        'utf8'
      )
    },
    { name: '../evil.txt', data: Buffer.from('escaped\n', 'utf8') }
  ])
})
```

### Pair 4 — new describe block (append at end of file, after the `refreshRemoteCatalog` describe)

`old_string` is unique (final lines of the file, `test:223-229`). Imports needed are already present: `dirname` (`test:7`), `existsSync`/`writeFileSync`/`rmSync` (`test:4`).

#### old_string

```ts
      expect(fetchMock).not.toHaveBeenCalled()
      expect(catalog.packages.map((p) => p.id)).toEqual(['cached-skill'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
```

#### new_string

```ts
      expect(fetchMock).not.toHaveBeenCalled()
      expect(catalog.packages.map((p) => p.id)).toEqual(['cached-skill'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('archive entry pre-scan', () => {
  it('rejects escaping entry names', async () => {
    const { assertArchiveEntryNameContained } = await import('@main/marketplace/install')
    expect(() => assertArchiveEntryNameContained('../evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('..\\evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('package/../evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('/etc/passwd')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('C:\\evil.txt')).toThrow(/escaping entry/i)
    expect(() => assertArchiveEntryNameContained('./')).toThrow(/escaping entry/i)
  })

  it('accepts contained entry names', async () => {
    const { assertArchiveEntryNameContained } = await import('@main/marketplace/install')
    expect(() => assertArchiveEntryNameContained('SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('package/SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('./package/SKILL.md')).not.toThrow()
    expect(() => assertArchiveEntryNameContained('sub/dir/')).not.toThrow()
  })

  it('aborts the registry install before extraction when an archive entry escapes destDir', async () => {
    downloadMock.mockImplementation(async (_url: string, destPath: string) => {
      writeFileSync(destPath, hostileArchiveBytes)
    })
    await expect(installFromRegistry()).rejects.toThrow(/rejected escaping entry/i)
    expect(downloadMock).toHaveBeenCalledTimes(1)
    // The pre-scan aborts before tar runs: no extract dir, and no escaped
    // file next to it. installMarketplacePackage does not run the temp-tree
    // cleanup on this abort path (pre-existing behavior, same as post-extract
    // containment aborts), so tidy the leaked temp tree up ourselves.
    const destPath = downloadMock.mock.calls[0]?.[1] as string
    const tmpRoot = dirname(destPath)
    try {
      expect(existsSync(join(tmpRoot, 'evil.txt'))).toBe(false)
      expect(existsSync(join(tmpRoot, 'extract'))).toBe(false)
    } finally {
      rmSync(tmpRoot, { recursive: true, force: true })
    }
  })
})
```

**Why this test proves the fix end-to-end:** the fixture would otherwise be a perfectly installable skill package (valid `SKILL.md` at the archive root, same shape as the benign fixture at `test:54-77`), and the escape (`../evil.txt`) resolves to `<tmp>/evil.txt`, one level above `extract/`. On GNU tar/Linux (pre-fix) the install would succeed and write `evil.txt` where `assertExtractContained` never looks; on bsdtar (pre-fix) tar itself fails with an opaque error. Post-fix both platforms abort deterministically with `Archive extract rejected escaping entry: ../evil.txt`, before `mkdirSync(destDir)` even creates the extract dir — asserted directly.

---

## 5. Parent verification checklist

Apply pairs in order (1 → 2 → 3 → 4) with `str_replace`; each `old_string` is unique against the **main-tree** content (install.ts including round-1 edits; the round-1-new test file). Em-dashes in Pair 1's `old_string` are literal `—` (U+2014) — verified byte-exact this run.

1. `git status` clean before applying; apply Pair 1 to `src/main/marketplace/install.ts`, Pairs 2-4 to `tests/main/unit/marketplaceRegistryIntegrity.test.ts`.
2. Typecheck: `pnpm typecheck` (or repo equivalent) — PASS.
3. Lint: `pnpm lint` — PASS (formatting in the pairs already matches `.prettierrc.yaml`: singleQuote, semi:false, printWidth:100).
4. Marketplace suites (must all stay green):
   - `tests/main/unit/marketplaceRegistryIntegrity.test.ts` — old 3 digest tests + new 3 pre-scan tests.
   - `tests/main/unit/marketplaceInstallSecurity.test.ts` — `assertExtractContained` untouched.
   - `tests/main/unit/marketplaceSafePath.test.ts` — `isContainmentOrSymlinkError` table still valid.
5. Full `pnpm test` (per local-gate memory note: the 40-min valve kill ≠ test failure).

## 6. Caveats / out of scope

- Real-zip listing on GNU tar is impossible (GNU tar never reads zip) — pre-existing: extraction `-xf` fails the same way, so the registry zip→tgz retry path and the `.zip` source on Linux were already bsdtar-only. No behavior change introduced.
- The temp-tree leak when `extractArchive` aborts with a containment error (registry branch rethrows at `install.ts:624` without `cleanup()`) is pre-existing and unchanged; fixing it would alter shared abort semantics for post-extract containment errors too — deliberately left out of this minimal fix.
- An explicit `.` archive-root entry is allowed (normalizes to `.`); `./` normalizes to empty and is rejected (fail-closed). Documented in the helper's doc comment.
