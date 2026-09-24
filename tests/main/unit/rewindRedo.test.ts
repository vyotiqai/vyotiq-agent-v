import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-redo-ud-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-redo-app'),
    isPackaged: false
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { beginWriteCheckpoint, finalizeWriteCheckpoint, resetWriteCheckpointsForTests } from '@main/agent/checkpoints'
import { prepareRewindToUserMessage, prepareRewindAndReplaceUserMessage } from '@main/agent/rewindRun'
import { discardRewindRedo, redoRewind, rewindRedoStatus } from '@main/agent/rewindRedo'
import { createRun, loadMessages, syncMessagesAsync } from '@main/agent/state'

let workspace: string
let runId: string
let dir: string

const read = (name: string): string => readFileSync(join(workspace, name), 'utf8')

/** A task whose second run edited a.txt, created c.txt and deleted d.txt. */
async function taskWithSecondRun(): Promise<void> {
  runId = `run-${Date.now()}-${Math.random().toString(16).slice(2)}`
  dir = createRun(workspace, runId, 'test')
  await syncMessagesAsync(dir, [
    { role: 'user', content: 'first' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: 'second' },
    { role: 'assistant', content: 'edited a, made c, removed d' }
  ])
  const cp = beginWriteCheckpoint(dir, workspace, 2)
  await cp.recordPrior('a.txt', 'write')
  await cp.recordPrior('c.txt', 'write')
  await cp.recordPrior('d.txt', 'delete')
  writeFileSync(join(workspace, 'a.txt'), 'a2\n', 'utf8')
  writeFileSync(join(workspace, 'c.txt'), 'c2\n', 'utf8')
  rmSync(join(workspace, 'd.txt'))
  finalizeWriteCheckpoint(dir)
}

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-redo-ws-'))
  writeFileSync(join(workspace, 'a.txt'), 'a0\n', 'utf8')
  writeFileSync(join(workspace, 'd.txt'), 'd0\n', 'utf8')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
})

describe('redo a rewind', () => {
  it('brings back the rewound runs and the files as the task left them', async () => {
    await taskWithSecondRun()
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'none' })

    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    expect(loadMessages(workspace, runId).map((m) => m.content)).toEqual(['first', 'ok', 'second'])
    expect(read('a.txt')).toBe('a0\n')
    expect(existsSync(join(workspace, 'c.txt'))).toBe(false)
    expect(read('d.txt')).toBe('d0\n')
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: true, files: 3, userMessageIndex: 2 })

    const { messages } = await redoRewind(workspace, runId)
    expect(messages.map((m) => m.content)).toEqual(['first', 'ok', 'second', 'edited a, made c, removed d'])
    expect(loadMessages(workspace, runId)).toHaveLength(4)
    expect(read('a.txt')).toBe('a2\n')
    expect(read('c.txt')).toBe('c2\n')
    expect(existsSync(join(workspace, 'd.txt'))).toBe(false)
    // Once: the redo is spent.
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'none' })
    // And the rewind can be made again from the restored state.
    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    expect(read('a.txt')).toBe('a0\n')
  })

  it('goes away when a file it would overwrite changed, and then touches nothing', async () => {
    await taskWithSecondRun()
    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    writeFileSync(join(workspace, 'a.txt'), 'mine since\n', 'utf8')

    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'files-changed' })
    await expect(redoRewind(workspace, runId)).rejects.toThrow('Something changed since the rewind')
    expect(read('a.txt')).toBe('mine since\n')
    expect(existsSync(join(workspace, 'c.txt'))).toBe(false)
    expect(loadMessages(workspace, runId)).toHaveLength(3)
  })

  it('goes away when the record changed, or a new instruction was sent', async () => {
    await taskWithSecondRun()
    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    await syncMessagesAsync(dir, [
      ...loadMessages(workspace, runId),
      { role: 'assistant', content: 'something new' }
    ])
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'record-changed' })

    await taskWithSecondRun()
    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    expect((await rewindRedoStatus(workspace, runId)).available).toBe(true)
    // chatStart on the task drops it (the handler calls this).
    discardRewindRedo(workspace, runId)
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'none' })
  })

  it('edit and resend is a new instruction: nothing to redo after it', async () => {
    await taskWithSecondRun()
    await prepareRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 2 })
    expect((await rewindRedoStatus(workspace, runId)).available).toBe(true)
    await prepareRewindAndReplaceUserMessage({
      workspacePath: workspace,
      runId,
      editMessageIndex: 2,
      editedUserMessage: { role: 'user', content: 'second, differently' }
    })
    expect(await rewindRedoStatus(workspace, runId)).toEqual({ available: false, reason: 'none' })
  })
})
