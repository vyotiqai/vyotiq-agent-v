import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-dir-markers-${process.pid}-${Date.now()}`)

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

import { createRun, deleteRun, resumeRun, updateStatus } from '@main/agent/state'
import { markRunStorageLost, onRunStorageLost, resetRunStorageLostForTests } from '@main/agent/eventAppendQueue'
import { enqueueMessageRewrite } from '@main/agent/messageAppendQueue'
import { flushStatusWrites } from '@main/agent/statusWriteQueue'
import { registerRunAbort, resetActiveRunsForTests } from '@main/agent/runRegistry'

describe('per-run-dir markers', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-markers-ws-'))
    resetActiveRunsForTests()
    resetRunStorageLostForTests()
  })

  afterEach(() => {
    resetActiveRunsForTests()
    rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  // The mark lived for the process lifetime: a run whose dir came back was
  // aborted at the start of every later invoke.
  it('forgets a lost run dir once the run is resumed from it', async () => {
    const dir = createRun(workspace, 'lost-then-back', 'goal')
    markRunStorageLost(dir, Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
    const fired: string[] = []
    onRunStorageLost(dir, () => fired.push('before resume'))

    await resumeRun(workspace, 'lost-then-back')
    onRunStorageLost(dir, () => fired.push('after resume'))

    expect(fired).toEqual(['before resume'])
  })

  // deleteRun marks the dir abandoned while it drains; a run that registered
  // in the meantime makes it back out, and must keep writing its status.
  it('lets a run that registered during a delete keep writing its status', async () => {
    const runId = 'delete-raced'
    const dir = createRun(workspace, runId, 'goal')
    await flushStatusWrites(dir)
    // Registers the run from inside the drain deleteRun waits on.
    void enqueueMessageRewrite(dir, () => {
      registerRunAbort(runId, workspace)
    })

    expect(await deleteRun(workspace, runId)).toEqual({ ok: false, error: 'Cancel run first' })

    await updateStatus(dir, { goal: 'still running' })
    await flushStatusWrites(dir)
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { goal?: string }
    expect(status.goal).toBe('still running')
  })
})
