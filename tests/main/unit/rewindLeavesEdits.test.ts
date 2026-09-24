import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  existsSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { ChatMessage } from '@shared/ipc'

// The copy of one file fails. The fs builtin namespace is frozen in ESM, so a
// hoisted module mock with a test-controlled route is the repo pattern
// (editTools.test.ts). Unrouted copies go straight through.
const { fsRoute } = vi.hoisted(() => ({
  fsRoute: {
    /** Fail the copy whose source ends with this — a restore from a checkpoint copy. */
    failCopyFrom: null as string | null,
    /** The name of each workspace file a copy wrote, in order. */
    copied: [] as string[],
    /** Only copies into this folder count — Redo's snapshot of the run is not a restore. */
    workspace: ''
  }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    copyFileSync: (src: import('fs').PathLike, dest: import('fs').PathLike, mode?: number): void => {
      if (fsRoute.workspace && String(dest).startsWith(fsRoute.workspace)) {
        fsRoute.copied.push(String(dest).split(/[\\/]/).pop() ?? '')
      }
      if (fsRoute.failCopyFrom != null && String(src).replace(/\\/g, '/').endsWith(fsRoute.failCopyFrom)) {
        throw Object.assign(new Error('EBUSY: resource busy or locked, copyfile'), { code: 'EBUSY' })
      }
      actual.copyFileSync(src, dest, mode)
    }
  }
})

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-rw-ud-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-rw-app'),
    isPackaged: false
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  planRewindWritesAcrossRuns,
  resetWriteCheckpointsForTests,
  resolveWrites,
  rewindWritesFrom
} from '@main/agent/checkpoints'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { prepareRewindToUserMessage } from '@main/agent/rewindRun'
import {
  appendEvent,
  createRun,
  flushEventAppends,
  loadEventsAsync,
  loadMessages,
  syncMessagesAsync
} from '@main/agent/state'

let workspace: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-rw-ws-'))
  fsRoute.workspace = workspace
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-rw-run-'))
  writeFileSync(join(workspace, 'a.txt'), 'a0\n', 'utf8')
  writeFileSync(join(workspace, 'b.txt'), 'b0\n', 'utf8')
  toolTodoWrite(runDir, [{ id: '1', content: 'Edit', status: 'in_progress' }])
})

afterEach(() => {
  fsRoute.failCopyFrom = null
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

const read = (name: string): string => readFileSync(join(workspace, name), 'utf8')

/** Run 2 (the user message at index 2) changes a.txt and b.txt. */
async function run2Writes(): Promise<string> {
  const cp = beginWriteCheckpoint(runDir, workspace, 2)
  await cp.recordPrior('a.txt', 'write')
  await cp.recordPrior('b.txt', 'write')
  writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
  writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
  return finalizeWriteCheckpoint(runDir)!.id
}

describe('a rewind across several turns that wrote the same file', () => {
  /** A turn answering the user message at `index` writes `content` into each file. */
  async function turn(index: number, files: Record<string, string>): Promise<void> {
    const cp = beginWriteCheckpoint(runDir, workspace, index)
    for (const name of Object.keys(files)) await cp.recordPrior(name, 'write')
    for (const [name, content] of Object.entries(files)) writeFileSync(join(workspace, name), content, 'utf8')
    finalizeWriteCheckpoint(runDir)
    // Distinct checkpoint times, so newest-first is unambiguous.
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  it('counts a file two turns wrote once, and puts it back as it was before both', async () => {
    await turn(2, { 'a.txt': 'a2\n' })
    await turn(4, { 'a.txt': 'a4\n' })
    const plan = planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 2, workspace)
    expect(plan.files).toEqual([{ path: 'a.txt', action: 'modified', undoable: true }])
    const result = rewindWritesFrom(runDir, workspace, 2)
    expect(result.restored).toEqual(['a.txt'])
    expect(result.edited).toEqual([])
    expect(read('a.txt')).toBe('a0\n')
  })

  it('says ahead of time that your edit between the two turns is where the file stops', async () => {
    await turn(2, { 'a.txt': 'a2\n' })
    writeFileSync(join(workspace, 'a.txt'), 'mine between\n', 'utf8')
    await turn(4, { 'a.txt': 'a4\n' })
    const plan = planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 2, workspace)
    // The preview no longer promises a restore the rewind will refuse.
    // Turn 4's write comes off, then your edit stops it: back partway.
    expect(plan.files).toEqual([{ path: 'a.txt', action: 'modified', undoable: true, edited: true, partway: true }])
    const result = rewindWritesFrom(runDir, workspace, 2)
    expect(result.restored).toEqual([])
    expect(result.edited).toEqual(['a.txt'])
    expect(read('a.txt')).toBe('mine between\n')
  })

  it('marks a file a turn created and a later one changed as added — the rewind removes it', async () => {
    await turn(2, { 'new.txt': 'n2\n' })
    await turn(4, { 'new.txt': 'n4\n' })
    const plan = planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 2, workspace)
    expect(plan.files).toEqual([{ path: 'new.txt', action: 'created', undoable: true }])
    const result = rewindWritesFrom(runDir, workspace, 2)
    expect(result.restored).toEqual(['new.txt'])
    expect(existsSync(join(workspace, 'new.txt'))).toBe(false)
  })
})

describe('rewind and files changed since the agent wrote them', () => {
  it('leaves a file you changed after the agent, and still rewinds the rest', async () => {
    await run2Writes()
    writeFileSync(join(workspace, 'b.txt'), 'mine\n', 'utf8')

    const result = rewindWritesFrom(runDir, workspace, 2)

    // It used to count as a failure: history stayed, a.txt was already put back.
    expect(result.undoableRestoreFailed).toBe(false)
    expect(result.restored).toEqual(['a.txt'])
    expect(result.edited).toEqual(['b.txt'])
    expect(read('a.txt')).toBe('a0\n')
    expect(read('b.txt')).toBe('mine\n')
  })

  it('says which files the preview will leave alone', async () => {
    await run2Writes()
    writeFileSync(join(workspace, 'b.txt'), 'mine\n', 'utf8')

    const plan = planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 2, workspace)
    expect(plan.files).toEqual([
      { path: 'a.txt', action: 'modified', undoable: true },
      { path: 'b.txt', action: 'modified', undoable: true, edited: true }
    ])
    // Without the workspace the preview does not guess.
    expect(planRewindWritesAcrossRuns([{ runDir, selection: 'anchored' }], 2).files.some((f) => f.edited)).toBe(false)
  })

  it('touches nothing when a copy to restore from is missing', async () => {
    const id = await run2Writes()
    // Lose a.txt's copy; b.txt is restored first (newest file first), so a
    // restore that stops at a.txt would already have changed b.txt.
    unlinkSync(join(runDir, 'checkpoints', id, 'files', 'a.txt'))

    const result = rewindWritesFrom(runDir, workspace, 2)

    expect(result.undoableRestoreFailed).toBe(true)
    expect(result.restored).toEqual([])
    expect(read('a.txt')).toBe('a2\n')
    expect(read('b.txt')).toBe('b2\n')
  })

  it('Undo leaves a deleted file someone put back with other content, and says so', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('b.txt', 'delete')
    unlinkSync(join(workspace, 'b.txt'))
    const meta = finalizeWriteCheckpoint(runDir)!
    writeFileSync(join(workspace, 'b.txt'), 'someone else\n', 'utf8')

    const result = resolveWrites(runDir, workspace, { checkpointId: meta.id, action: 'discard' })

    // It used to be marked discarded, as if it had been restored.
    expect(result.conflicted).toEqual(['b.txt'])
    expect(result.discarded).toEqual([])
    expect(read('b.txt')).toBe('someone else\n')
  })

  it('still restores a deleted file nobody put back', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    await cp.recordPrior('b.txt', 'delete')
    unlinkSync(join(workspace, 'b.txt'))
    const meta = finalizeWriteCheckpoint(runDir)!
    expect(existsSync(join(workspace, 'b.txt'))).toBe(false)

    const result = resolveWrites(runDir, workspace, { checkpointId: meta.id, action: 'discard' })
    expect(result.discarded).toEqual(['b.txt'])
    expect(read('b.txt')).toBe('b0\n')
    expect(readdirSync(workspace).sort()).toEqual(['a.txt', 'b.txt'])
  })
})

describe('prepareRewindToUserMessage with a file you changed since', () => {
  it('rewinds the record and the other files, and reports the one it left', async () => {
    const runId = `run-${Date.now()}`
    const dir = createRun(workspace, runId, 'test')
    await syncMessagesAsync(dir, [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'edited a and b' }
    ])
    const cp = beginWriteCheckpoint(dir, workspace, 2)
    await cp.recordPrior('a.txt', 'write')
    await cp.recordPrior('b.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
    writeFileSync(join(workspace, 'b.txt'), 'b2\n', 'utf8')
    finalizeWriteCheckpoint(dir)
    writeFileSync(join(workspace, 'b.txt'), 'mine\n', 'utf8')

    const result = await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })

    expect(result.writes.restored).toEqual(['a.txt'])
    expect(result.writes.edited).toEqual(['b.txt'])
    // The instruction stays; what came after it is gone.
    expect(loadMessages(workspace, runId).map((m) => m.content)).toEqual(['first', 'ok', 'second'])
    expect(read('a.txt')).toBe('a0\n')
    expect(read('b.txt')).toBe('mine\n')
  })
})

describe('prepareRewindToUserMessage when a file cannot be written', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'edited a, b and c' }
  ]

  /** Run 2 changes a, b and c; the rewind restores c, then b, then a. */
  async function runThatChangedThreeFiles(): Promise<{ runId: string; dir: string }> {
    const runId = `run-${Date.now()}`
    const dir = createRun(workspace, runId, 'test')
    await syncMessagesAsync(dir, messages)
    writeFileSync(join(workspace, 'c.txt'), 'c0\n', 'utf8')
    const cp = beginWriteCheckpoint(dir, workspace, 2)
    for (const n of ['a', 'b', 'c']) await cp.recordPrior(`${n}.txt`, 'write')
    for (const n of ['a', 'b', 'c']) writeFileSync(join(workspace, `${n}.txt`), `${n}2\n`, 'utf8')
    const meta = finalizeWriteCheckpoint(dir)!
    appendEvent(dir, { type: 'writes_checkpoint', runId, checkpointId: meta.id, files: meta.files })
    await flushEventAppends(dir)
    return { runId, dir }
  }

  it('puts the first of three files back and leaves the record as it was', async () => {
    const { runId, dir } = await runThatChangedThreeFiles()
    const events = await loadEventsAsync(dir, runId)
    fsRoute.copied = []
    fsRoute.failCopyFrom = 'files/b.txt'

    await expect(prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })).rejects.toThrow(
      'Could not rewind: b.txt could not be restored (EBUSY). The files and the record are as they were.'
    )

    // c.txt was restored before b.txt failed, then put back.
    expect(fsRoute.copied).toEqual(['c.txt', 'b.txt'])
    expect(read('c.txt')).toBe('c2\n')
    expect(read('b.txt')).toBe('b2\n')
    expect(read('a.txt')).toBe('a2\n')
    expect(loadMessages(workspace, runId)).toEqual(messages)
    expect(await loadEventsAsync(dir, runId)).toEqual(events)
  })

  // A read-only file is a real refusal: EPERM on Windows, EACCES on POSIX. Root ignores the bit.
  it.skipIf(process.getuid?.() === 0)('leaves everything as it was when the system refuses the write', async () => {
    const { runId } = await runThatChangedThreeFiles()
    chmodSync(join(workspace, 'b.txt'), 0o444)
    try {
      await expect(prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })).rejects.toThrow(
        /^Could not rewind: b\.txt could not be restored \((EPERM|EACCES)\)\. The files and the record are as they were\.$/
      )
    } finally {
      chmodSync(join(workspace, 'b.txt'), 0o644)
    }

    expect(read('c.txt')).toBe('c2\n')
    expect(read('b.txt')).toBe('b2\n')
    expect(read('a.txt')).toBe('a2\n')
    expect(loadMessages(workspace, runId)).toEqual(messages)
  })
})
