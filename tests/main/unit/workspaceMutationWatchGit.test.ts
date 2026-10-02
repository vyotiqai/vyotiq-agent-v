import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() }
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites,
  type WriteCheckpointMeta
} from '@main/agent/checkpoints'
import {
  applyWatchDiffToCheckpoint,
  diffSince,
  disposeWatch,
  parseGitStatusV2,
  setGitSnapshotEnabledForTests,
  setSnapshotFileCapForTests,
  startWatch,
  type WorkspaceDiff,
  type WorkspaceSnapshot
} from '@main/agent/workspaceMutationWatch'

/**
 * The git path of the opaque-command snapshot, against real repositories:
 * `git status` before and after instead of a capped walk, prior content of
 * clean tracked files read back from git, and copies kept only for the files
 * that were already changed or untracked.
 */

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    env: GIT_ENV,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  })
}

function initRepo(dir: string): void {
  git(dir, 'init', '-q')
  // Byte-exact restores: no eol conversion from the machine's global config.
  git(dir, 'config', 'core.autocrlf', 'false')
}

function commitAll(dir: string, message = 'c'): void {
  git(dir, 'add', '-A')
  git(dir, 'commit', '-q', '-m', message)
}

let root: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  root = mkdtempSync(join(tmpdir(), 'vyotiq-gitwatch-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-gitwatch-run-'))
})

afterEach(() => {
  setSnapshotFileCapForTests(null)
  setGitSnapshotEnabledForTests(null)
  resetWriteCheckpointsForTests()
  rmSync(root, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

/** Watch `workspace` around `command`, record into a checkpoint, return what it saw. */
async function watch(
  workspace: string,
  command: () => void
): Promise<{ snap: WorkspaceSnapshot; diff: WorkspaceDiff; meta: WriteCheckpointMeta }> {
  beginWriteCheckpoint(runDir, workspace)
  const snap = await startWatch(workspace)
  command()
  const diff = await diffSince(snap)
  await applyWatchDiffToCheckpoint(snap, diff, { runDir })
  await disposeWatch(snap)
  const meta = finalizeWriteCheckpoint(runDir)!
  return { snap, diff, meta }
}

function undo(workspace: string, meta: WriteCheckpointMeta): void {
  resolveWrites(runDir, workspace, { checkpointId: meta.id, action: 'discard' })
}

describe('workspaceMutationWatch git path', () => {
  it('restores a clean tracked file far past the walk cap, copying nothing up front', async () => {
    initRepo(root)
    // The walk would cover four files; the edit lands on the twentieth.
    setSnapshotFileCapForTests(4)
    mkdirSync(join(root, 'src'))
    for (let i = 0; i < 20; i++) writeFileSync(join(root, 'src', `f${String(i).padStart(2, '0')}.txt`), `v${i}\n`)
    commitAll(root)

    const { snap, diff, meta } = await watch(root, () => {
      writeFileSync(join(root, 'src', 'f19.txt'), 'changed by the command\n')
    })
    expect(snap.git).toBeDefined()
    expect(snap.files.size).toBe(0)
    expect(diff).toEqual({ created: [], modified: ['src/f19.txt'], deleted: [] })
    expect(meta.files).toEqual([expect.objectContaining({ path: 'src/f19.txt', action: 'modified', undoable: true })])
    undo(root, meta)
    expect(readFileSync(join(root, 'src', 'f19.txt'), 'utf8')).toBe('v19\n')
  })

  it('reports a new untracked file as created, and Undo removes it', async () => {
    initRepo(root)
    writeFileSync(join(root, 'keep.txt'), 'keep\n')
    commitAll(root)
    const { diff, meta } = await watch(root, () => {
      mkdirSync(join(root, 'gen'))
      writeFileSync(join(root, 'gen', 'out.txt'), 'made\n')
    })
    expect(diff.created).toEqual(['gen/out.txt'])
    undo(root, meta)
    expect(existsSync(join(root, 'gen', 'out.txt'))).toBe(false)
    expect(existsSync(join(root, 'keep.txt'))).toBe(true)
  })

  it('restores an already-dirty file to its pre-command content, not HEAD', async () => {
    initRepo(root)
    writeFileSync(join(root, 'wip.ts'), 'committed\n')
    commitAll(root)
    writeFileSync(join(root, 'wip.ts'), 'uncommitted work\n')
    writeFileSync(join(root, 'notes.md'), 'untracked notes\n')

    const { snap, diff, meta } = await watch(root, () => {
      writeFileSync(join(root, 'wip.ts'), 'formatter rewrote it\n')
      writeFileSync(join(root, 'notes.md'), 'clobbered\n')
    })
    expect([...snap.files.keys()].sort()).toEqual(['notes.md', 'wip.ts'])
    expect(diff.modified.sort()).toEqual(['notes.md', 'wip.ts'])
    undo(root, meta)
    expect(readFileSync(join(root, 'wip.ts'), 'utf8')).toBe('uncommitted work\n')
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('untracked notes\n')
  })

  it('restores clean and untracked files a command deleted', async () => {
    initRepo(root)
    writeFileSync(join(root, 'tracked.txt'), 'tracked\n')
    commitAll(root)
    writeFileSync(join(root, 'scratch.txt'), 'scratch\n')
    const { diff, meta } = await watch(root, () => {
      unlinkSync(join(root, 'tracked.txt'))
      unlinkSync(join(root, 'scratch.txt'))
    })
    expect(diff.deleted.sort()).toEqual(['scratch.txt', 'tracked.txt'])
    undo(root, meta)
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('tracked\n')
    expect(readFileSync(join(root, 'scratch.txt'), 'utf8')).toBe('scratch\n')
  })

  it('follows a HEAD move: a file the command changed and committed is still restorable', async () => {
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'original\n')
    commitAll(root)
    const { diff, meta } = await watch(root, () => {
      writeFileSync(join(root, 'a.txt'), 'committed by the command\n')
      writeFileSync(join(root, 'b.txt'), 'new and committed\n')
      commitAll(root, 'by the command')
    })
    expect(diff.modified).toEqual(['a.txt'])
    expect(diff.created).toEqual(['b.txt'])
    undo(root, meta)
    expect(readFileSync(join(root, 'a.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(root, 'b.txt'))).toBe(false)
  })

  it('records an oversized change as not undoable instead of copying it', async () => {
    initRepo(root)
    const big = Buffer.alloc(9 * 1024 * 1024, 1)
    writeFileSync(join(root, 'big.bin'), big)
    writeFileSync(join(root, 'small.txt'), 'small\n')
    commitAll(root)
    // Already untracked and over the per-file cap: no copy before either.
    writeFileSync(join(root, 'big-untracked.bin'), big)

    const { snap, meta } = await watch(root, () => {
      writeFileSync(join(root, 'big.bin'), Buffer.alloc(9 * 1024 * 1024, 2))
      writeFileSync(join(root, 'big-untracked.bin'), Buffer.alloc(9 * 1024 * 1024 + 1, 3))
      writeFileSync(join(root, 'small.txt'), 'edited\n')
    })
    expect(snap.files.get('big-untracked.bin')?.blobPath).toBeUndefined()
    const byPath = new Map(meta.files.map((f) => [f.path, f]))
    expect(byPath.get('big.bin')).toMatchObject({ action: 'modified', undoable: false })
    expect(byPath.get('big-untracked.bin')).toMatchObject({ action: 'modified', undoable: false })
    expect(byPath.get('small.txt')).toMatchObject({ action: 'modified', undoable: true })
  })

  it('never snapshots or reports a .gitignore\'d directory', async () => {
    initRepo(root)
    writeFileSync(join(root, '.gitignore'), 'deps/\n')
    mkdirSync(join(root, 'deps', 'pkg'), { recursive: true })
    writeFileSync(join(root, 'deps', 'pkg', 'index.js'), 'old\n')
    writeFileSync(join(root, 'app.js'), 'app\n')
    commitAll(root)
    writeFileSync(join(root, 'deps', 'pkg', 'dirty-but-ignored.js'), 'x\n')

    const { snap, diff } = await watch(root, () => {
      writeFileSync(join(root, 'deps', 'pkg', 'index.js'), 'new\n')
      writeFileSync(join(root, 'deps', 'pkg', 'added.js'), 'added\n')
    })
    expect([...snap.files.keys()]).toEqual([])
    expect(diff).toEqual({ created: [], modified: [], deleted: [] })
  })

  it('watches a workspace that is a subdirectory of the repository', async () => {
    initRepo(root)
    mkdirSync(join(root, 'pkg', 'src'), { recursive: true })
    writeFileSync(join(root, 'pkg', 'src', 'x.ts'), 'x\n')
    writeFileSync(join(root, 'outside.txt'), 'outside\n')
    commitAll(root)
    const workspace = join(root, 'pkg')
    const { snap, diff, meta } = await watch(workspace, () => {
      writeFileSync(join(workspace, 'src', 'x.ts'), 'y\n')
      writeFileSync(join(root, 'outside.txt'), 'not ours\n')
    })
    expect(snap.git?.prefix).toBe('pkg/')
    expect(diff).toEqual({ created: [], modified: ['src/x.ts'], deleted: [] })
    undo(workspace, meta)
    expect(readFileSync(join(workspace, 'src', 'x.ts'), 'utf8')).toBe('x\n')
  })

  it('falls back to the walk when an enclosing repository ignores the workspace', async () => {
    initRepo(root)
    writeFileSync(join(root, '.gitignore'), 'ignored/\n')
    commitAll(root)
    const workspace = join(root, 'ignored', 'ws')
    mkdirSync(workspace, { recursive: true })
    writeFileSync(join(workspace, 'f.txt'), 'before\n')
    const { snap, diff, meta } = await watch(workspace, () => {
      writeFileSync(join(workspace, 'f.txt'), 'after\n')
    })
    expect(snap.git).toBeUndefined()
    expect(diff.modified).toEqual(['f.txt'])
    undo(workspace, meta)
    expect(readFileSync(join(workspace, 'f.txt'), 'utf8')).toBe('before\n')
  })

  it('still walks a workspace that is not a repository', async () => {
    writeFileSync(join(root, 'plain.txt'), 'before\n')
    const { snap, diff, meta } = await watch(root, () => {
      writeFileSync(join(root, 'plain.txt'), 'after\n')
      writeFileSync(join(root, 'new.txt'), 'new\n')
    })
    expect(snap.git).toBeUndefined()
    expect(diff.modified).toEqual(['plain.txt'])
    expect(diff.created).toEqual(['new.txt'])
    undo(root, meta)
    expect(readFileSync(join(root, 'plain.txt'), 'utf8')).toBe('before\n')
    expect(existsSync(join(root, 'new.txt'))).toBe(false)
  })

  it('uses the walk inside a repository when the git path is switched off', async () => {
    initRepo(root)
    writeFileSync(join(root, 'a.txt'), 'a\n')
    commitAll(root)
    setGitSnapshotEnabledForTests(false)
    const snap = await startWatch(root)
    expect(snap.git).toBeUndefined()
    expect(snap.files.has('a.txt')).toBe(true)
    await disposeWatch(snap)
  })
})

describe('parseGitStatusV2', () => {
  const oid = 'a'.repeat(40)
  const zero = '0'.repeat(40)

  it('keeps paths with spaces whole and reads HEAD\'s side of tracked entries', () => {
    const out = [
      `# branch.oid ${oid}`,
      '# branch.head main',
      `1 .M N... 100644 100644 100644 ${oid} ${oid} dir/with space.txt`,
      `1 A. N... 000000 100644 100644 ${zero} ${oid} added.txt`,
      '? new file.txt',
      '? nested/',
      ''
    ].join('\0')
    const read = parseGitStatusV2(out, '')!
    expect(read.headOid).toBe(oid)
    expect(read.paths.get('dir/with space.txt')).toMatchObject({ untracked: false, headOid: oid, headMode: '100644' })
    expect(read.paths.get('added.txt')?.headOid).toBeUndefined()
    expect(read.paths.get('new file.txt')).toMatchObject({ untracked: true, dir: false })
    expect(read.paths.get('nested')).toMatchObject({ untracked: true, dir: true })
  })

  it('merges a path listed twice (git rm --cached) and strips the workspace prefix', () => {
    const out = [
      '# branch.oid (initial)',
      `1 D. N... 100644 000000 000000 ${oid} ${zero} pkg/a.txt`,
      '? pkg/a.txt',
      ''
    ].join('\0')
    const read = parseGitStatusV2(out, 'pkg/')!
    expect(read.headOid).toBeNull()
    expect(read.paths.get('a.txt')).toMatchObject({ untracked: true, headOid: oid })
  })

  it('refuses a listing it cannot place: a path outside the prefix, an ignored root', () => {
    expect(parseGitStatusV2('? other/a.txt\0', 'pkg/')).toBeNull()
    expect(parseGitStatusV2('! ign/\0', 'ign/ws/')).toBeNull()
    expect(parseGitStatusV2('! pkg/node_modules/\0', 'pkg/')?.paths.size).toBe(0)
  })
})
