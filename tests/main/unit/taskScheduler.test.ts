import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-'))
const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-ws-'))

const statusHolder: { value: { status: string; error?: string; updatedAt: string } | null } = {
  value: null
}
const startedInputs: Array<{ runId: string; agentInput: { agentProfileId?: string; messages?: Array<{ content: string }> } }> = []
let runIdSeq = 0

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  BrowserWindow: class {}
}))
vi.mock('@main/app/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: { isDestroyed: () => false, send: vi.fn() }
  })
}))
vi.mock('@main/agent/loop', () => ({
  createRunId: () => {
    runIdSeq += 1
    return `run-${runIdSeq}`
  }
}))
vi.mock('@main/agent/state', () => ({
  loadStatus: vi.fn(() => statusHolder.value)
}))
vi.mock('@main/storage/paths', () => ({
  resolveRunDir: (workspacePath: string, runId: string) => join(workspacePath, runId)
}))
vi.mock('@main/agent/startAgentRun', () => ({
  startAgentRunInBackground: vi.fn((input: {
    runId: string
    agentInput: { agentProfileId?: string; messages?: Array<{ content: string }> }
  }) => {
    startedInputs.push(input)
  })
}))
vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({ openPaths: [workspace] })
}))
vi.mock('@main/settings/agentProfiles', () => ({
  resolveAgentProfile: vi.fn((_ws: string, profileId: string) =>
    profileId === 'scout' ? { id: 'scout', name: 'Scout' } : null
  )
}))

import { clearRunAbort } from '@main/agent/runRegistry'
import {
  cancelTask,
  enqueueTask,
  listTasks,
  resetTaskSchedulerForTests,
  resumeTasksForWorkspaces
} from '@main/agent/taskScheduler'

beforeEach(() => {
  vi.useFakeTimers()
  statusHolder.value = null
  startedInputs.length = 0
  runIdSeq = 0
  resetTaskSchedulerForTests()
  rmSync(join(workspace, '.vyotiq'), { recursive: true, force: true })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('delegated task scheduler', () => {
  it('starts an immediate task through the chatStart path', () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'Do the thing' })
    expect(task.status).toBe('running')
    expect(task.runId).toBe('run-1')
    expect(startedInputs).toHaveLength(1)
    expect(startedInputs[0]!.agentInput.agentProfileId).toBe('scout')
    expect(startedInputs[0]!.agentInput.messages?.[0]?.content).toBe('Do the thing')
  })

  it('serializes one running task per profile and pumps the queue on completion', async () => {
    const first = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'first' })
    const second = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'second' })
    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')

    // Run 1 finishes → the queued task starts. Clearing the registry entry
    // mirrors the loop's finally (production runs always clear their slot).
    statusHolder.value = { status: 'done', updatedAt: new Date().toISOString() }
    clearRunAbort(first.runId!)
    await vi.advanceTimersByTimeAsync(5_100)

    const tasks = listTasks()
    expect(tasks.find((t) => t.id === first.id)?.status).toBe('done')
    expect(tasks.find((t) => t.id === second.id)?.status).toBe('running')
    expect(startedInputs).toHaveLength(2)
    expect(startedInputs[1]!.agentInput.messages?.[0]?.content).toBe('second')
  })

  it('marks failed runs with the run error', async () => {
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'boom' })
    statusHolder.value = { status: 'error', error: 'provider exploded', updatedAt: new Date().toISOString() }
    await vi.advanceTimersByTimeAsync(5_100)
    const stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toBe('provider exploded')
  })

  it('honors scheduledAt and fires when due', async () => {
    const at = new Date(Date.now() + 60_000).toISOString()
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'later', scheduledAt: at })
    expect(task.status).toBe('scheduled')
    expect(startedInputs).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(60_100)
    const stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('running')
    expect(startedInputs).toHaveLength(1)
  })

  it('persists tasks to .vyotiq/tasks.json', () => {
    enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'persisted' })
    const raw = JSON.parse(readFileSync(join(workspace, '.vyotiq', 'tasks.json'), 'utf8')) as {
      tasks: Array<{ prompt: string }>
    }
    expect(raw.tasks).toHaveLength(1)
    expect(raw.tasks[0]!.prompt).toBe('persisted')
  })

  it('cancels a queued task and a running run', () => {
    const running = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'running' })
    const queued = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'queued' })

    expect(cancelTask(queued.id)).toBe(true)
    expect(listTasks().find((t) => t.id === queued.id)?.status).toBe('cancelled')

    expect(cancelTask(running.id)).toBe(true)
    // Running cancellation goes through cancelRun — the poll finalizes the task.
    expect(listTasks().find((t) => t.id === running.id)?.status).toBe('running')
  })

  it('re-arms scheduled tasks at boot and starts past-due ones', async () => {
    const future = new Date(Date.now() + 120_000).toISOString()
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-past',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'past due',
            status: 'scheduled',
            scheduledAt: new Date(Date.now() - 5_000).toISOString(),
            createdAt: new Date().toISOString()
          },
          {
            id: 'task-future',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'still scheduled',
            status: 'scheduled',
            scheduledAt: future,
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )

    resumeTasksForWorkspaces([workspace])
    const tasks = listTasks()
    expect(tasks.find((t) => t.id === 'task-past')?.status).toBe('running')
    expect(tasks.find((t) => t.id === 'task-future')?.status).toBe('scheduled')
  })

  it('rejects unknown profiles and non-open workspaces', () => {
    expect(() =>
      enqueueTask({ profileId: 'ghost', workspacePath: workspace, prompt: 'x' })
    ).toThrow('Unknown teammate profile')
    expect(() =>
      enqueueTask({ profileId: 'scout', workspacePath: join(tmpRoot, 'closed-ws'), prompt: 'x' })
    ).toThrow('Workspace is not open')
  })

  it('re-arms far-future schedules in chunks instead of firing early', async () => {
    const MAX_TIMEOUT_MS = 2 ** 31 - 1
    const at = new Date(Date.now() + MAX_TIMEOUT_MS + 60_000).toISOString()
    const task = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'far out', scheduledAt: at })
    expect(task.status).toBe('scheduled')

    // The first ~24.9-day chunk must NOT fire the task.
    await vi.advanceTimersByTimeAsync(MAX_TIMEOUT_MS)
    let stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('scheduled')
    expect(stored?.scheduledAt).toBe(at)
    expect(startedInputs).toHaveLength(0)

    // The re-armed remainder fires on time.
    await vi.advanceTimersByTimeAsync(60_500)
    stored = listTasks().find((t) => t.id === task.id)
    expect(stored?.status).toBe('running')
    expect(startedInputs).toHaveLength(1)
  })

  it('finalizes stale running tasks at boot from the durable run status', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-stale-cancelled',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'orphaned by restart',
            status: 'running',
            runId: 'run-orphan',
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )
    // Boot orphan-reconciliation flips interrupted runs to cancelled+resumable.
    statusHolder.value = { status: 'cancelled', updatedAt: new Date().toISOString() }
    resumeTasksForWorkspaces([workspace])
    const stored = listTasks().find((t) => t.id === 'task-stale-cancelled')
    expect(stored?.status).toBe('cancelled')
    expect(stored?.finishedAt).toBeTruthy()
  })

  it('fails stale running tasks whose run dir never produced a status', async () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'tasks.json'),
      JSON.stringify({
        version: 1,
        tasks: [
          {
            id: 'task-stale-nostatus',
            profileId: 'scout',
            workspacePath: workspace,
            prompt: 'never started',
            status: 'running',
            createdAt: new Date().toISOString()
          }
        ]
      }),
      'utf8'
    )
    statusHolder.value = null
    resumeTasksForWorkspaces([workspace])
    const stored = listTasks().find((t) => t.id === 'task-stale-nostatus')
    expect(stored?.status).toBe('failed')
    expect(stored?.error).toContain('restart')
  })

  it('holds queued tasks for closed workspaces until they reopen', async () => {
    const closedWs = mkdtempSync(join(tmpdir(), 'vyotiq-tasks-closed-'))
    try {
      const dir = join(closedWs, '.vyotiq')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'tasks.json'),
        JSON.stringify({
          version: 1,
          tasks: [
            {
              id: 'task-closed-ws',
              profileId: 'scout',
              workspacePath: closedWs,
              prompt: 'waiting for its workspace',
              status: 'queued',
              createdAt: new Date().toISOString()
            }
          ]
        }),
        'utf8'
      )

      // Only `workspace` is open — the closed workspace's task must not start.
      resumeTasksForWorkspaces([closedWs])
      expect(startedInputs).toHaveLength(0)
      expect(
        listTasks().find((t) => t.id === 'task-closed-ws')?.status
      ).toBe('queued')
    } finally {
      rmSync(closedWs, { recursive: true, force: true })
    }
  })

  it('frees the teammate slot when a run never writes a status', async () => {
    const first = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'status never appears' })
    const second = enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'next in queue' })
    expect(first.status).toBe('running')
    expect(second.status).toBe('queued')
    // The simulated crash unwound before the loop's try — startAgentRun's
    // finally still clears the registry slot (production safety net).
    clearRunAbort(first.runId!)

    // 12 missing-status polls (60s) — the backstop finalizes and re-pumps.
    await vi.advanceTimersByTimeAsync(61_000)
    const storedFirst = listTasks().find((t) => t.id === first.id)
    expect(storedFirst?.status).toBe('failed')
    expect(storedFirst?.error).toContain('status unavailable')
    expect(listTasks().find((t) => t.id === second.id)?.status).toBe('running')
    expect(startedInputs).toHaveLength(2)
  })

  it('moves a corrupt tasks.json aside instead of wiping it on the next save', () => {
    const dir = join(workspace, '.vyotiq')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'tasks.json'), '{corrupt', 'utf8')

    enqueueTask({ profileId: 'scout', workspacePath: workspace, prompt: 'after corruption' })
    const backups = readdirSync(dir).filter((name) => name.startsWith('tasks.json.corrupt-'))
    expect(backups).toHaveLength(1)
    expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe('{corrupt')
    const fresh = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8')) as { tasks: unknown[] }
    expect(fresh.tasks).toHaveLength(1)
  })
})
