import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  newestAgentWrite,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { resetTaskFileStatsCacheForTests, taskFileDiff } from '@main/agent/taskFileDiff'
import { HunkUndoRefused, resetHunkRestoresForTests, restoreHunk, undoHunk } from '@main/agent/hunkUndo'
import { diffFingerprint, hunkIdentity, parseUnifiedHunks } from '@shared/utils/hunkPatch'

let workspace: string
let runDir: string
const RUN = 'run-hunks'

const BEFORE = `${Array.from({ length: 24 }, (_, i) => `line ${i + 1}`).join('\n')}\n`

async function run(tool: string, args: Record<string, unknown>): Promise<void> {
  const result = await executeTool(tool, JSON.stringify(args), workspace, new AbortController().signal, { runDir })
  expect(result.ok).toBe(true)
}

async function turn(body: () => Promise<void>): Promise<string> {
  beginWriteCheckpoint(runDir, workspace)
  await body()
  return finalizeWriteCheckpoint(runDir)!.id
}

/** What the Changes review would send for hunk `index` of the file's diff as it is now. */
function shown(path: string, index: number) {
  const diff = taskFileDiff(runDir, workspace, path).diff!
  const hunk = parseUnifiedHunks(diff)[index]!
  return { path, hunk: hunkIdentity(hunk), diffHash: diffFingerprint(diff) }
}

const read = (path: string): string => readFileSync(join(workspace, path), 'utf8')
const sha = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

async function twoHunks(): Promise<void> {
  await turn(async () => {
    await run('str_replace', { path: 'a.txt', old_string: 'line 3\n', new_string: 'line three\n' })
    await run('str_replace', { path: 'a.txt', old_string: 'line 20\n', new_string: 'line twenty\nline 20.5\n' })
  })
}

beforeEach(() => {
  resetWriteCheckpointsForTests()
  resetTaskFileStatsCacheForTests()
  resetHunkRestoresForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-hunk-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-hunk-run-'))
  writeFileSync(join(workspace, 'a.txt'), BEFORE, 'utf8')
  toolTodoWrite(runDir, [{ id: '1', content: 'Edit the files', status: 'in_progress' }])
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('undoHunk', () => {
  it('takes one hunk out of the file and leaves the rest of the task’s change', async () => {
    await twoHunks()
    expect(parseUnifiedHunks(taskFileDiff(runDir, workspace, 'a.txt').diff!)).toHaveLength(2)

    const result = undoHunk(runDir, workspace, RUN, shown('a.txt', 1))
    expect(result.path).toBe('a.txt')
    expect(read('a.txt')).toBe(BEFORE.replace('line 3\n', 'line three\n'))

    const after = taskFileDiff(runDir, workspace, 'a.txt')
    expect(after).toMatchObject({ action: 'modified', add: 1, del: 1 })
    expect(parseUnifiedHunks(after.diff!)).toHaveLength(1)
  })

  it('keeps the write the agent’s: still waiting, its hash moved with the file, so the file’s Undo still works', async () => {
    await twoHunks()
    undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    const record = newestAgentWrite(runDir, workspace, 'a.txt')!
    expect(record.settled).toBeNull()
    expect(record.hash).toBe(sha(read('a.txt')))

    const undone = resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] })
    expect(undone.discarded).toEqual(['a.txt'])
    expect(undone.conflicted).toEqual([])
    expect(read('a.txt')).toBe(BEFORE)
  })

  it('leaves your own later edit reading as yours: the hash does not move, and the file’s Undo still refuses', async () => {
    await twoHunks()
    writeFileSync(join(workspace, 'a.txt'), read('a.txt').replace('line 12\n', 'mine\n'), 'utf8')
    const hashBefore = newestAgentWrite(runDir, workspace, 'a.txt')!.hash
    undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    expect(read('a.txt')).toContain('mine\n')
    expect(read('a.txt')).toContain('line 3\n')
    expect(newestAgentWrite(runDir, workspace, 'a.txt')!.hash).toBe(hashBefore)
    expect(resolveWrites(runDir, workspace, { action: 'discard', paths: ['a.txt'] }).conflicted).toEqual(['a.txt'])
  })

  it('refuses when the file changed since its diff was shown', async () => {
    await twoHunks()
    const target = shown('a.txt', 0)
    writeFileSync(join(workspace, 'a.txt'), read('a.txt').replace('line 12\n', 'changed\n'), 'utf8')
    expect(() => undoHunk(runDir, workspace, RUN, target)).toThrow(HunkUndoRefused)
    expect(() => undoHunk(runDir, workspace, RUN, target)).toThrow(/changed since its diff was shown/)
    expect(read('a.txt')).toContain('line three\n')
  })

  it('refuses a hunk the diff does not have, even when the diff is the one shown', async () => {
    await twoHunks()
    const target = shown('a.txt', 0)
    expect(() => undoHunk(runDir, workspace, RUN, { ...target, hunk: { ...target.hunk, hash: 'other' } })).toThrow(
      /no longer in the diff/
    )
    expect(() => undoHunk(runDir, workspace, RUN, { ...target, hunk: { ...target.hunk, newStart: 99 } })).toThrow(
      /no longer in the diff/
    )
  })

  it('sends a created or deleted file to the file’s own Undo', async () => {
    await turn(() => run('edit', { path: 'new.txt', contents: 'one\ntwo\n' }))
    expect(() => undoHunk(runDir, workspace, RUN, shown('new.txt', 0))).toThrow(/created that file/)
    expect(read('new.txt')).toBe('one\ntwo\n')
  })

  it('refuses a file already kept or undone', async () => {
    await twoHunks()
    const target = shown('a.txt', 0)
    resolveWrites(runDir, workspace, { action: 'keep', paths: ['a.txt'] })
    expect(() => undoHunk(runDir, workspace, RUN, target)).toThrow(/already kept/)
  })

  it('refuses a file the task did not write', () => {
    expect(() =>
      undoHunk(runDir, workspace, RUN, {
        path: 'a.txt',
        hunk: { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, hash: 'x' },
        diffHash: 'y'
      })
    ).toThrow(/did not write/)
  })

  it('keeps a CRLF file CRLF', async () => {
    const crlf = BEFORE.replace(/\n/g, '\r\n')
    writeFileSync(join(workspace, 'a.txt'), crlf, 'utf8')
    await turn(() => run('str_replace', { path: 'a.txt', old_string: 'line 10', new_string: 'line ten\r\nline 10.5' }))
    undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    expect(read('a.txt')).toBe(crlf)
  })
})

describe('restoreHunk', () => {
  it('puts an undone hunk back, where other undos moved it', async () => {
    await twoHunks()
    const agents = read('a.txt')
    const second = undoHunk(runDir, workspace, RUN, shown('a.txt', 1))
    undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    expect(read('a.txt')).toBe(BEFORE)

    expect(restoreHunk(runDir, workspace, RUN, second.restoreToken)).toEqual({ path: 'a.txt' })
    expect(read('a.txt')).toBe(BEFORE.replace('line 20\n', 'line twenty\nline 20.5\n'))
    expect(newestAgentWrite(runDir, workspace, 'a.txt')!.hash).toBe(sha(read('a.txt')))
    // A token is spent once.
    expect(() => restoreHunk(runDir, workspace, RUN, second.restoreToken)).toThrow(/nothing to put back/)
    expect(agents).not.toBe(read('a.txt'))
  })

  it('leaves the file alone when it changed where the hunk was', async () => {
    await twoHunks()
    const { restoreToken } = undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    writeFileSync(join(workspace, 'a.txt'), read('a.txt').replace('line 3\n', 'yours\n'), 'utf8')
    const before = read('a.txt')
    expect(() => restoreHunk(runDir, workspace, RUN, restoreToken)).toThrow(/changed where the hunk was/)
    expect(read('a.txt')).toBe(before)
  })

  it('does not hand one task’s token to another', async () => {
    await twoHunks()
    const { restoreToken } = undoHunk(runDir, workspace, RUN, shown('a.txt', 0))
    expect(() => restoreHunk(runDir, workspace, 'run-other', restoreToken)).toThrow(/nothing to put back/)
  })
})
