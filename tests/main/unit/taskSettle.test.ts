import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { canGit } from '../../helpers/canGit'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

// The run store and the live registry are the IPC layer's; here the run dir is a temp dir.
const { runState } = vi.hoisted(() => ({
  runState: { runDir: '', active: false, events: [] as unknown[] }
}))
vi.mock('@main/storage/paths', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@main/storage/paths')>()),
  resolveRunDir: () => runState.runDir
}))
vi.mock('@main/agent/state', () => ({
  runExists: () => true,
  appendEvent: (_dir: string, event: unknown) => {
    runState.events.push(event)
  }
}))
vi.mock('@main/agent/runRegistry', () => ({ isActive: () => runState.active }))
vi.mock('@main/agent/runListCache', () => ({ invalidateListRunsCache: () => undefined }))
vi.mock('@main/git/gitStatusEvents', () => ({ emitGitStatusChanged: () => undefined }))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpointMeta,
  keepWritesForPaths,
  listCheckpointMetas,
  reopenWrites,
  resetWriteCheckpointsForTests,
  resolveWrites,
  rewindWritesFrom
} from '@main/agent/checkpoints'
import { outcomeFiles, readTaskCommit, readTaskOutcome } from '@main/agent/taskOutcome'
import { settleTaskAfterCommit, undoTaskCommit } from '@main/agent/taskSettle'
import { commitAll, commitChangedPaths, readHeadCommit, undoLatestCommit } from '@main/git/git'

let workspace: string
let runDir: string

function read(rel: string): string {
  return readFileSync(join(workspace, rel), 'utf8')
}

/** One turn: `a.txt` modified, `new.txt` created, `gone.txt` deleted. */
async function turn(): Promise<string> {
  const cp = beginWriteCheckpoint(runDir, workspace, 0)
  await cp.recordPrior('a.txt', 'write')
  writeFileSync(join(workspace, 'a.txt'), 'agent\n', 'utf8')
  await cp.recordPrior('new.txt', 'write')
  writeFileSync(join(workspace, 'new.txt'), 'fresh\n', 'utf8')
  await cp.recordPrior('gone.txt', 'delete')
  unlinkSync(join(workspace, 'gone.txt'))
  const meta = finalizeWriteCheckpoint(runDir)
  return meta!.id
}

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-settle-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-settle-run-'))
  runState.runDir = runDir
  runState.active = false
  runState.events = []
  writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
  writeFileSync(join(workspace, 'gone.txt'), 'old\n', 'utf8')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('taking back Keep and Undo', () => {
  it('Undo of Keep all puts every file back to waiting, and the checkpoint with them', async () => {
    const id = await turn()
    const kept = resolveWrites(runDir, workspace, { checkpointId: id, action: 'keep' })
    expect(kept.fullyResolved).toBe(true)
    expect(getWriteCheckpointMeta(runDir, id)?.resolved).toBe(true)

    const back = reopenWrites(runDir, workspace, { checkpointId: id, paths: kept.kept })
    expect(back.reopened.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    const meta = getWriteCheckpointMeta(runDir, id)!
    expect(meta.resolved).toBeUndefined()
    expect(meta.undone).toBeUndefined()
    expect(meta.files.every((f) => f.resolved === undefined)).toBe(true)
    // Nothing on disk moved: a Keep never did.
    expect(read('a.txt')).toBe('agent\n')
    // Waiting again, so Keep and Undo work on it as before.
    expect(resolveWrites(runDir, workspace, { action: 'discard' }).discarded.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
  })

  it('Undo of Undo all brings back what the agent wrote, created and deleted', async () => {
    const id = await turn()
    const undone = resolveWrites(runDir, workspace, { checkpointId: id, action: 'discard' })
    expect(read('a.txt')).toBe('hello\n')
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
    expect(read('gone.txt')).toBe('old\n')

    const back = reopenWrites(runDir, workspace, { checkpointId: id, paths: undone.discarded })
    expect(back.reopened.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    expect(back.conflicted).toEqual([])
    expect(read('a.txt')).toBe('agent\n')
    expect(read('new.txt')).toBe('fresh\n')
    expect(existsSync(join(workspace, 'gone.txt'))).toBe(false)
    expect(back.checkpoints[0]?.files.every((f) => !f.resolved)).toBe(true)
  })

  it('leaves an undone file that changed since as it is', async () => {
    const id = await turn()
    resolveWrites(runDir, workspace, { checkpointId: id, action: 'discard' })
    writeFileSync(join(workspace, 'a.txt'), 'mine\n', 'utf8')
    const back = reopenWrites(runDir, workspace, { paths: ['a.txt'] })
    expect(back.conflicted).toEqual(['a.txt'])
    expect(back.reopened).toEqual([])
    expect(read('a.txt')).toBe('mine\n')
    expect(getWriteCheckpointMeta(runDir, id)?.files.find((f) => f.path === 'a.txt')?.resolved).toBe('discarded')
  })

  it('un-keeps one file by path, from the newest turn that wrote it', async () => {
    const id = await turn()
    resolveWrites(runDir, workspace, { action: 'keep', paths: ['a.txt'] })
    const back = reopenWrites(runDir, workspace, { paths: ['a.txt'] })
    expect(back.reopened).toEqual(['a.txt'])
    expect(back.checkpoints.map((c) => c.checkpointId)).toEqual([id])
  })

  it('never reopens what a rewind settled', async () => {
    const id = await turn()
    rewindWritesFrom(runDir, workspace, 0)
    const back = reopenWrites(runDir, workspace, { paths: ['a.txt', 'new.txt'] })
    expect(back.reopened).toEqual([])
    expect(getWriteCheckpointMeta(runDir, id)?.files.every((f) => f.rewound)).toBe(true)
  })
})

describe('task outcome', () => {
  it('marks each file by its newest write', async () => {
    const id = await turn()
    resolveWrites(runDir, workspace, { action: 'keep', paths: ['a.txt'] })
    expect(outcomeFiles(listCheckpointMetas(runDir))).toEqual([
      { path: 'a.txt', mark: 'kept' },
      { path: 'gone.txt', mark: 'pending' },
      { path: 'new.txt', mark: 'pending' }
    ])
    resolveWrites(runDir, workspace, { checkpointId: id, action: 'discard' })
    const outcome = await readTaskOutcome(runDir)
    expect(outcome.files).toEqual([
      { path: 'a.txt', mark: 'kept' },
      { path: 'gone.txt', mark: 'undone' },
      { path: 'new.txt', mark: 'undone' }
    ])
    expect(outcome.commit).toBeUndefined()
  })

  it('keepWritesForPaths keeps only the named files still waiting', async () => {
    const id = await turn()
    expect(keepWritesForPaths(runDir, workspace, ['a.txt', 'elsewhere.txt'])).toEqual([{ checkpointId: id, path: 'a.txt' }])
    expect(keepWritesForPaths(runDir, workspace, ['a.txt'])).toEqual([])
  })
})

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' })
}

function initRepo(): void {
  git(workspace, 'init', '--initial-branch=main')
  git(workspace, 'config', 'user.email', 'test@example.com')
  git(workspace, 'config', 'user.name', 'Test')
  git(workspace, 'config', 'core.autocrlf', 'false')
  git(workspace, 'add', '-A')
  git(workspace, 'commit', '-m', 'base')
}

describe.skipIf(!canGit)('commit from a task, and taking it back', () => {
  it('records the commit, keeps what it took, and Undo takes it back with the changes staged', async () => {
    initRepo()
    const base = (await readHeadCommit(workspace))!.sha
    await turn()
    const commit = await commitAll(workspace, 'task work', false, 'all')
    const settled = await settleTaskAfterCommit(workspace, 'run-1', commit)
    const head = (await readHeadCommit(workspace))!
    expect(settled).toEqual({
      sha: head.sha,
      branch: 'main',
      kept: expect.arrayContaining(['a.txt', 'new.txt', 'gone.txt']),
      undoable: true
    })
    expect((await commitChangedPaths(workspace, head.sha)).sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    const outcome = await readTaskOutcome(runDir)
    expect(outcome.commit?.sha).toBe(head.sha)
    expect(outcome.files.every((f) => f.mark === 'kept')).toBe(true)

    const back = await undoTaskCommit(workspace, 'run-1', head.sha)
    expect(back.reopened.sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    expect((await readHeadCommit(workspace))!.sha).toBe(base)
    // Soft: the work is still there, staged.
    expect(read('a.txt')).toBe('agent\n')
    expect(git(workspace, 'diff', '--cached', '--name-only').trim().split('\n').sort()).toEqual(['a.txt', 'gone.txt', 'new.txt'])
    expect(readTaskCommit(runDir)).toBeNull()
    expect((await readTaskOutcome(runDir)).files.every((f) => f.mark === 'pending')).toBe(true)
  })

  it('does not record a commit that took none of the task', async () => {
    initRepo()
    writeFileSync(join(workspace, 'other.txt'), 'x\n', 'utf8')
    const commit = await commitAll(workspace, 'unrelated', false, 'all')
    expect(await settleTaskAfterCommit(workspace, 'run-1', commit)).toBeUndefined()
    expect(readTaskCommit(runDir)).toBeNull()
  })

  it('refuses once the commit is no longer HEAD, or has been pushed', async () => {
    initRepo()
    writeFileSync(join(workspace, 'a.txt'), 'one\n', 'utf8')
    git(workspace, 'commit', '-am', 'one')
    const one = (await readHeadCommit(workspace))!.sha
    writeFileSync(join(workspace, 'a.txt'), 'two\n', 'utf8')
    git(workspace, 'commit', '-am', 'two')
    await expect(undoLatestCommit(workspace, one)).rejects.toThrow(/no longer the latest/)

    const two = (await readHeadCommit(workspace))!.sha
    git(workspace, 'update-ref', 'refs/remotes/origin/main', two)
    await expect(undoLatestCommit(workspace, two)).rejects.toThrow(/pushed/)
    expect((await readHeadCommit(workspace))!.sha).toBe(two)
  })

  it('refuses the first commit of a repository', async () => {
    initRepo()
    const base = (await readHeadCommit(workspace))!.sha
    await expect(undoLatestCommit(workspace, base)).rejects.toThrow(/first commit/)
  })
})
