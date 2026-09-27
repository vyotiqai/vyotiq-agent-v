/**
 * The memory writer must go through the atomic writer's temp+rename.
 *
 * A bare `writeFileSync(target)` was the one main-process writer with no
 * Windows retry: an AV scanner or indexer holding a handle on `index.md` or a
 * note turned a transient lock into a hard `memory_write` failure, so the
 * memory was never stored. `renameSyncWithRetry` retries EPERM/EACCES/EBUSY
 * on a temp sibling, so the target is replaced only once the lock clears.
 *
 * Fault injection is on the `fs` boundary the atomic writer itself uses
 * (`renameSync`), with `process.platform` pinned to `win32` so the retry
 * ladder runs on any host.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fsState = vi.hoisted(() => ({
  /** Real fs functions, captured before the mock wraps them. */
  actual: {} as { renameSync: typeof import('fs').renameSync; writeFileSync: typeof import('fs').writeFileSync },
  writes: [] as string[],
  renameAttempts: [] as { from: string; to: string }[],
  /** Renames targeting one of these paths fail transiently, `count` times each. */
  transientLockTargets: new Map<string, number>()
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  fsState.actual = { renameSync: actual.renameSync, writeFileSync: actual.writeFileSync }
  return {
    ...actual,
    writeFileSync: (path: fs.PathLike, data: unknown, opts?: unknown) => {
      fsState.writes.push(String(path))
      return actual.writeFileSync(
        path,
        data as Parameters<typeof actual.writeFileSync>[1],
        opts as Parameters<typeof actual.writeFileSync>[2]
      )
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      const toKey = String(to)
      fsState.renameAttempts.push({ from: String(from), to: toKey })
      const remaining = fsState.transientLockTargets.get(toKey) ?? 0
      if (remaining > 0) {
        fsState.transientLockTargets.set(toKey, remaining - 1)
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
        err.code = 'EPERM'
        err.errno = -4048
        err.syscall = 'rename'
        throw err
      }
      return actual.renameSync(from, to)
    }
  }
})

import { ensureMemoryLayout, memoryRoot, writeMemoryFile } from '@main/agent/context/memory'

const realPlatform = process.platform
let dir: string

/** `<target>.<pid>.<8 hex>.tmp` — the atomic writer's unique sibling. */
function isAtomicTempPath(path: string, target: string): boolean {
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^${escaped}\\.${process.pid}\\.[0-9a-f]{8}\\.tmp$`).test(path)
}

beforeEach(() => {
  // The retry ladder is Windows-only; pin it so this test is host-independent.
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
  fsState.writes = []
  fsState.renameAttempts = []
  fsState.transientLockTargets = new Map()
  dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-atomic-'))
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('memory writes are atomic (temp sibling + retried rename)', () => {
  it('writes a note to a temp sibling and renames it onto the real path', () => {
    const target = join(memoryRoot(dir), 'notes', 'arch.md')

    expect(writeMemoryFile(dir, 'notes/arch.md', '# Arch\n')).toBe('notes/arch.md')

    // Never written in place: no direct writeFileSync to the note itself.
    expect(fsState.writes).not.toContain(target)
    const temps = fsState.writes.filter((p) => isAtomicTempPath(p, target))
    expect(temps).toHaveLength(1)
    // The rename is what publishes the content.
    expect(fsState.renameAttempts).toContainEqual({ from: temps[0], to: target })
    expect(readFileSync(target, 'utf8')).toBe('# Arch\n')
  })

  it('survives a transient lock on the note and leaves no temp behind', () => {
    const target = join(memoryRoot(dir), 'notes', 'arch.md')
    // Two transient EPERMs, the shape an AV/indexer handle produces.
    fsState.transientLockTargets.set(target, 2)

    expect(writeMemoryFile(dir, 'notes/arch.md', '# Arch\n')).toBe('notes/arch.md')

    const attempts = fsState.renameAttempts.filter((a) => a.to === target)
    // Injected twice, then the third attempt lands.
    expect(attempts).toHaveLength(3)
    expect(readFileSync(target, 'utf8')).toBe('# Arch\n')
    expect(readdirSync(join(memoryRoot(dir), 'notes'))).toEqual(['arch.md'])
  })

  it('propagates a lock that never clears, cleaning up its temp file', () => {
    const target = join(memoryRoot(dir), 'notes', 'arch.md')
    fsState.transientLockTargets.set(target, Number.MAX_SAFE_INTEGER)

    expect(() => writeMemoryFile(dir, 'notes/arch.md', '# Arch\n')).toThrow(/EPERM/)
    // The failed write leaves no note and no orphan temp behind.
    expect(statSync(join(memoryRoot(dir), 'notes'), { throwIfNoEntry: false })).toBeDefined()
    expect(readdirSync(join(memoryRoot(dir), 'notes'))).toEqual([])
  })

  it("writes ensureMemoryLayout's stub index atomically too", () => {
    ensureMemoryLayout(dir)

    const target = join(memoryRoot(dir), 'index.md')
    expect(fsState.writes).not.toContain(target)
    const temps = fsState.writes.filter((p) => isAtomicTempPath(p, target))
    expect(temps).toHaveLength(1)
    expect(fsState.renameAttempts).toContainEqual({ from: temps[0], to: target })
    expect(readFileSync(target, 'utf8')).toContain('# Memory index')
  })
})
