# 04 — Agent core fixes: M2 `deleteRun` TOCTOU re-check + M3 guarded events-archive unlink

Deliverable for audit findings **M2** and **M3** of `AUDIT-REPORT-2026-09-10.md` (:101–104 and :106–108).
This run was **read-only**: no source or test file was modified. Every fix below is an exact
`old_string` → `new_string` pair (verbatim from the current tree, re-read this run; each
`old_string` verified unique in its file). Tests are given as exact insertion pairs plus full
contents of each new/extended `it` block. Vitest was **not** run in this worktree (no
`node_modules`); the verification checklist in §5 is the parent's gate.

---

## 1. Findings (recap, evidence re-verified this run)

**M2 — `deleteRun` TOCTOU** (`AUDIT-REPORT-2026-09-10.md:101-104`):
`src/main/agent/state.ts:1348` `deleteRun` checks `if (isActive(runId))` at :1352-1354, then
performs several `await`s — `collectRunsFromRoot` at :1363, per-child
`finalizeInlineInstanceWorktreeBestEffort` at :1372-1375, `drainRunWritersBeforeDelete(dir)` at
:1387 — before `rmSync(dir, { recursive: true, force: true })` at :1388.
`tryRegisterRunAbort` (`src/main/agent/runRegistry.ts:150-172`) is an atomic check+set with no
`await` inside, so a new `chatStart` for the same `runId` can be admitted during those awaits and
the directory is then deleted under a live run.

**M3 — unguarded events-archive unlink** (`AUDIT-REPORT-2026-09-10.md:106-108`):
`src/main/agent/eventAppendQueue.ts:90-97` — `enforceArchiveCap` does `await unlink(join(dir,
oldest))` at :95 with **no** try/catch. It runs inside the serialized append chain
(`enqueueEventAppend` :174 → `rotateEventsFileIfNeeded` → `archiveDiscardedHead` →
`enforceArchiveCap` at :101) under `withTransientAppendRetry`, so one persistently undeletable
archive (EBUSY/EPERM on Windows) fails **every** subsequent event append and surfaces as a
`PERSIST` failure. The messages queue guards the identical operation at
`src/main/agent/messageAppendQueue.ts:172-180` ("best effort — an undeletable archive must not
block the append chain"), and `eventAppendQueue.ts:80-88` (`removeEventArchives`) already guards
the same call shape for rewrites ("best effort — an undeletable archive must not fail the
rewrite", :85).

---

## 2. Fix A — `src/main/agent/state.ts` (M2): `isActive` re-check immediately before `rmSync`

Mirror of the entry guard's exact failure shape (`{ ok: false, error: 'Cancel run first' }`,
state.ts:1352-1354). `isActive` is already imported (`src/main/agent/state.ts:53`). No registry
tombstone refactor, per contract. Because `rmSync` is synchronous on the main thread, this
re-check fully closes the await window between the entry guard and the delete.

### Pair A1 (unique in file: `rmSync(dir, …)` at :1388 is the only two-space-indent `rmSync(dir, …)`; the child delete at :1378 is `rmSync(childDir, …)`)

```ts
// old_string
  await drainRunWritersBeforeDelete(dir)
  rmSync(dir, { recursive: true, force: true })

// new_string
  await drainRunWritersBeforeDelete(dir)
  // M2: a chatStart can register this runId (tryRegisterRunAbort) during the
  // awaits above — re-check so the directory is never deleted under a live run.
  if (isActive(runId)) {
    return { ok: false, error: 'Cancel run first' }
  }
  rmSync(dir, { recursive: true, force: true })
```

**Behavior:** if a run registered mid-delete, `deleteRun` now returns
`{ ok: false, error: 'Cancel run first' }` — the exact shape the entry guard and the IPC contract
already produce — and the directory, `dismissRunLifecycleInbox` and `invalidateListRunsCache` are
left untouched for the live run.

**Intentionally out of scope (residual, noted for the audit trail):** child-instance dirs deleted
in the loop at :1377-1378 sit behind their own awaits (:1372-1375) and only the collective
`children.some((c) => isActive(c.runId))` check at :1365-1367. A per-child re-check would need
the same one-liner inside the loop; the contract asked for the minimal `runId`-level re-check
only.

---

## 3. Fix B — `src/main/agent/eventAppendQueue.ts` (M3): guarded, best-effort `unlink` in `enforceArchiveCap`

Same semantics as `messageAppendQueue.ts:172-180` (try/catch → skip-and-log), with the warning
logged in this file's own style — `logger.warn('Failed to append events.jsonl', { scope: 'state',
correlationId: basename(dir), err })` at eventAppendQueue.ts:187-191, plus `filename` as used by
the `EVENTS_ARCHIVED` info log. Retry semantics for every other operation are untouched: the
guard lives inside `enforceArchiveCap` only, so `withTransientAppendRetry` still governs the
rotate+append body.

Loop safety: `archives.shift()` at :93 shrinks the array before the unlink attempt, so a
persistently undeletable oldest archive cannot spin the `while` at :92 — the cap just stays
exceeded by one file until a later rotation succeeds (identical to the messages queue).

### Pair B1 (unique in file: `enforceArchiveCap` is the only function containing `unlink(join(dir, oldest))` — `removeEventArchives` at :80-88 uses `unlink(join(dir, name))`)

```ts
// old_string
async function enforceArchiveCap(dir: string): Promise<void> {
  const archives = await listEventArchives(dir)
  while (archives.length >= MAX_EVENT_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    await unlink(join(dir, oldest))
  }
}

// new_string
async function enforceArchiveCap(dir: string): Promise<void> {
  const archives = await listEventArchives(dir)
  while (archives.length >= MAX_EVENT_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    try {
      await unlink(join(dir, oldest))
    } catch (err) {
      // best effort — an undeletable archive must not block the append chain
      logger.warn('Failed to delete oldest events archive', {
        scope: 'state',
        correlationId: basename(dir),
        filename: oldest,
        err
      })
    }
  }
}
```

---

## 4. Tests

### 4.1 `tests/main/unit/eventAppendQueue.test.ts` — extend (existing file)

The file already partially mocks `fs/promises` (the exact specifier the queue imports —
`eventAppendQueue.ts:2` imports `unlink` from `'fs/promises'`), intercepting only `appendFile`
(test file :15-24). We add `unlinkMock` the same way, then a test proving an undeletable oldest
archive does **not** fail the append chain.

**Why EPERM and not EBUSY in the new test:** `TRANSIENT_APPEND_ERROR_CODES`
(`src/main/agent/appendRetry.ts:11-18`) contains EAGAIN/EBUSY/EMFILE/ENFILE/EDEADLK/ETIMEDOUT —
**not** EPERM. `withTransientAppendRetry` (appendRetry.ts:40-56) therefore does not retry it, so
pre-fix the chain fails deterministically on the first attempt (no retry loop, no delays) and the
test cleanly discriminates fixed vs. unfixed. Error construction follows the file's existing
convention (`Object.assign(new Error(…), { code: 'EBUSY' })`, test file :172-175).

#### Pair T1 — widen the hoisted mock (test file :15-24; the block is unique)

```ts
// old_string
const { appendFileMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn<typeof import('fs/promises').appendFile>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  appendFileMock.mockImplementation(actual.appendFile)
  return {
    ...actual,
    appendFile: appendFileMock
  }
})

// new_string
const { appendFileMock, unlinkMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn<typeof import('fs/promises').appendFile>(),
  unlinkMock: vi.fn<typeof import('fs/promises').unlink>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  appendFileMock.mockImplementation(actual.appendFile)
  unlinkMock.mockImplementation(actual.unlink)
  return {
    ...actual,
    appendFile: appendFileMock,
    unlink: unlinkMock
  }
})
```

#### Pair T2 — clear the new mock in `beforeEach` (the two-line sequence `resetEventAppendQueueForTests()` + `appendFileMock.mockClear()` occurs only in `beforeEach`, :34-35)

```ts
// old_string
    resetEventAppendQueueForTests()
    appendFileMock.mockClear()
  })

// new_string
    resetEventAppendQueueForTests()
    appendFileMock.mockClear()
    unlinkMock.mockClear()
  })
```

#### Pair T3 — insert the new test directly after the existing cap test (anchor is the cap test's closing lines, :142-144 — `newestArchive` appears nowhere else)

```ts
// old_string
    const newestArchive = readFileSync(join(dir, archives[archives.length - 1]!), 'utf8')
    expect(newestArchive).toContain('y'.repeat(64))
  })

// new_string
    const newestArchive = readFileSync(join(dir, archives[archives.length - 1]!), 'utf8')
    expect(newestArchive).toContain('y'.repeat(64))
  })

  it('skips an undeletable oldest archive instead of failing the append chain', async () => {
    const path = join(dir, 'events.jsonl')
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `events.archive.2026-01-0${i + 1}T00-00-00-000Z.jsonl`), `archive-${i}\n`, 'utf8')
    }
    const line = `${'y'.repeat(80)}\n`
    writeFileSync(
      path,
      line.repeat(Math.ceil((EVENTS_FILE_MAX_BYTES + 64) / line.length)),
      'utf8'
    )

    // Non-transient (EPERM is absent from TRANSIENT_APPEND_ERROR_CODES), so
    // withTransientAppendRetry cannot mask the missing guard: pre-fix this
    // rejection fails the append chain on the first attempt.
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))

    enqueueEventAppend(dir, { type: 'status', status: 'undeletable-archive' })
    await expect(flushEventAppends(dir)).resolves.toBeUndefined()
    expect(takeEventAppendFailureNotice(dir)).toBeUndefined()

    const active = readFileSync(path, 'utf8')
    expect(active).toContain('undeletable-archive')
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith('events.archive.'))
      .sort()
    // The undeletable oldest archive survives; the new one is still created.
    expect(archives).toHaveLength(6)
    expect(archives.some((name) => name.includes('2026-01-01'))).toBe(true)
  })
```

**What the new test proves (fixture mechanics, all verified against current code):**
5 pre-seeded archives + an oversized `events.jsonl` force rotation on the next append
(`rotateEventsFileIfNeeded`, eventAppendQueue.ts:117-165) → `archiveDiscardedHead` (:99-114) →
`enforceArchiveCap` (:90-97) unlinks the oldest (`events.archive.2026-01-01…`, first `unlink`
call of the test). With the fix: the EPERM is swallowed + logged, the rotation completes, the
append lands, `flushEventAppends` resolves, no failure notice exists, and the dir holds 6
archives including the undeletable one. Pre-fix: the rejection propagates out of
`withTransientAppendRetry` (no retry — EPERM non-transient), `enqueueEventAppend`'s catch
(:181-191) records it via `recordAppendError` (:31-34), `flushEventAppends(dir)` rejects and
`takeEventAppendFailureNotice(dir)` returns an error — the test fails at its first assertion.

### 4.2 `tests/main/unit/deleteRunNotifications.test.ts` — extend (existing file; feasibility statement below)

**Feasibility (contract task 3):** `glob tests/**/*{state,runRegistry}*.test.ts` → **no matches**
(no dedicated `state`/`runRegistry` unit suite exists). The only other `deleteRun` tests live in
`tests/main/unit/agentInstances.test.ts` (:868, :891) inside a heavy inline-instance harness
(`spawnAgentInstance`, git worktrees, mocked `startAgentRun`) — extending that harness to inject a
mid-delete registration would be invasive. `tests/main/unit/deleteRunNotifications.test.ts` is the
existing focused `deleteRun` suite and already has everything the re-check test needs: an `electron`
mock whose `app.getPath('userData')` returns a temp dir (:39-50, required because
`resolveRunDir` → `workspaceSessionsRoot` → `userDataRoot` calls `app.getPath('userData')`,
`src/main/storage/paths.ts:1,17-19,36-39,78-79`), per-test temp workspaces, and `createRun` /
`deleteRun` imports (:75). So: **extend this file** rather than create a new one — light
scaffolding only.

The test controls `isActive` via a partial mock of `@main/agent/runRegistry` (state.ts imports
only `isActive` from that module, `src/main/agent/state.ts:53`; the spread keeps every other export
real). Vitest keys mocks on the resolved module path, so the alias-based `vi.mock` applies to
state.ts's relative `'./runRegistry'` import. The once-implementation sequence is set **after**
`createRun`, because the entry guard must be the mock's first call — verified that neither
`createRun` nor the notifications modules call `isActive` (state.ts's only `isActive` call sites are
:1194, :1325, :1352, :1365, :1431 — none inside `createRun`). With no children and a
non-inline status, `deleteRun` calls `isActive` exactly twice: entry guard (:1352) and the new
re-check.

#### Pair D1 — add `isActiveMock` to the hoisted destructure (line :11, unique)

```ts
// old_string
const { send, windowState, settingsState, MockNotification } = vi.hoisted(() => {

// new_string
const { send, windowState, settingsState, MockNotification, isActiveMock } = vi.hoisted(() => {
```

#### Pair D2 — return it from the hoisted block (:29-37, unique)

```ts
// old_string
  return {
    send: vi.fn(),
    windowState: { focused: false, minimized: false },
    settingsState: { current: null as Settings | null },
    MockNotification
  }
})

// new_string
  return {
    send: vi.fn(),
    windowState: { focused: false, minimized: false },
    settingsState: { current: null as Settings | null },
    MockNotification,
    isActiveMock: vi.fn<typeof import('@main/agent/runRegistry').isActive>()
  }
})
```

#### Pair D3 — register the partial runRegistry mock (after the settings mock, :52-54; anchor unique)

```ts
// old_string
vi.mock('@main/settings/settings', () => ({
  getSettings: () => settingsState.current ?? { ...DEFAULT_SETTINGS }
}))

// new_string
vi.mock('@main/settings/settings', () => ({
  getSettings: () => settingsState.current ?? { ...DEFAULT_SETTINGS }
}))

vi.mock('@main/agent/runRegistry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/agent/runRegistry')>()
  return {
    ...actual,
    isActive: isActiveMock
  }
})
```

#### Pair D4 — import `resolveRunDir` (import line :75, unique)

```ts
// old_string
import { createRun, deleteRun } from '@main/agent/state'

// new_string
import { createRun, deleteRun } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'
```

#### Pair D5 — reset the mock in `beforeEach` (:70-71, sequence unique)

```ts
// old_string
    send.mockReset()
    MockNotification.instances = []

// new_string
    send.mockReset()
    isActiveMock.mockReset().mockImplementation(() => false)
    MockNotification.instances = []
```

The default `() => false` keeps the file's two existing tests byte-for-byte behavior-identical
(their runs are inactive; `children.some((c) => isActive(c.runId))` at state.ts:1365 also reads
`false`). `tests/setup.ts` runs `vi.clearAllMocks()` in `afterEach`, so the base implementation
is re-armed per test here.

#### Pair D6 — insert the new test at the end of the describe block (anchor = last lines of the second test, :176-179, unique)

```ts
// old_string
    const deleted = await deleteRun(workspace, parentId)
    expect(deleted.ok).toBe(true)
    expect(listNotifications().items).toHaveLength(0)
  })
})

// new_string
    const deleted = await deleteRun(workspace, parentId)
    expect(deleted.ok).toBe(true)
    expect(listNotifications().items).toHaveLength(0)
  })

  it('does not delete a run that becomes active during deletion', async () => {
    const runId = 'run-active-mid-delete'
    createRun(workspace, runId, 'Becomes active mid-delete')
    const runDir = resolveRunDir(workspace, runId)
    expect(existsSync(runDir)).toBe(true)

    // Call 1 = deleteRun's entry guard; call 2 = the isActive re-check added
    // immediately before rmSync. tryRegisterRunAbort (runRegistry.ts:150) can
    // admit the same runId during the awaits between the two checks.
    isActiveMock
      .mockImplementationOnce(() => false)
      .mockImplementationOnce(() => true)

    const result = await deleteRun(workspace, runId)

    expect(result).toEqual({ ok: false, error: 'Cancel run first' })
    expect(existsSync(runDir)).toBe(true)
  })
})
```

**Full new test content is the `it('does not delete a run that becomes active during deletion',
…)` block above** (inserted into the existing `describe('deleteRun dismisses run inbox items')`).

**What it proves / discrimination:** with the fix, the entry guard returns `false`, the re-check
returns `true`, and `deleteRun` yields the exact entry-guard failure shape
(`state.ts:1352-1354`) with the directory intact. Pre-fix, `deleteRun` calls `isActive` only
once, so the second once-implementation never fires, the delete proceeds, `result` is
`{ ok: true }` and the directory is gone — both assertions fail. Cleanup: the run dir lives
under the mocked `userData` (via `workspaceSessionsRoot`), which the file's `afterEach` already
removes (:93-96); `workspace` temp dir removal is unchanged.

**Why the walk tolerates the fixture:** `createRun` writes a valid parent `status.json`
(non-inline), so `deleteRun`'s `collectRunsFromRoot` (state.ts:926-992) parses it, finds no
instances with `parentRunId === runId` (children empty → the `children.some` guard at :1365
never touches the mock), and `drainRunWritersBeforeDelete` (state.ts:1407-1423) is best-effort
on the empty queues.

---

## 5. Parent verification checklist

Worktree for this run lacks `node_modules` — run everything below in the main checkout (or a
worktree with deps installed) **after applying the pairs**.

1. **Apply pairs in this order:** A1 (state.ts), B1 (eventAppendQueue.ts), then T1→T2→T3
   (eventAppendQueue.test.ts) and D1→D6 (deleteRunNotifications.test.ts). Each `old_string`
   must match exactly once — if any matches twice, stop and re-derive.
2. **Uniqueness sanity (fast):** `grep -n "rmSync(dir, {" src/main/agent/state.ts` → exactly one
   hit (:1388); `grep -n "unlink(join(dir, oldest))" src/main/agent/eventAppendQueue.ts` →
   exactly one hit (:95).
3. **Targeted suites (must pass):**
   - `pnpm vitest run tests/main/unit/eventAppendQueue.test.ts`
   - `pnpm vitest run tests/main/unit/deleteRunNotifications.test.ts`
   - `pnpm vitest run tests/main/unit/checkpointCoverageExtras.test.ts` (contract-named;
     exercises state/queue persistence paths)
4. **Regression neighbours (must pass):** `pnpm vitest run tests/main/unit/agentInstances.test.ts
   tests/main/unit/atomicPersistence.test.ts tests/main/unit/listRunsCache.test.ts
   tests/main/unit/agentLoopAbort.test.ts` (all import `@main/agent/state` and/or the append
   queues; verified import sites this run).
5. **Negative controls (strongly recommended, one at a time, then revert):**
   - Revert B1 only → the new eventAppendQueue test must **fail** (flush rejects, notice
     present, archives count differs).
   - Revert A1 only → the new deleteRunNotifications test must **fail** (`{ ok: true }`, dir
     gone).
6. **Types/lint:** `pnpm typecheck` and `pnpm lint` (new test code uses only imports/mocks
   already present in both files; `vi.fn<typeof import(...)>` matches the existing hoisted-mock
   typing convention at eventAppendQueue.test.ts:16).
7. **Full gate:** `pnpm test` (see workspace memory: a 40-min valve kill is a timeout artifact,
   not necessarily a test failure — re-run targeted suites if the full run is killed).

---

## 6. Evidence appendix (all verified this run)

| Claim | Evidence |
|---|---|
| M2 finding text | AUDIT-REPORT-2026-09-10.md:101-104 |
| M3 finding text | AUDIT-REPORT-2026-09-10.md:106-108 |
| `deleteRun` entry guard + failure shape | src/main/agent/state.ts:1348-1358 |
| Await window (collect/finalize/drain) before `rmSync(dir)` | src/main/agent/state.ts:1363, 1372-1375, 1387; `rmSync(dir, …)` :1388 |
| `isActive` import | src/main/agent/state.ts:53 |
| `tryRegisterRunAbort` atomic check+set | src/main/agent/runRegistry.ts:150-172 |
| Unguarded `unlink(join(dir, oldest))` | src/main/agent/eventAppendQueue.ts:90-97 (unlink at :95) |
| Same call already guarded for rewrites | src/main/agent/eventAppendQueue.ts:80-88 (comment :85) |
| Messages-queue best-effort precedent | src/main/agent/messageAppendQueue.ts:172-180 |
| Append chain + failure recording | src/main/agent/eventAppendQueue.ts:99-114, 174-191 (`recordAppendError` :31-34) |
| Transient codes (no EPERM) + retry policy | src/main/agent/appendRetry.ts:11-18, 40-56 |
| Queue imports `unlink` from `'fs/promises'` | src/main/agent/eventAppendQueue.ts:2 |
| Existing partial `fs/promises` mock | tests/main/unit/eventAppendQueue.test.ts:15-24 |
| `beforeEach` mock-clear anchor | tests/main/unit/eventAppendQueue.test.ts:34-35 |
| Cap-test insertion anchor | tests/main/unit/eventAppendQueue.test.ts:142-144 |
| EBUSY error-construction convention | tests/main/unit/eventAppendQueue.test.ts:172-175 |
| No `state*`/`runRegistry*` unit test file exists | glob `tests/**/*{state,runRegistry}*.test.ts` → no matches |
| Existing `deleteRun` suite + electron mock | tests/main/unit/deleteRunNotifications.test.ts:10-96 (imports :75, hoisted :11-37, electron mock :39-50, beforeEach :64-72, afterEach userData cleanup :93-96) |
| Heavy-harness `deleteRun` tests (not extended) | tests/main/unit/agentInstances.test.ts:868, :891 |
| `resolveRunDir` requires `app.getPath('userData')` | src/main/storage/paths.ts:1, :17-19, :36-39, :78-79 |
| `collectRunsFromRoot` tolerates bad/missing status | src/main/agent/state.ts:926-992 (per-entry catch :984-990) |
| `drainRunWritersBeforeDelete` best-effort | src/main/agent/state.ts:1407-1423 |
| state.ts `isActive` call sites (none in `createRun`) | src/main/agent/state.ts:1194, :1325, :1352, :1365, :1431 (grep) |
| Vitest env/aliases/setup | vitest.config.ts (aliases `@main` → `src/main`, `environment: 'node'`, setupFiles `tests/setup.ts`); tests/setup.ts (global `@main/app/window` mock, `vi.clearAllMocks()` afterEach) |
| checkpointCoverageExtras suite exists | tests/main/unit/checkpointCoverageExtras.test.ts (glob) |

**Unknowns / not verified here:** the two new tests were authored against verified source but
never executed (no `node_modules` in this worktree) — passing status is the parent's checklist,
not a claim. The alias-vs-relative `vi.mock('@main/agent/runRegistry')` equivalence relies on
standard Vitest module resolution (mocks keyed by resolved path); the negative controls in §5.5
will prove it if the suite behaves as predicted.
