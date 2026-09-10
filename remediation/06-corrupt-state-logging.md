# 06 — Corrupt-state logging (audit M6 + M4)

Remediation plan for `AUDIT-REPORT-2026-09-10.md`:

- **M6** (`AUDIT-REPORT-2026-09-10.md:118-122`): silent corrupt-state loaders return defaults with no log on parse/schema failure — `followUpStore.ts`, `loopCheckpoint.ts`, `state.ts` `loadStatus`, `runGoal.ts` `readGoal`; plus the asymmetric checkpoint persist catches in `loop.ts` (`:1378-1380` silent vs `:1406-1413` logged).
- **M4** (`AUDIT-REPORT-2026-09-10.md:110-112`): `enforceMessageArchiveCap` silently and permanently deletes the oldest transcript archive past the cap (`MAX_MESSAGE_ARCHIVES = 5`), nothing logs the eviction.

Note: `02-agent-core.md §M-4` (referenced in the task brief) does not exist in this worktree — `AUDIT-REPORT-2026-09-10.md:110-112` is the authoritative M4 statement and is used here instead.

All fixes are `old_string` → `new_string` pairs below, grouped by file in application order. Every `old_string` was re-read this run: **verbatim from the MAIN TREE** for the dirty files (`state.ts`, `loop.ts`, read via absolute-path terminal reads against `C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V\src\main\agent\`), and from the current clean worktree for everything else (`git status` clean).

---

## Logger-import evidence per file

| File | logger import today | basename import today | Style evidence |
|---|---|---|---|
| `src/main/agent/followUpStore.ts` | **none** (`:1-6`: fs, path, zod, `@main/storage/atomicWrite`, `@shared/ipc/schemas/agent`, `./runRegistry`) | `import { join } from 'path'` (`:2`) | sibling convention: `import { logger } from '../../shared/logger'` (`messageAppendQueue.ts:4`, `statusWriteQueue.ts:4`, `runRegistry.ts:3`) |
| `src/main/agent/loopCheckpoint.ts` | **none** (`:1-4`) | `import { join } from 'path'` (`:2`) | same sibling convention |
| `src/main/agent/runGoal.ts` | **none** (`:1-11`) | `import { join } from 'path'` (`:2`) | same sibling convention |
| `src/main/agent/state.ts` (MAIN TREE, dirty) | `import { logger } from '../../shared/logger'` (`:38`) | `import { join, basename } from 'path'` (`:3`) | existing warn shape: `state.ts:127-131`, `:154-157`, `:162-166` (`scope: 'state'`, `correlationId: basename(runDir)`, `err`) |
| `src/main/agent/loop.ts` (MAIN TREE, dirty) | `import { logger, logErrorSummary } from '../../shared/logger'` (`:15`) | n/a (uses `runId`) | sibling logged catch `loop.ts:1406-1413`: `scope: 'agent'`, `code: 'PERSIST'`, `correlationId: runId`, `err` |
| `src/main/agent/messageAppendQueue.ts` | `import { logger } from '../../shared/logger'` (`:4`) | `import { basename, join } from 'path'` (`:3`) | warn shape `:65-69`, info shape `:197-203` (`scope: 'state'`, `code`, `correlationId: basename(dir)`, `filename`) |

No import changes are needed in `state.ts`, `loop.ts`, or `messageAppendQueue.ts`.

---

## 1. `src/main/agent/followUpStore.ts` (clean)

Evidence: `loadFollowUps` at `:29-38`; silent default-returns — schema-fail ternary at `:34`, silent catch at `:35-37`. `FollowUpsFileSchema.safeParse` occurs once (`:33`) → pair 1c unique; pair 1a/1b anchors are the only occurrences of their lines.

**Pair 1a — add `basename`** (`:2`)

```ts
// old_string
import { join } from 'path'

// new_string
import { basename, join } from 'path'
```

**Pair 1b — add logger import** (after `:3`; sibling style `../../shared/logger`)

```ts
// old_string
import { z } from 'zod'
import { atomicWriteJson } from '@main/storage/atomicWrite'

// new_string
import { z } from 'zod'
import { logger } from '../../shared/logger'
import { atomicWriteJson } from '@main/storage/atomicWrite'
```

**Pair 1c — warn in the corrupt catch** (`:33-37`; also fixes the schema-failure path cited by M6 — see Design notes)

```ts
// old_string
    const parsed = FollowUpsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data.followUps : []
  } catch {
    return []
  }

// new_string
    const parsed = FollowUpsFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw parsed.error
    return parsed.data.followUps
  } catch (err) {
    logger.warn('Corrupt followups.json; treating as empty', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return []
  }
```

---

## 2. `src/main/agent/loopCheckpoint.ts` (clean)

Evidence: `loadLoopCheckpoint` at `:12-26`; silent default-returns — schema-fail ternary at `:22`, silent catch at `:23-25`. `LoopCheckpointSchema.safeParse` occurs once (`:21`) → pair 2c unique.

**Pair 2a — add `basename`** (`:2`)

```ts
// old_string
import { join } from 'path'

// new_string
import { basename, join } from 'path'
```

**Pair 2b — add logger import** (after `:3`)

```ts
// old_string
import { atomicWriteJson } from '@main/storage/atomicWrite'

// new_string
import { atomicWriteJson } from '@main/storage/atomicWrite'
import { logger } from '../../shared/logger'
```

**Pair 2c — warn in the corrupt catch**

```ts
// old_string
    const parsed = LoopCheckpointSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }

// new_string
    const parsed = LoopCheckpointSchema.safeParse(raw)
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt loopCheckpoint.json; treating as absent', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
```

---

## 3. `src/main/agent/runGoal.ts` (clean)

Evidence: `readGoal` at `:22-31`; silent default-returns — schema-fail ternary at `:27`, silent catch at `:28-30`. `RunGoalSchema.safeParse` occurs once (`:26`) → pair 3c unique. (`readStatusGoal` at `:92-99` is also silent but is out of M6 scope — not touched.)

**Pair 3a — add `basename`** (`:2`)

```ts
// old_string
import { join } from 'path'

// new_string
import { basename, join } from 'path'
```

**Pair 3b — add logger import** (end of the import block, `:11`)

```ts
// old_string
import { invalidateListRunsCache } from './runListCache'

// new_string
import { invalidateListRunsCache } from './runListCache'
import { logger } from '../../shared/logger'
```

**Pair 3c — warn in the corrupt catch**

```ts
// old_string
    const parsed = RunGoalSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }

// new_string
    const parsed = RunGoalSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt goal.json; treating as absent', {
      scope: 'state',
      correlationId: basename(runDir),
      err
    })
    return null
  }
```

---

## 4. `src/main/agent/state.ts` — DIRTY (main tree), verify before applying

`old_string` below was captured this run from the MAIN TREE (`:201-211`). The worktree copy is stale — **re-read the main-tree region before applying**; if the in-flight session moved `loadStatus`, re-anchor on `export function loadStatus(dir: string): RunStatus | null {`.

Evidence: `logger` imported at `:38`, `basename` at `:3` (no import changes needed); existing warn style `state.ts:127-131` / `:162-166` (`scope: 'state'`, `correlationId: basename(...)`, `err`); other `RunStatusSchema.safeParse(raw)` call sites exist (`:345`, `:944`, `:1188`, `:1316`, `:1446`) but the `export function loadStatus` anchor makes the block unique.

**Pair 4a — warn in the corrupt catch** (also fixes the schema-failure path)

```ts
// old_string
export function loadStatus(dir: string): RunStatus | null {
  const p = join(dir, 'status.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

// new_string
export function loadStatus(dir: string): RunStatus | null {
  const p = join(dir, 'status.json')
  if (!existsSync(p)) return null
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown
    const parsed = RunStatusSchema.safeParse(raw)
    if (!parsed.success) throw parsed.error
    return parsed.data
  } catch (err) {
    logger.warn('Corrupt status.json; treating as absent', {
      scope: 'state',
      correlationId: basename(dir),
      err
    })
    return null
  }
}
```

---

## 5. `src/main/agent/loop.ts` — DIRTY (main tree), verify before applying

`old_string` below was captured this run from the MAIN TREE: `persistUsageTotalsCheckpoint` at `:1355-1381` with the empty catch at `:1378-1380` (comment at `:1379`); the logged sibling `persistLoopCheckpoint` catch at `:1406-1413`. `logger` is imported at `:15` (no import change). The comment `// Checkpoint write is best-effort; the run must not fail on it.` occurs exactly once in the main tree, and the standalone `          usageTotals` line occurs only inside `persistUsageTotalsCheckpoint` (`:1376`; the sibling carries usageTotals via a spread at `:1402-1404`) → the block is unique. Same re-anchor caveat as §4.

**Pair 5a — align with the sibling's logged catch** (same field shape as `:1406-1413`)

```ts
// old_string
          usageTotals
        })
      } catch {
        // Checkpoint write is best-effort; the run must not fail on it.
      }

// new_string
          usageTotals
        })
      } catch (err) {
        // Checkpoint write is best-effort; the run must not fail on it.
        logger.warn('Usage totals checkpoint persist failed', {
          scope: 'agent',
          code: 'PERSIST',
          correlationId: runId,
          err
        })
      }
```

---

## 6. `src/main/agent/messageAppendQueue.ts` (clean) — M4 eviction log

Evidence: `logger` imported at `:4`; `enforceMessageArchiveCap` at `:176-188` (called only from `archiveDiscardedMessageHead`, `:190`); `MAX_MESSAGE_ARCHIVES = 5` at `:15`. The function body is unique in the file. Log fires **only after a successful `unlink`**, once per deleted archive — a failed unlink deletes nothing, so it stays silent (best-effort, retried next rotation); no per-rotation-attempt spam. Warn (not info) because this is permanent transcript loss, matching the M4 severity; field shape mirrors the file's `MESSAGES_ARCHIVED` info (`:197-203`: `scope`, `code`, `correlationId: basename(dir)`, `filename`) and warn (`:65-69`) conventions. `eventAppendQueue.ts` is intentionally untouched.

**Pair 6a — eviction log**

```ts
// old_string
async function enforceMessageArchiveCap(dir: string): Promise<void> {
  const archives = await listMessageArchives(dir)
  while (archives.length >= MAX_MESSAGE_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    try {
      await unlink(join(dir, oldest))
    } catch {
      // best effort — an undeletable archive must not block the append chain
    }
  }
}

// new_string
async function enforceMessageArchiveCap(dir: string): Promise<void> {
  const archives = await listMessageArchives(dir)
  while (archives.length >= MAX_MESSAGE_ARCHIVES) {
    const oldest = archives.shift()
    if (!oldest) break
    try {
      await unlink(join(dir, oldest))
      logger.warn('Evicted oldest messages archive (archive cap exceeded)', {
        scope: 'state',
        code: 'MESSAGES_ARCHIVE_EVICTED',
        correlationId: basename(dir),
        filename: oldest
      })
    } catch {
      // best effort — an undeletable archive must not block the append chain
    }
  }
}
```

---

## Design notes

- **`if (!parsed.success) throw parsed.error`** routes the schema-failure path (which does not throw) through the same catch as the JSON-parse failure, so **one warn covers both** failure modes M6 cites ("parse/schema failure"). A catch-only log would leave schema corruption (the more likely disk-writhe mode) silent. The thrown `ZodError` carries field paths, not field values — no user data reaches the log. Behavior is unchanged: every failure mode still returns the same default (`[]` / `null`).
- **Messages are terse, capitalized, and data-free** ("Corrupt followups.json; treating as empty") matching the file's sentence style (`messageAppendQueue.ts:65` "Failed to append messages.jsonl", `state.ts:127` "Invalid compaction record; not saved"); each states what failed and that defaults are used.
- **`scope: 'state'` + `correlationId: basename(runDir)`** matches the loaders' sibling logging conventions (`state.ts:127-131`, `messageAppendQueue.ts:65-69`). The loop.ts pair alone uses `scope: 'agent'`/`correlationId: runId` to mirror its sibling catch exactly, per the alignment requirement.

---

## 7. Test extensions (cheap, both included)

Convention verified this run: tests import `import { logger } from '@shared/logger'` (`tests/main/unit/instanceWorktreeRetry.test.ts:44`, `tests/main/unit/providerLog.test.ts:14`) and spy with `vi.spyOn(logger, 'warn').mockImplementation(() => {})` (`tests/main/unit/executeStepTools.test.ts:1035`, `tests/main/unit/instanceWorktreeRetry.test.ts:344`). Both test files are clean in the worktree; pairs below were read against the current tree.

### 7a. `tests/main/unit/followUpStore.test.ts`

**Pair T1a — vitest import** (`:1`)

```ts
// old_string
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// new_string
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
```

**Pair T1b — fs import** (`:2`; `writeFileSync` used by the new test)

```ts
// old_string
import { existsSync, mkdirSync, rmSync } from 'fs'

// new_string
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
```

**Pair T1c — logger import** (after the runRegistry import block)

```ts
// old_string
import {
  enqueueFollowUp,
  peekFollowUps,
  resetActiveRunsForTests,
  registerRunAbort
} from '@main/agent/runRegistry'

// new_string
import {
  enqueueFollowUp,
  peekFollowUps,
  resetActiveRunsForTests,
  registerRunAbort
} from '@main/agent/runRegistry'
import { logger } from '@shared/logger'
```

**Pair T1d — new test** (append before the closing `})` of the describe block; the tail anchor is unique — it is the file's last test)

```ts
// old_string
  it('clears disk file when queue is empty', () => {
    saveFollowUps(runDir, [{ id: 'x', message: { role: 'user', content: 'gone' } }])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(true)
    saveFollowUps(runDir, [])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(false)
  })
})

// new_string
  it('clears disk file when queue is empty', () => {
    saveFollowUps(runDir, [{ id: 'x', message: { role: 'user', content: 'gone' } }])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(true)
    saveFollowUps(runDir, [])
    expect(existsSync(join(runDir, 'followups.json'))).toBe(false)
  })

  it('warns and returns [] when followups.json is corrupt', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // Unparsable JSON — catch path warns.
      writeFileSync(join(runDir, 'followups.json'), '{ not json', 'utf8')
      expect(loadFollowUps(runDir)).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('followups.json')
      // Valid JSON, wrong shape — schema-failure path warns too.
      writeFileSync(join(runDir, 'followups.json'), JSON.stringify({ nope: true }), 'utf8')
      expect(loadFollowUps(runDir)).toEqual([])
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
```

### 7b. `tests/main/unit/loopCheckpoint.test.ts`

**Pair T2a — vitest import** (`:1`)

```ts
// old_string
import { afterEach, describe, expect, it } from 'vitest'

// new_string
import { afterEach, describe, expect, it, vi } from 'vitest'
```

**Pair T2b — logger import** (after the schemas import, `:12`)

```ts
// old_string
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'

// new_string
import { LOOP_CHECKPOINT_VERSION } from '@shared/ipc/schemas/agent'
import { logger } from '@shared/logger'
```

**Pair T2c — new test** (append before the closing `})`; tail anchor is the file's last test, unique)

```ts
// old_string
    expect(loaded?.step).toBe(105)
    expect(loaded?.identicalStepStreak).toBe(1)
    expect(loaded?.lastStepFingerprint).toBe('74a5e735e912861f')
  })
})

// new_string
    expect(loaded?.step).toBe(105)
    expect(loaded?.identicalStepStreak).toBe(1)
    expect(loaded?.lastStepFingerprint).toBe('74a5e735e912861f')
  })

  it('warns and returns null when loopCheckpoint.json is corrupt', () => {
    const runDir = join(root, 'run-corrupt')
    mkdirSync(runDir, { recursive: true })
    const { writeFileSync } = require('fs') as typeof import('fs')
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    try {
      // Unparsable JSON — catch path warns.
      writeFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), '{ not json', 'utf8')
      expect(loadLoopCheckpoint(runDir)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(1)
      expect(warnSpy.mock.calls[0]?.[0]).toContain('loopCheckpoint.json')
      // Valid JSON, unknown version — schema-failure path warns too.
      writeFileSync(join(runDir, LOOP_CHECKPOINT_FILENAME), JSON.stringify({ version: 99 }), 'utf8')
      expect(loadLoopCheckpoint(runDir)).toBeNull()
      expect(warnSpy).toHaveBeenCalledTimes(2)
    } finally {
      warnSpy.mockRestore()
    }
  })
})
```

(`require('fs')` for `writeFileSync` follows the file's own existing pattern — see the v2/v3-legacy tests in the same file.)

### Not included

- **`messageAppendQueue` eviction test**: not cheap. The existing rotation test (`tests/main/unit/messageAppendQueue.test.ts`, "keeps UTF-8 JSONL records valid across a rotation boundary") must write an ~8 MB `messages.jsonl` to cross `MESSAGES_FILE_MAX_BYTES`; forcing a cap eviction additionally requires pre-seeding 5 sorted `messages.archive.*` files before that rotation. Doable in a later round; the eviction log pair (6a) needs no test to be safe — it adds one `logger.warn` after a successful unlink.
- **`state.ts` / `loop.ts` test extensions**: `runsState.test.ts` / `checkpointCoverageExtras.test.ts` cover these paths at a higher level; the two cheap unit extensions above (7a/7b) are the ones worth landing now.

---

## Parent verification checklist

Worktree lacks `node_modules` — run everything in the main tree after landing the pairs.

1. **Re-anchor dirty files first**: re-read `loadStatus` (`state.ts`, was `:201-211`) and the `persistUsageTotalsCheckpoint` catch (`loop.ts`, was `:1378-1380`) in the main tree; confirm each `old_string` still matches verbatim (in-flight session + round-1 fixes are uncommitted there) before applying pairs 4a/5a. For clean files, apply pairs in listed order (imports before the catch pairs).
2. **Uniqueness re-check** (cheap grep per file): `FollowUpsFileSchema.safeParse`, `LoopCheckpointSchema.safeParse`, `RunGoalSchema.safeParse` each occur once; `Checkpoint write is best-effort` occurs once in `loop.ts`; `enforceMessageArchiveCap` body occurs once.
3. **Typecheck**: `pnpm typecheck` (or the repo's configured command) — pairs add `basename` imports and `(err)` catch bindings only.
4. **Unit suites**:
   - `pnpm vitest run tests/main/unit/followUpStore.test.ts` — new corrupt-file test passes; existing 3 tests unaffected.
   - `pnpm vitest run tests/main/unit/loopCheckpoint.test.ts` — new corrupt-file test passes; existing 5 tests (incl. v2/v3 migrations) unaffected.
   - `pnpm vitest run tests/main/unit/messageAppendQueue.test.ts` — rotation/UTF-8 boundary tests unaffected by pair 6a.
   - `pnpm vitest run tests/main/unit/runsState.test.ts tests/main/unit/runGoal.test.ts` — loaders still return the same defaults; no new console noise beyond the intended warns.
   - `pnpm vitest run tests/main/unit/checkpointCoverageExtras.test.ts` — checkpoint persist paths unchanged in behavior.
5. **Manual smoke (optional)**: corrupt a scratch run's `status.json` / `followups.json` / `loopCheckpoint.json` / `goal.json` and confirm one warn per load in the log file, with `scope: 'state'` and the run dir as `correlationId`.
