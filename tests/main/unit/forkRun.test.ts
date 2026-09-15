import { mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-userdata-${process.pid}-${Date.now()}`)

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

import { appendMessage, createRun, listRuns, loadMessages, loadStatus } from '@main/agent/state'
import { forkRun } from '@main/agent/forkRun'
import { registerRunAbort, clearRunAbort } from '@main/agent/runRegistry'
import { resolveRunDir } from '@main/storage/paths'

describe('forkRun', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-fork-${process.pid}-${Date.now()}-${Math.random()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(join(userData, 'sessions'), { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('copies the full transcript into a new run and lists it', async () => {
    createRun(workspace, 'run-a', 'chat a')
    const dir = resolveRunDir(workspace, 'run-a')
    await appendMessage(dir, { role: 'user', content: 'hello' })
    await appendMessage(dir, { role: 'assistant', content: 'hi' })

    const forkedRunId = await forkRun(workspace, 'run-a')

    const listed = await listRuns(workspace)
    expect(listed.runs.map((r) => r.runId)).toContain(forkedRunId)
    const forked = loadMessages(workspace, forkedRunId)
    expect(forked.map((m) => m.content)).toEqual(['hello', 'hi'])
    const forkedStatus = loadStatus(resolveRunDir(workspace, forkedRunId))
    expect(forkedStatus?.goal).toBe('chat a (fork)')
    expect(forkedStatus?.status).toBe('done')
    expect(forkedStatus?.parentRunId).toBe('run-a')
    // Source run is untouched.
    const source = loadMessages(workspace, 'run-a')
    expect(source.map((m) => m.content)).toEqual(['hello', 'hi'])
  })

  it('truncates the fork at forkIndex', async () => {
    createRun(workspace, 'run-b', 'chat b')
    const dir = resolveRunDir(workspace, 'run-b')
    await appendMessage(dir, { role: 'user', content: 'one' })
    await appendMessage(dir, { role: 'assistant', content: 'two' })
    await appendMessage(dir, { role: 'user', content: 'three' })

    const forkedRunId = await forkRun(workspace, 'run-b', 2)

    const forked = loadMessages(workspace, forkedRunId)
    expect(forked.map((m) => m.content)).toEqual(['one', 'two'])
    // Source keeps all three messages.
    expect(loadMessages(workspace, 'run-b')).toHaveLength(3)
  })

  it('rejects forking an active run', async () => {
    createRun(workspace, 'run-c', 'chat c')
    const registered = registerRunAbort('run-c', workspace)
    expect(registered.ok !== false).toBe(true)
    try {
      await expect(forkRun(workspace, 'run-c')).rejects.toThrow('Cancel run first')
    } finally {
      clearRunAbort('run-c')
    }
  })

  it('rejects forking a missing run', async () => {
    await expect(forkRun(workspace, 'missing-run')).rejects.toThrow('Run not found')
  })
})
