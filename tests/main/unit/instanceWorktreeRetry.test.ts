import { afterEach, describe, expect, it, vi } from 'vitest'
import { spawn } from 'child_process'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChildProcess } from 'child_process'

const userData = join(tmpdir(), `vyotiq-wt-retry-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  buildWorktreeProcessFilter,
  executablePathIsUnder,
  gitRefIsMissingError,
  gitWorktreeRemoveErrorKind,
  instanceWorktreesRoot,
  isDeferredWorktreeLockError,
  probeInstanceWorktreePathLocked,
  pruneStaleInstanceWorktrees,
  removeInstanceWorktreeDirBestEffort,
  resetInstanceWorktreeCleanupForTests,
  retryRemoveInstanceWorktreePath
} from '@main/git/instanceWorktree'
import { workspaceIndexStorageDir } from '@main/agent/indexStoragePaths'
import { logger } from '@shared/logger'

describe('retryRemoveInstanceWorktreePath', () => {
  afterEach(() => {
    resetInstanceWorktreeCleanupForTests()
  })

  it('retries git 255 then succeeds', async () => {
    let gitCalls = 0
    let present = true
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [0],
      rmDelaysMs: [0],
      sleepFn: async () => undefined,
      gitRemove: async () => {
        gitCalls += 1
        if (gitCalls === 1) {
          throw Object.assign(new Error('Command failed: git worktree remove --force'), {
            code: 255
          })
        }
        present = false
      },
      existsSyncFn: () => present,
      rmSyncFn: () => {
        present = false
      }
    })
    expect(gitCalls).toBe(2)
    expect(outcome).toBe('removed')
  })

  it('retries rmSync EPERM then succeeds', async () => {
    let rmCalls = 0
    let present = true
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [0],
      rmDelaysMs: [0],
      sleepFn: async () => undefined,
      gitRemove: async () => {
        throw Object.assign(new Error('Command failed'), { code: 255 })
      },
      existsSyncFn: () => present,
      rmSyncFn: () => {
        rmCalls += 1
        if (rmCalls === 1) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
        present = false
      }
    })
    expect(rmCalls).toBe(2)
    expect(outcome).toBe('removed')
  })

  it('returns locked when rm stays EPERM', async () => {
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [],
      rmDelaysMs: [0],
      sleepFn: async () => undefined,
      existsSyncFn: () => true,
      rmSyncFn: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
      renameFn: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      }
    })
    expect(outcome).toBe('locked')
  })

  it('does not retry git when the path is not a working tree', async () => {
    let gitCalls = 0
    let present = true
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [0, 0, 0],
      rmDelaysMs: [],
      sleepFn: async () => undefined,
      gitRemove: async () => {
        gitCalls += 1
        throw Object.assign(new Error("fatal: '/tmp/wt' is not a working tree"), {
          code: 128,
          stderr: "fatal: '/tmp/wt' is not a working tree\n"
        })
      },
      existsSyncFn: () => present,
      rmSyncFn: () => {
        present = false
      }
    })
    expect(gitCalls).toBe(1)
    expect(outcome).toBe('removed')
  })

  it('renames a locked tree aside when rmSync stays EPERM', async () => {
    let present = true
    let renamedTo = ''
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [],
      rmDelaysMs: [],
      sleepFn: async () => undefined,
      nowFn: () => 42,
      existsSyncFn: (path) => (path === '/tmp/wt' ? present : false),
      rmSyncFn: (path) => {
        if (path === '/tmp/wt') {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
      },
      renameFn: (from, to) => {
        expect(from).toBe('/tmp/wt')
        expect(to).toBe('/tmp/wt.deleted-42')
        present = false
        renamedTo = to
      }
    })
    expect(outcome).toBe('removed')
    expect(renamedTo).toBe('/tmp/wt.deleted-42')
    expect(present).toBe(false)
  })

  it('notifies when rename-aside left a leftover directory', async () => {
    let present = true
    const asides: string[] = []
    const asidePath = '/tmp/wt.deleted-7'
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [],
      rmDelaysMs: [],
      sleepFn: async () => undefined,
      nowFn: () => 7,
      existsSyncFn: (path) => (path === '/tmp/wt' ? present : path === asidePath),
      rmSyncFn: (path) => {
        if (path === '/tmp/wt' || path === asidePath) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
      },
      renameFn: () => {
        present = false
      },
      onAsideLeft: (p) => {
        asides.push(p)
      }
    })
    expect(outcome).toBe('removed')
    expect(asides).toEqual([asidePath])
  })

  it('does not rename an already-aside leftover', async () => {
    let renamed = false
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt.deleted-1', {
      gitDelaysMs: [],
      rmDelaysMs: [],
      sleepFn: async () => undefined,
      existsSyncFn: () => true,
      rmSyncFn: () => {
        throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
      },
      renameFn: () => {
        renamed = true
      }
    })
    expect(outcome).toBe('locked')
    expect(renamed).toBe(false)
  })

  it('kills path holders then retries rm', async () => {
    let rmCalls = 0
    let present = true
    let killed = 0
    const outcome = await retryRemoveInstanceWorktreePath('/tmp/wt', {
      gitDelaysMs: [],
      rmDelaysMs: [],
      sleepFn: async () => undefined,
      existsSyncFn: () => present,
      rmSyncFn: () => {
        rmCalls += 1
        if (rmCalls === 1) {
          throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
        }
        present = false
      },
      killUnderPath: async () => {
        killed += 1
      }
    })
    expect(killed).toBe(1)
    expect(rmCalls).toBe(2)
    expect(outcome).toBe('removed')
  })
})

describe('gitWorktreeRemoveErrorKind', () => {
  it('classifies missing worktrees vs locks', () => {
    expect(
      gitWorktreeRemoveErrorKind({
        stderr: "fatal: 'C:/tmp/wt' is not a working tree\n"
      })
    ).toBe('not_a_worktree')
    expect(
      gitWorktreeRemoveErrorKind({
        stderr: "fatal: 'C:/tmp/wt' is locked\n"
      })
    ).toBe('locked')
    expect(gitWorktreeRemoveErrorKind({ stderr: 'error: failed to delete' })).toBe('other')
  })
})

describe('gitRefIsMissingError', () => {
  it('matches already-deleted instance branches', () => {
    expect(
      gitRefIsMissingError({
        stderr: "error: branch 'vyotiq/instance/abc' not found\n"
      })
    ).toBe(true)
    expect(gitRefIsMissingError({ message: 'error: failed to delete' })).toBe(false)
  })
})

describe('isDeferredWorktreeLockError', () => {
  it('matches only the locked-EPERM deferral thrown by removeInstanceWorktreeUnlocked', () => {
    expect(
      isDeferredWorktreeLockError(
        Object.assign(new Error('Instance worktree still locked: C:\\tmp\\wt'), { code: 'EPERM' })
      )
    ).toBe(true)
    // Same message but a different code is not the deferral.
    expect(
      isDeferredWorktreeLockError(
        Object.assign(new Error('Instance worktree still locked: C:\\tmp\\wt'), { code: 'EBUSY' })
      )
    ).toBe(false)
    // EPERM without the deferral message is an ordinary fs lock error.
    expect(
      isDeferredWorktreeLockError(Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }))
    ).toBe(false)
    expect(isDeferredWorktreeLockError(null)).toBe(false)
    expect(isDeferredWorktreeLockError('Instance worktree still locked: C:\\tmp\\wt')).toBe(false)
  })
})

describe('pruneStaleInstanceWorktrees lock classification', () => {
  let workspace = ''
  let holder: ChildProcess | undefined
  let lockedSub = ''
  let staleDir = ''

  afterEach(async () => {
    resetInstanceWorktreeCleanupForTests()
    vi.restoreAllMocks()
    if (holder) {
      holder.kill()
      holder = undefined
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    if (workspace && existsSync(workspace)) {
      // POSIX: restore the mode-000 paths so rmSync can traverse and remove.
      // The root itself is chmod'd 0o555 by the fixture — without restoring
      // it, this cleanup's rmdir of the worktree root throws EACCES.
      try {
        if (lockedSub) chmodSync(lockedSub, 0o755)
      } catch {
        /* already gone */
      }
      try {
        if (staleDir) chmodSync(join(staleDir, '..'), 0o755)
      } catch {
        /* already gone */
      }
      rmSync(workspace, { recursive: true, force: true })
    }
    workspace = ''
    lockedSub = ''
    staleDir = ''
  })

  it('logs the locked stale worktree as deferred info, not a prune failure warn', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-prune-lock-'))
    const root = instanceWorktreesRoot(workspace)
    staleDir = join(root, 'locked-run')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'busy.txt'), 'locked', 'utf8')
    if (process.platform === 'win32') {
      // A live process whose CWD is inside the stale checkout is exactly the
      // production leftover-lock case; cwd-only holders are out of scope for
      // the WQL kill filter, so removal stays locked.
      holder = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], {
        cwd: staleDir,
        stdio: 'ignore'
      })
      await new Promise((resolve) => setTimeout(resolve, 500))
    } else {
      // POSIX: a mode-000 subdirectory blocks traversal of its children, so
      // the tree cannot be emptied (rmdir stays ENOTEMPTY), and a read-only
      // root blocks the rename-aside fallback — removal stays locked.
      lockedSub = join(staleDir, 'locked')
      mkdirSync(lockedSub)
      writeFileSync(join(lockedSub, 'lock.txt'), 'x', 'utf8')
      chmodSync(lockedSub, 0o000)
      chmodSync(root, 0o555)
    }

    const infoSpy = vi.spyOn(logger, 'info')
    const warnSpy = vi.spyOn(logger, 'warn')

    const pruned = await pruneStaleInstanceWorktrees(workspace, new Set())
    expect(pruned).toBe(0)
    // Deferred by design: the path stays and cleanup is scheduled for later.
    expect(existsSync(staleDir)).toBe(true)
    // One summary per pass instead of a per-path info line.
    expect(infoSpy).toHaveBeenCalledWith(
      'instance worktree prune summary',
      expect.objectContaining({
        scope: 'git',
        removed: 0,
        deferredCount: 1,
        deferred: [staleDir],
        backoffSkipped: 0,
        failed: []
      })
    )
    expect(infoSpy).not.toHaveBeenCalledWith(
      'instance worktree prune deferred',
      expect.anything()
    )
    expect(warnSpy).not.toHaveBeenCalledWith(
      'instance worktree prune failed',
      expect.objectContaining({ scope: 'git', worktreePath: staleDir })
    )
  })
})

describe('pruneStaleInstanceWorktrees locked-path backoff', () => {
  let workspace = ''

  afterEach(() => {
    resetInstanceWorktreeCleanupForTests()
    vi.restoreAllMocks()
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    workspace = ''
  })

  it('backs off a locked path across passes and retries after the window', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-prune-backoff-'))
    const root = instanceWorktreesRoot(workspace)
    const staleDir = join(root, 'locked-run')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'busy.txt'), 'locked', 'utf8')

    let probeRenames = 0
    const eperm = () =>
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    const renameFn = vi.fn(() => {
      probeRenames += 1
      throw eperm()
    })
    let now = 1_000
    const infoSpy = vi.spyOn(logger, 'info')

    // Pass 1: probe hits the lock, path deferred, backoff window opens.
    await pruneStaleInstanceWorktrees(workspace, new Set(), {
      renameFn,
      nowFn: () => now,
      backoffMs: 60_000
    })
    expect(probeRenames).toBe(1)
    expect(infoSpy).toHaveBeenCalledWith(
      'instance worktree prune summary',
      expect.objectContaining({ deferredCount: 1, backoffSkipped: 0, removed: 0 })
    )

    // Pass 2 inside the window: skipped via backoff, no probe, no ladder.
    now += 1_000
    infoSpy.mockClear()
    await pruneStaleInstanceWorktrees(workspace, new Set(), {
      renameFn,
      nowFn: () => now,
      backoffMs: 60_000
    })
    expect(probeRenames).toBe(1)
    expect(infoSpy).toHaveBeenCalledWith(
      'instance worktree prune summary',
      expect.objectContaining({ deferredCount: 0, backoffSkipped: 1, removed: 0 })
    )

    // Pass 3 past the window: probed again, still locked, deferred again.
    now += 61_000
    infoSpy.mockClear()
    await pruneStaleInstanceWorktrees(workspace, new Set(), {
      renameFn,
      nowFn: () => now,
      backoffMs: 60_000
    })
    expect(probeRenames).toBe(2)
    expect(infoSpy).toHaveBeenCalledWith(
      'instance worktree prune summary',
      expect.objectContaining({ deferredCount: 1, backoffSkipped: 0, removed: 0 })
    )
  })

  it('clears the backoff once the path is removed', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-prune-clear-'))
    const root = instanceWorktreesRoot(workspace)
    const staleDir = join(root, 'gone-run')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'file.txt'), 'data', 'utf8')

    // A rename probe that succeeds (and renames back) leaves removal unlocked.
    const renameFn = vi.fn((from: string, to: string) => {
      renameSync(from, to)
    })
    let now = 1_000
    await pruneStaleInstanceWorktrees(workspace, new Set(), {
      renameFn,
      nowFn: () => now,
      backoffMs: 60_000
    })
    expect(existsSync(staleDir)).toBe(false)

    // A new stale dir with the same name is not blocked by the old backoff.
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'file2.txt'), 'data', 'utf8')
    const blockingRename = vi.fn(() => {
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    const infoSpy = vi.spyOn(logger, 'info')
    now += 2_000
    await pruneStaleInstanceWorktrees(workspace, new Set(), {
      renameFn: blockingRename,
      nowFn: () => now,
      backoffMs: 60_000
    })
    expect(infoSpy).toHaveBeenCalledWith(
      'instance worktree prune summary',
      expect.objectContaining({ deferredCount: 1, backoffSkipped: 0, removed: 0 })
    )
  })
})

describe('probeInstanceWorktreePathLocked', () => {
  it('reports locked only on permission-style rename failures', () => {
    const eperm = () =>
      Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })

    const renames: Array<[string, string]> = []
    expect(
      probeInstanceWorktreePathLocked('/tmp/wt', (from, to) => {
        renames.push([from, to])
      })
    ).toBe(false)
    // Probe renames to the side and immediately back.
    expect(renames).toEqual([
      ['/tmp/wt', '/tmp/wt.lockprobe'],
      ['/tmp/wt.lockprobe', '/tmp/wt']
    ])

    expect(probeInstanceWorktreePathLocked('/tmp/wt', () => { throw eperm() })).toBe(true)
    expect(
      probeInstanceWorktreePathLocked('/tmp/wt', () => {
        throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      })
    ).toBe(true)
    expect(
      probeInstanceWorktreePathLocked('/tmp/wt', () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
      })
    ).toBe(true)
    // Missing path is "not locked" — callers treat it as already gone.
    expect(
      probeInstanceWorktreePathLocked('/tmp/wt', () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      })
    ).toBe(false)
    // Unclassified errors must not be reported as locks.
    expect(
      probeInstanceWorktreePathLocked('/tmp/wt', () => {
        throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' })
      })
    ).toBe(false)
  })

  it('reports locked and warns when the rename-back fails', () => {
    const warnSpy = vi.spyOn(logger, 'warn')
    let calls = 0
    const flaky = vi.fn((from: string) => {
      calls += 1
      if (calls === 1) return // side rename succeeds
      throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' })
    })
    expect(probeInstanceWorktreePathLocked('/tmp/wt', flaky)).toBe(true)
    expect(warnSpy).toHaveBeenCalledWith(
      'instance worktree lock probe rename-back failed',
      expect.objectContaining({ scope: 'git', path: '/tmp/wt' })
    )
  })
})

describe('pruneStaleInstanceWorktrees', () => {
  let workspace = ''

  afterEach(() => {
    resetInstanceWorktreeCleanupForTests()
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('removes stale checkouts and keeps live run ids', async () => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-wt-prune-ws-'))
    const root = instanceWorktreesRoot(workspace)
    const liveId = 'live-run-id'
    const staleId = 'stale-run-id'
    mkdirSync(join(root, liveId), { recursive: true })
    mkdirSync(join(root, staleId), { recursive: true })
    writeFileSync(join(root, liveId, 'keep.txt'), 'live', 'utf8')
    writeFileSync(join(root, staleId, 'gone.txt'), 'stale', 'utf8')

    const staleIndex = join(workspaceIndexStorageDir(join(root, staleId)), 'codeindex')
    const liveIndex = join(workspaceIndexStorageDir(join(root, liveId)), 'codeindex')
    mkdirSync(staleIndex, { recursive: true })
    mkdirSync(liveIndex, { recursive: true })
    writeFileSync(join(staleIndex, 'index.sqlite'), 'stale-index', 'utf8')
    writeFileSync(join(liveIndex, 'index.sqlite'), 'live-index', 'utf8')

    const pruned = await pruneStaleInstanceWorktrees(workspace, new Set([liveId]))
    expect(pruned).toBe(1)
    expect(existsSync(join(root, liveId))).toBe(true)
    expect(existsSync(join(root, staleId))).toBe(false)
    // The dead worktree's derived index storage goes with it; a live one stays.
    expect(existsSync(staleIndex)).toBe(false)
    expect(existsSync(liveIndex)).toBe(true)
  })
})

describe('instance worktree node_modules unlink', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  })

  it('unlinks a node_modules junction without deleting the target', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'vyotiq-wt-nm-from-'))
    const worktree = mkdtempSync(join(tmpdir(), 'vyotiq-wt-nm-to-'))
    dirs.push(parent, worktree)
    const pkg = join(parent, 'node_modules', 'pkg')
    mkdirSync(pkg, { recursive: true })
    writeFileSync(join(pkg, 'keep.txt'), 'safe', 'utf8')
    writeFileSync(join(worktree, 'src.ts'), 'export {}\n', 'utf8')
    symlinkSync(
      join(parent, 'node_modules'),
      join(worktree, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const linked = join(worktree, 'node_modules')
    expect(existsSync(linked)).toBe(true)
    expect(lstatSync(linked).isSymbolicLink()).toBe(true)
    await removeInstanceWorktreeDirBestEffort(worktree)
    expect(existsSync(worktree)).toBe(false)
    expect(existsSync(join(pkg, 'keep.txt'))).toBe(true)
  })
})

describe('buildWorktreeProcessFilter', () => {
  it('excludes only the host and PowerShell runner PIDs', () => {
    const root = 'C:\\Users\\admin\\AppData\\Roaming\\vyotiq\\workspaces\\abc\\instance-worktrees\\run-1'
    const filter = buildWorktreeProcessFilter(root, 1234)
    expect(filter).toContain("ProcessId != 1234")
    expect(filter).toContain('ProcessId != $PID')
    expect(filter).not.toContain('ExecutablePath !=')
    expect(filter).toContain('ExecutablePath LIKE')
    expect(filter).toContain('CommandLine LIKE')
    // Win32_Process has no CurrentDirectory property — the WQL query would be
    // rejected outright ("Invalid query"), silently disabling the kill step.
    expect(filter).not.toContain('CurrentDirectory')
  })
})

describe('executablePathIsUnder', () => {
  it('matches worktree-hosted binaries and rejects the parent checkout', () => {
    const root = 'C:\\Users\\admin\\AppData\\Roaming\\vyotiq\\workspaces\\abc\\instance-worktrees\\run-1'
    expect(
      executablePathIsUnder(root, `${root}\\node_modules\\.pnpm\\esbuild.exe`)
    ).toBe(true)
    expect(
      executablePathIsUnder(
        root,
        'C:\\Users\\admin\\Documents\\VYOTIQ - AGENT V\\node_modules\\.pnpm\\esbuild.exe'
      )
    ).toBe(false)
  })
})
