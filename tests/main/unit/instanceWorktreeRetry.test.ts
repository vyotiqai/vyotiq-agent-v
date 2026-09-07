import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

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
  pruneStaleInstanceWorktrees,
  removeInstanceWorktreeDirBestEffort,
  resetInstanceWorktreeCleanupForTests,
  retryRemoveInstanceWorktreePath
} from '@main/git/instanceWorktree'

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

    const pruned = await pruneStaleInstanceWorktrees(workspace, new Set([liveId]))
    expect(pruned).toBe(1)
    expect(existsSync(join(root, liveId))).toBe(true)
    expect(existsSync(join(root, staleId))).toBe(false)
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
