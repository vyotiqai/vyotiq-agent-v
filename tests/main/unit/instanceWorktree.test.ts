import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { canGit } from '../../helpers/canGit'

const userData = join(tmpdir(), `vyotiq-wt-ud-${process.pid}-${Date.now()}`)

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
  addInstanceWorktree,
  commitDirtyInstanceWorktree,
  gitShowToFile,
  instanceWorktreePath,
  isInstanceWorktreeDir,
  linkNodeModulesBestEffort,
  mergeInstanceBranch,
  removeInstanceWorktree,
  resetInstanceWorktreeCleanupForTests
} from '@main/git/instanceWorktree'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

describe('isInstanceWorktreeDir', () => {
  it('detects instance-worktrees path segments', () => {
    expect(isInstanceWorktreeDir(join('C:', 'workspaces', 'abc', 'instance-worktrees', 'run-1'))).toBe(
      true
    )
    expect(isInstanceWorktreeDir(join('C:', 'Documents', 'project'))).toBe(false)
  })
})

describe.skipIf(!canGit)('instanceWorktree concurrent add', () => {
  let repo = ''
  let worktreePaths: string[] = []

  afterEach(async () => {
    for (const wt of worktreePaths) {
      if (repo) await removeInstanceWorktree(repo, wt)
    }
    worktreePaths = []
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('adds two worktrees on one repo without index.lock', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-repo-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runIdA = `run-a-${process.pid}`
    const runIdB = `run-b-${process.pid}`
    worktreePaths = [instanceWorktreePath(repo, runIdA), instanceWorktreePath(repo, runIdB)]
    const [a, b] = await Promise.all([
      addInstanceWorktree(repo, runIdA),
      addInstanceWorktree(repo, runIdB)
    ])

    if (!a.ok) expect(a.error).not.toMatch(/index\.lock/i)
    if (!b.ok) expect(b.error).not.toMatch(/index\.lock/i)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    if (!a.ok || !b.ok) return

    expect(existsSync(a.worktreePath)).toBe(true)
    expect(existsSync(b.worktreePath)).toBe(true)
    expect(a.worktreePath).not.toBe(b.worktreePath)
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree merge gate', () => {
  let repo = ''

  afterEach(() => {
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    repo = ''
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  function initRepo(): void {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-merge-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )
  }

  function addBranch(name: string): void {
    git(repo, 'branch', name, 'main')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '--allow-empty',
      '-m',
      `${name} seed`
    )
    git(repo, 'branch', '--force', name, 'HEAD')
  }

  it('allows merging when the parent tree has only untracked files', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-a-${process.pid}`
    addBranch(branch)
    writeFileSync(join(repo, 'scratch.txt'), 'untracked\n', 'utf8')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.detail).toContain(branch)
  }, 30_000)

  it('refuses merging when a tracked modification overlaps the branch changed files', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-b-${process.pid}`
    git(repo, 'checkout', '-b', branch)
    writeFileSync(join(repo, 'README.md'), 'instance edit\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work')
    git(repo, 'checkout', 'main')

    writeFileSync(join(repo, 'README.md'), 'modified\n', 'utf8')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/also changed \(README\.md\)/i)
  }, 30_000)

  it('refuses merging when a staged addition overlaps the branch changed files', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-c-${process.pid}`
    git(repo, 'checkout', '-b', branch)
    writeFileSync(join(repo, 'staged.ts'), 'export const s = 1\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work')
    git(repo, 'checkout', 'main')

    writeFileSync(join(repo, 'staged.ts'), 'export const s = 2\n', 'utf8')
    git(repo, 'add', 'staged.ts')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/also changed \(staged\.ts\)/i)
  }, 30_000)

  it('allows merging when parent dirty files are disjoint from the branch changes', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-e-${process.pid}`
    git(repo, 'checkout', '-b', branch)
    writeFileSync(join(repo, 'instance-file.txt'), 'instance\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work')
    git(repo, 'checkout', 'main')

    writeFileSync(join(repo, 'README.md'), 'parent dirty\n', 'utf8')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
  }, 30_000)

  it('allows merging a clean parent tree', async () => {
    initRepo()
    const branch = `vyotiq/instance/run-d-${process.pid}`
    addBranch(branch)

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
  }, 30_000)

  it('reports pre-merge head and every applied change after a merge', async () => {
    initRepo()
    writeFileSync(join(repo, 'del.txt'), 'gone\n', 'utf8')
    git(repo, 'add', '.')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'seed')

    const branch = `vyotiq/instance/run-changes-${process.pid}`
    git(repo, 'checkout', '-b', branch)
    mkdirSync(join(repo, 'src'), { recursive: true })
    writeFileSync(join(repo, 'src', 'new.ts'), 'export const n = 1\n', 'utf8')
    writeFileSync(join(repo, 'README.md'), 'instance edit\n', 'utf8')
    rmSync(join(repo, 'del.txt'))
    git(repo, 'add', '-A')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'work')
    git(repo, 'checkout', 'main')

    const result = await mergeInstanceBranch(repo, branch)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.preMergeHead).toMatch(/^[0-9a-f]{40,64}$/)
    expect(result.changedFiles).toEqual(
      expect.arrayContaining([
        { path: 'src/new.ts', action: 'created' },
        { path: 'README.md', action: 'modified' },
        { path: 'del.txt', action: 'deleted' }
      ])
    )

    const prior = await gitShowToFile(repo, result.preMergeHead, 'README.md')
    expect(prior).not.toBeNull()
    if (prior) expect(readFileSync(prior, 'utf8')).toBe('base\n')
    expect(await gitShowToFile(repo, result.preMergeHead, 'src/new.ts')).toBeNull()
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree locked remove', () => {
  let repo = ''
  let worktreePath = ''

  afterEach(async () => {
    if (repo && worktreePath) await removeInstanceWorktree(repo, worktreePath)
    worktreePath = ''
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('removes a git-locked instance worktree left after a crash', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-lock-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    git(repo, 'add', 'README.md')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runId = `run-lock-${process.pid}`
    const added = await addInstanceWorktree(repo, runId)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    worktreePath = added.worktreePath
    git(repo, 'worktree', 'lock', worktreePath)

    await removeInstanceWorktree(repo, worktreePath)
    expect(existsSync(worktreePath)).toBe(false)
    worktreePath = ''
  }, 30_000)
})

describe.skipIf(!canGit)('instanceWorktree sparse path_scope', () => {
  let repo = ''
  let worktreePath = ''

  afterEach(async () => {
    if (repo && worktreePath) await removeInstanceWorktree(repo, worktreePath)
    worktreePath = ''
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('materializes only path_scope cones', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-sparse-'))
    git(repo, 'init', '--initial-branch=main')
    mkdirSync(join(repo, 'src'), { recursive: true })
    mkdirSync(join(repo, 'extra'), { recursive: true })
    writeFileSync(join(repo, 'src', 'app.ts'), 'export const n = 1\n', 'utf8')
    writeFileSync(join(repo, 'extra', 'skip.ts'), 'export const s = 1\n', 'utf8')
    git(repo, 'add', '.')
    git(
      repo,
      '-c',
      'user.email=test@example.com',
      '-c',
      'user.name=Test',
      'commit',
      '-m',
      'init'
    )

    const runId = `run-sparse-${process.pid}`
    const added = await addInstanceWorktree(repo, runId, ['src'])
    expect(added.ok).toBe(true)
    if (!added.ok) return
    worktreePath = added.worktreePath
    expect(existsSync(join(worktreePath, 'src', 'app.ts'))).toBe(true)
    expect(existsSync(join(worktreePath, 'extra', 'skip.ts'))).toBe(false)
  }, 30_000)
})

/**
 * The checkpoint commit is the only durable copy of an instance's edits once
 * its checkout is removed. `git add -A -- . :(exclude)node_modules` names an
 * ignored path, and git answers "The following paths are ignored by one of your
 * .gitignore files" with exit 1 — after staging everything correctly. The
 * non-zero exit threw the commit away, silently, for every repo that gitignores
 * node_modules (observed live 2026-09-22 12:49).
 */
describe.skipIf(!canGit)('instance worktree checkpoint commit', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function repoWith(nodeModulesIgnored: boolean): string {
    const repo = mkdtempSync(join(tmpdir(), 'vyotiq-ckpt-'))
    dirs.push(repo)
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, '.gitignore'), nodeModulesIgnored ? 'node_modules\n' : '# none\n')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 1\n')
    mkdirSync(join(repo, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
    git(repo, 'add', '.gitignore', 'app.ts')
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'init')
    return repo
  }

  function headFiles(repo: string): string[] {
    return execFileSync('git', ['show', '--name-only', '--format=', 'HEAD'], {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true
    })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
  }

  it('commits dirty edits when node_modules is gitignored', async () => {
    const repo = repoWith(true)
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    await commitDirtyInstanceWorktree(repo)

    expect(headFiles(repo)).toEqual(['app.ts'])
    expect(
      execFileSync('git', ['status', '--porcelain'], {
        cwd: repo,
        encoding: 'utf8',
        windowsHide: true
      }).trim()
    ).toBe('')
  }, 30_000)

  it('commits dirty edits without staging an unignored node_modules', async () => {
    const repo = repoWith(false)
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    await commitDirtyInstanceWorktree(repo)

    // The exclude still earns its place: provisioning junctions the parent's
    // node_modules in, and a repo without ignore coverage would commit it.
    expect(headFiles(repo)).toEqual(['app.ts'])
  }, 30_000)

  it('records tracked node_modules updates without staging untracked ones', async () => {
    const repo = repoWith(true)
    writeFileSync(join(repo, 'node_modules', 'lib.js'), 'module.exports = 1\n')
    git(repo, 'add', '-f', 'node_modules/lib.js')
    git(repo, '-c', 'user.email=t@example.com', '-c', 'user.name=T', 'commit', '-m', 'track dep')
    // Tracked mod under node_modules + untracked sibling + tracked app edit.
    writeFileSync(join(repo, 'node_modules', 'lib.js'), 'module.exports = 2\n')
    writeFileSync(join(repo, 'node_modules', 'dep', 'index.js'), 'module.exports = 9\n')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    await commitDirtyInstanceWorktree(repo)

    // `add -u` must pick the tracked node_modules file up even though the
    // `add -A` pass excludes the whole tree.
    const files = headFiles(repo)
    expect(files.sort()).toEqual(['app.ts', 'node_modules/lib.js'])
  }, 30_000)

  it('never stages node_modules content even when status lists it per-file', async () => {
    const repo = repoWith(false)
    // `showUntrackedFiles=all` breaks the old `?? node_modules/` sniff shape:
    // the guard regex missed, `git add -A -- .` staged the whole tree, and the
    // junction's contents landed in the instance branch.
    git(repo, 'config', 'status.showUntrackedFiles', 'all')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    await commitDirtyInstanceWorktree(repo)

    expect(headFiles(repo)).toEqual(['app.ts'])
  }, 30_000)

  it('excludes nested node_modules but keeps sibling files', async () => {
    const repo = repoWith(false)
    mkdirSync(join(repo, 'sub', 'node_modules'), { recursive: true })
    writeFileSync(join(repo, 'sub', 'package.json'), '{}\n')
    writeFileSync(join(repo, 'sub', 'node_modules', 'g.js'), 'module.exports = 1\n')
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    await commitDirtyInstanceWorktree(repo)

    const files = headFiles(repo)
    expect(files.sort()).toEqual(['app.ts', 'sub/package.json'])
  }, 30_000)

  it('lands the checkpoint where the literal-exclude shape dies on ignored paths', async () => {
    const repo = repoWith(true)
    writeFileSync(join(repo, 'app.ts'), 'export const a = 2\n')

    // Documented failure condition (scratch/repro-add.mjs matrix, git
    // 2.55.0.windows.3): a pathspec item whose pattern starts with the literal
    // `node_modules` makes `git add` exit 1 "The following paths are ignored by
    // one of your .gitignore files" whenever node_modules is ignored — after
    // staging everything correctly. That non-zero exit used to throw away the
    // checkpoint commit (the only durable copy of an instance's edits).
    let oldShapeError: { stderr?: Buffer } | null = null
    try {
      execFileSync('git', ['add', '-A', '--', '.', ':(exclude)node_modules'], {
        cwd: repo,
        stdio: 'pipe',
        windowsHide: true
      })
    } catch (err) {
      oldShapeError = err as { stderr?: Buffer }
    }
    expect(oldShapeError).not.toBeNull()
    expect(/ignored/i.test(String(oldShapeError?.stderr ?? ''))).toBe(true)
    git(repo, 'reset', '-q')

    await commitDirtyInstanceWorktree(repo)
    expect(headFiles(repo)).toEqual(['app.ts'])
  }, 30_000)
})

describe('linkNodeModulesBestEffort gap repair', () => {
  const dirs: string[] = []

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  function pair(): { workspace: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-nmlink-'))
    dirs.push(root)
    const workspace = join(root, 'workspace')
    const worktree = join(root, 'worktree')
    mkdirSync(join(workspace, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'typescript', 'bin', 'tsc.js'), '// tsc\n')
    mkdirSync(join(workspace, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(workspace, 'node_modules', 'vitest', 'package.json'), '{}\n')
    mkdirSync(worktree, { recursive: true })
    return { workspace, worktree }
  }

  function probesResolve(worktree: string): boolean {
    return (
      existsSync(join(worktree, 'node_modules', 'typescript', 'bin')) &&
      existsSync(join(worktree, 'node_modules', 'vitest'))
    )
  }

  it('links the parent node_modules into a fresh worktree', async () => {
    const { workspace, worktree } = pair()
    await linkNodeModulesBestEffort(workspace, worktree)
    expect(probesResolve(worktree)).toBe(true)
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(true)
  })

  it('repairs a pre-existing empty real node_modules dir', async () => {
    const { workspace, worktree } = pair()
    mkdirSync(join(worktree, 'node_modules'), { recursive: true })
    await linkNodeModulesBestEffort(workspace, worktree)
    expect(probesResolve(worktree)).toBe(true)
  })

  it('repairs a dangling node_modules junction', async () => {
    const { workspace, worktree } = pair()
    symlinkSync(join(worktree, 'missing-target'), join(worktree, 'node_modules'), 'junction')
    await linkNodeModulesBestEffort(workspace, worktree)
    expect(probesResolve(worktree)).toBe(true)
  })

  it('leaves a self-sufficient in-worktree node_modules install alone', async () => {
    const { workspace, worktree } = pair()
    mkdirSync(join(worktree, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(join(worktree, 'node_modules', 'typescript', 'bin', 'tsc.js'), '// local\n')
    mkdirSync(join(worktree, 'node_modules', 'vitest'), { recursive: true })
    await linkNodeModulesBestEffort(workspace, worktree)
    expect(lstatSync(join(worktree, 'node_modules')).isSymbolicLink()).toBe(false)
    expect(readFileSync(join(worktree, 'node_modules', 'typescript', 'bin', 'tsc.js'), 'utf8')).toBe(
      '// local\n'
    )
  })

  it('does nothing when the parent has no node_modules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-nmlink-empty-'))
    dirs.push(root)
    const workspace = join(root, 'workspace')
    const worktree = join(root, 'worktree')
    mkdirSync(workspace, { recursive: true })
    mkdirSync(worktree, { recursive: true })
    await linkNodeModulesBestEffort(workspace, worktree)
    expect(existsSync(join(worktree, 'node_modules'))).toBe(false)
  })
})

describe.skipIf(!canGit)('linkNodeModulesBestEffort fresh worktree flow', () => {
  let repo = ''
  let worktreePath = ''

  afterEach(async () => {
    if (repo && worktreePath) await removeInstanceWorktree(repo, worktreePath)
    worktreePath = ''
    if (repo && existsSync(repo)) {
      rmSync(repo, { recursive: true, force: true })
    }
    if (existsSync(userData)) {
      rmSync(userData, { recursive: true, force: true })
    }
    resetInstanceWorktreeCleanupForTests()
  })

  it('provisions resolvable node_modules/typescript/bin + node_modules/vitest', async () => {
    repo = mkdtempSync(join(tmpdir(), 'vyotiq-wt-nmlink-'))
    git(repo, 'init', '--initial-branch=main')
    writeFileSync(join(repo, 'README.md'), 'base\n', 'utf8')
    writeFileSync(join(repo, '.gitignore'), 'node_modules/\n', 'utf8')
    git(repo, 'add', 'README.md', '.gitignore')
    git(repo, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init')
    mkdirSync(join(repo, 'node_modules', 'typescript', 'bin'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'typescript', 'bin', 'tsc.js'), '// tsc\n')
    mkdirSync(join(repo, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(repo, 'node_modules', 'vitest', 'package.json'), '{}\n')

    const runId = `run-nmlink-${process.pid}`
    const added = await addInstanceWorktree(repo, runId)
    expect(added.ok).toBe(true)
    if (!added.ok) return
    worktreePath = added.worktreePath

    expect(existsSync(join(worktreePath, 'node_modules', 'typescript', 'bin'))).toBe(true)
    expect(existsSync(join(worktreePath, 'node_modules', 'vitest'))).toBe(true)
  }, 30_000)
})
