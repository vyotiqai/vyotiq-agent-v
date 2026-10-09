import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import { canGit } from '../../helpers/canGit'

const execFileAsync = promisify(execFileCb)

const userData = join(tmpdir(), `vyotiq-inst-resume-${process.pid}-${Date.now()}`)

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

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/agent/startAgentRun', () => ({
  startAgentRunInBackground: vi.fn()
}))

import {
  formatInstancesResumeNote,
  registerRunIpcSender,
  resetAgentInstancesForTests,
  resumeInterruptedInstances,
  runningInstanceCount
} from '@main/agent/agentInstances'
import { instanceWorktreeBranch, instanceWorktreePath } from '@main/git/instanceWorktree'
import { createRun, flushEventAppends, flushStatusWrites, updateStatus } from '@main/agent/state'
import { startAgentRunInBackground } from '@main/agent/startAgentRun'
import { resolveRunDir } from '@main/storage/paths'
import { RUN_INTERRUPTED_ERROR } from '@shared/runInterrupt'
import { clearRunAbort, isActive, resetActiveRunsForTests, tryRegisterRunAbort } from '@main/agent/runRegistry'

const wc = { isDestroyed: () => false, send: vi.fn() } as unknown as import('electron').WebContents

describe('instances come back when their task resumes after a restart', () => {
  const root = join(tmpdir(), `vyotiq-inst-resume-root-${process.pid}`)
  let workspacePath = ''
  const parentRunId = 'parent-run'
  let seq = 0

  /** A child the app exit interrupted, as interruptRunningRunOnDisk leaves it. */
  async function interruptedChild(
    fields: { parent?: string; resumable?: boolean; status?: 'cancelled' | 'done'; worktree?: boolean } = {}
  ): Promise<string> {
    seq += 1
    const childRunId = `child-${seq}-${Date.now()}`
    createRun(workspacePath, childRunId, `Outcome: part ${seq}`, {
      mode: 'agent',
      parentRunId: fields.parent ?? parentRunId,
      inlineInstance: true,
      pathScope: ['src/'],
      stepId: `s${seq}`,
      ...(fields.worktree
        ? {
            worktreePath: instanceWorktreePath(workspacePath, childRunId),
            worktreeBranch: instanceWorktreeBranch(childRunId)
          }
        : {})
    })
    const dir = resolveRunDir(workspacePath, childRunId)
    await updateStatus(
      dir,
      {
        status: fields.status ?? 'cancelled',
        error: RUN_INTERRUPTED_ERROR,
        ...(fields.resumable === false ? {} : { resumable: true as const }),
        interruptedAt: new Date(Date.now() + seq).toISOString(),
        step: 3
      },
      { sync: true }
    )
    await flushStatusWrites(dir)
    return childRunId
  }

  beforeEach(() => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    vi.mocked(startAgentRunInBackground).mockClear()
    workspacePath = join(root, `ws-${Date.now()}-${seq}`)
    mkdirSync(workspacePath, { recursive: true })
    createRun(workspacePath, parentRunId, 'parent goal')
    const reg = tryRegisterRunAbort(parentRunId, workspacePath)
    if (!reg.ok) throw new Error(reg.error)
    registerRunIpcSender(parentRunId, wc)
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('restarts an interrupted shared instance under its task, continuing its own run', async () => {
    const childRunId = await interruptedChild()

    const result = await resumeInterruptedInstances(workspacePath, parentRunId, wc)

    expect(result.failed).toEqual([])
    expect(result.resumed.map((r) => r.runId)).toEqual([childRunId])
    expect(isActive(childRunId)).toBe(true)
    expect(runningInstanceCount(parentRunId)).toBe(1)
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    expect(started?.runId).toBe(childRunId)
    expect(started?.agentInput).toMatchObject({ runId: childRunId, resume: true, mode: 'agent' })
    expect(started?.agentInput.messages).toBeUndefined()

    // The task's record shows the instance running again.
    const parentDir = resolveRunDir(workspacePath, parentRunId)
    await flushEventAppends(parentDir)
    const updates = readFileSync(join(parentDir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { type?: string; phase?: string; instanceRunId?: string; stepId?: string; event?: unknown })
      .map((row) => (row.event ?? row) as { type?: string; phase?: string; instanceRunId?: string; stepId?: string })
      .filter((e) => e.type === 'agent_instance_update')
    expect(updates.at(-1)).toMatchObject({ phase: 'started', instanceRunId: childRunId, stepId: 's1' })
    clearRunAbort(childRunId)
  })

  it('leaves alone a child someone stopped, one that finished, and another task’s', async () => {
    await interruptedChild({ resumable: false })
    await interruptedChild({ status: 'done' })
    await interruptedChild({ parent: 'other-task' })

    const result = await resumeInterruptedInstances(workspacePath, parentRunId, wc)

    expect(result).toEqual({ resumed: [], failed: [] })
    expect(startAgentRunInBackground).not.toHaveBeenCalled()
    expect(formatInstancesResumeNote(result)).toBeNull()
  })

  it('stops at Instances at once and says why for the rest', async () => {
    const { setSettings } = await import('@main/settings/settings')
    const { DEFAULT_SETTINGS } = await import('@shared/ipc')
    setSettings({ ...DEFAULT_SETTINGS, maxParallelInstances: 1 })
    try {
      const first = await interruptedChild()
      const second = await interruptedChild()

      const result = await resumeInterruptedInstances(workspacePath, parentRunId, wc)

      expect(result.resumed.map((r) => r.runId)).toEqual([first])
      expect(result.failed.map((f) => f.runId)).toEqual([second])
      expect(result.failed[0]?.reason).toMatch(/Instances at once/)
      expect(isActive(second)).toBe(false)
      clearRunAbort(first)
    } finally {
      setSettings({ ...DEFAULT_SETTINGS })
    }
  })

  it.skipIf(!canGit)('names an isolated instance whose branch is gone instead of starting it', async () => {
    const git = (...args: string[]) =>
      execFileAsync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args], {
        cwd: workspacePath,
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
    writeFileSync(join(workspacePath, 'README.md'), 'base\n')
    await git('init')
    await git('add', '.')
    await git('commit', '-m', 'init')
    const childRunId = await interruptedChild({ worktree: true })

    const result = await resumeInterruptedInstances(workspacePath, parentRunId, wc)

    expect(result.resumed).toEqual([])
    expect(result.failed).toEqual([
      {
        runId: childRunId,
        label: expect.any(String),
        reason: `its branch ${instanceWorktreeBranch(childRunId)} no longer exists`
      }
    ])
    expect(isActive(childRunId)).toBe(false)
    expect(startAgentRunInBackground).not.toHaveBeenCalled()
  }, 30_000)

  it('tells the task which came back and which did not', () => {
    const note = formatInstancesResumeNote({
      resumed: [{ runId: 'a', label: 'inst-aaaa' }],
      failed: [{ runId: 'b', label: 'inst-bbbb', reason: 'its branch vyotiq/instance/b no longer exists' }]
    })
    expect(note).toBe(
      [
        'The app restarted while this task ran.',
        'These instances were interrupted with it and are running again from where they stopped: inst-aaaa. Await them with await_agent_instance as before; do not spawn them again.',
        'inst-bbbb could not be resumed: its branch vyotiq/instance/b no longer exists. pull_agent_instance shows what it did before it stopped.'
      ].join('\n')
    )
  })
})
