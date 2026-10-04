import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'
import type { WebContents } from 'electron'

const execFileAsync = promisify(execFileCb)

const userData = join(tmpdir(), `vyotiq-instance-tools-${process.pid}-${Date.now()}`)

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

import { instanceHandlers } from '@main/agent/tools/instanceTools'
import {
  handleInlineInstanceFinished,
  registerRunIpcSender,
  resetAgentInstancesForTests,
  spawnAgentInstance
} from '@main/agent/agentInstances'
import { createRun, loadStatus, updateStatus } from '@main/agent/state'
import { resolveRunDir } from '@main/storage/paths'
import {
  clearRunAbort,
  getRunAbort,
  resetActiveRunsForTests,
  tryRegisterRunAbort
} from '@main/agent/runRegistry'
import { clearWorkspaceIndexSyncTimers } from '@main/agent/workspaceIndex'
import { formatAgentInstanceLabel } from '@shared/utils/agentInstance'

type Handlers = typeof instanceHandlers
type HandlerContext = Parameters<Handlers['await_agent_instance']>[3]

const NOT_A_CHILD = 'run_id is not an inline instance spawned by this parent run'

/** Same git fixture agentInstances.test.ts uses: a committed HEAD in the workspace. */
async function gitInitWorkspace(dir: string): Promise<void> {
  const git = (...args: string[]) =>
    execFileAsync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
      {
        cwd: dir,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }
    )
  writeFileSync(join(dir, 'README.md'), 'base\n')
  await git('init')
  await git('add', '.')
  await git('commit', '-m', 'init')
}

describe('instanceTools handlers', () => {
  let workspacePath: string
  let parentRunId: string
  const root = join(tmpdir(), `vyotiq-instance-tools-root-${process.pid}`)
  let seq = 0

  const signal = new AbortController().signal

  const context = (runId: string = parentRunId): HandlerContext =>
    ({ runId, runDir: resolveRunDir(workspacePath, runId) }) as HandlerContext

  /** No runId at all: the "called outside a run" guard. */
  const noRunContext = (): HandlerContext => ({}) as HandlerContext

  /** A run this parent owns as an inline instance, on disk only (no live loop). */
  async function createChild(status: 'running' | 'done' | 'error' = 'running'): Promise<string> {
    seq += 1
    const childRunId = `child-${seq}-${Date.now()}`
    createRun(workspacePath, childRunId, 'child goal', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    if (status !== 'running') await markTerminal(childRunId, status)
    return childRunId
  }

  /** The same child, but registered in the run registry so cancel can see it live. */
  async function createLiveChild(): Promise<string> {
    const childRunId = await createChild()
    const reg = tryRegisterRunAbort(childRunId, workspacePath)
    if (!reg.ok) throw new Error(reg.error)
    return childRunId
  }

  function markTerminal(childRunId: string, status: 'done' | 'error'): Promise<void> {
    return updateStatus(resolveRunDir(workspacePath, childRunId), { status }, { sync: true })
  }

  function writeMessages(childRunId: string, ...contents: string[]): void {
    const rows = contents.map((text, i) =>
      JSON.stringify({ role: i % 2 === 0 ? 'user' : 'assistant', content: text })
    )
    writeFileSync(join(resolveRunDir(workspacePath, childRunId), 'messages.jsonl'), `${rows.join('\n')}\n`)
  }

  beforeEach(() => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    seq = 0
    workspacePath = join(root, `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    mkdirSync(workspacePath, { recursive: true })
    parentRunId = 'parent-run'
    createRun(workspacePath, parentRunId, 'parent goal')
    // spawn refuses without a parent IPC sender; the handler tests reuse that path.
    registerRunIpcSender(
      parentRunId,
      { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents
    )
  })

  afterEach(() => {
    clearWorkspaceIndexSyncTimers()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  describe('await_agent_instance', () => {
    it('fails without an active run', async () => {
      const result = await instanceHandlers.await_agent_instance(workspacePath, {}, signal, noRunContext())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('await_agent_instance requires an active run')
    })

    it('fails without run_id', async () => {
      const result = await instanceHandlers.await_agent_instance(workspacePath, {}, signal, context())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('run_id is required')
    })

    it('refuses a run_id this parent did not spawn as an inline instance', async () => {
      const result = await instanceHandlers.await_agent_instance(
        workspacePath,
        { run_id: 'no-such-run' },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.summary).toBe(formatAgentInstanceLabel('no-such-run'))
      expect(result.content).toBe(NOT_A_CHILD)
    })

    it('refuses another parent run that is not inline', async () => {
      seq += 1
      const otherRunId = `top-level-${seq}`
      createRun(workspacePath, otherRunId, 'a top-level run')
      const result = await instanceHandlers.await_agent_instance(
        workspacePath,
        { run_id: otherRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.content).toBe(NOT_A_CHILD)
    })

    it('returns ok with the terminal phase and the child summary for a done child', async () => {
      const childRunId = await createChild('done')
      writeMessages(childRunId, 'go', 'the child report')
      const result = await instanceHandlers.await_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(true)
      expect(result.summary).toBe(formatAgentInstanceLabel(childRunId))
      expect(result.content).toContain('phase: done')
      expect(result.content).toContain('the child report')
    })

    it('fails an errored child while still reporting its phase and summary', async () => {
      const childRunId = await createChild('error')
      writeMessages(childRunId, 'go', 'half a report')
      const result = await instanceHandlers.await_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.summary).toBe(formatAgentInstanceLabel(childRunId))
      expect(result.content).toContain('phase: error')
      expect(result.content).toContain('half a report')
    })
  })

  describe('pull_agent_instance', () => {
    it('fails without an active run', async () => {
      const result = await instanceHandlers.pull_agent_instance(workspacePath, {}, signal, noRunContext())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('pull_agent_instance requires an active run')
    })

    it('fails without run_id', async () => {
      const result = await instanceHandlers.pull_agent_instance(workspacePath, {}, signal, context())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('run_id is required')
    })

    it('refuses a run_id this parent did not spawn as an inline instance', async () => {
      const result = await instanceHandlers.pull_agent_instance(
        workspacePath,
        { run_id: 'no-such-run' },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.content).toBe(NOT_A_CHILD)
    })

    it('pulls the requested view and falls back to summary for an unknown one', async () => {
      const childRunId = await createChild('done')
      writeMessages(childRunId, 'find call sites', 'Found three call sites.')
      const outline = await instanceHandlers.pull_agent_instance(
        workspacePath,
        { run_id: childRunId, view: 'outline' },
        signal,
        context()
      )
      expect(outline.ok).toBe(true)
      expect(outline.summary).toBe(formatAgentInstanceLabel(childRunId))
      expect(outline.content).toContain('messages: 2')
      expect(outline.content).toContain('Found three call sites')

      const unknownView = await instanceHandlers.pull_agent_instance(
        workspacePath,
        { run_id: childRunId, view: 'nonsense' },
        signal,
        context()
      )
      expect(unknownView.ok).toBe(true)
      expect(unknownView.content).toContain('status: done')
      expect(unknownView.content).toContain('Found three call sites')
    })
  })

  describe('merge_agent_instance', () => {
    it('fails without an active run', async () => {
      const result = await instanceHandlers.merge_agent_instance(workspacePath, {}, signal, noRunContext())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('merge_agent_instance requires an active run')
    })

    it('fails without run_id', async () => {
      const result = await instanceHandlers.merge_agent_instance(workspacePath, {}, signal, context())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('run_id is required')
    })

    it('refuses a run_id this parent did not spawn as an inline instance', async () => {
      const result = await instanceHandlers.merge_agent_instance(
        workspacePath,
        { run_id: 'no-such-run' },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.summary).toBe(formatAgentInstanceLabel('no-such-run'))
      expect(result.content).toBe(NOT_A_CHILD)
    })

    it('refuses a child that is still running', async () => {
      const childRunId = await createChild()
      const result = await instanceHandlers.merge_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.content).toBe('Instance is still running — await it before merging')
    })

    it('refuses a child that ended in error', async () => {
      const childRunId = await createChild('error')
      const result = await instanceHandlers.merge_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.content).toBe(
        'Instance did not finish successfully — only done instances can be merged'
      )
    })

    it('refuses a done child that has no worktree branch', async () => {
      const childRunId = await createChild('done')
      const result = await instanceHandlers.merge_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.content).toMatch(/no worktree branch/i)
    })

    it('merges a finished worktree child into the parent workspace', async () => {
      await gitInitWorkspace(workspacePath)
      const child = await spawnAgentInstance({
        parentRunId,
        workspacePath,
        goal: 'merge me',
        outcome: 'merged',
        subTasks: ['write a file'],
        doneWhen: 'branch merged'
      })
      expect(child.ok).toBe(true)
      if (!child.ok) return
      const status = loadStatus(resolveRunDir(workspacePath, child.runId))
      const worktree = status?.worktreePath
      const branch = status?.worktreeBranch
      expect(worktree && branch).toBeTruthy()
      writeFileSync(join(worktree!, 'from-child.txt'), 'hello\n')
      await execFileAsync('git', ['add', '.'], {
        cwd: worktree!,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      })
      await execFileAsync(
        'git',
        ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'child change'],
        {
          cwd: worktree!,
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
        }
      )
      await markTerminal(child.runId, 'done')
      await handleInlineInstanceFinished(workspacePath, child.runId, 'done')

      const result = await instanceHandlers.merge_agent_instance(
        workspacePath,
        { run_id: child.runId },
        signal,
        context()
      )
      expect(result.ok).toBe(true)
      expect(result.summary).toBe(formatAgentInstanceLabel(child.runId))
      expect(result.content).toContain(branch!)
      expect(readFileSync(join(workspacePath, 'from-child.txt'), 'utf8').replace(/\r\n/g, '\n')).toBe('hello\n')
      clearRunAbort(child.runId)
    })
  })

  describe('cancel_agent_instance', () => {
    it('fails without an active run', async () => {
      const result = await instanceHandlers.cancel_agent_instance(workspacePath, {}, signal, noRunContext())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('cancel_agent_instance requires an active run')
    })

    it('fails without run_id', async () => {
      const result = await instanceHandlers.cancel_agent_instance(workspacePath, {}, signal, context())
      expect(result.ok).toBe(false)
      expect(result.content).toBe('run_id is required')
    })

    it('refuses a run_id this parent did not spawn as an inline instance', async () => {
      const result = await instanceHandlers.cancel_agent_instance(
        workspacePath,
        { run_id: 'no-such-run' },
        signal,
        context()
      )
      expect(result.ok).toBe(false)
      expect(result.summary).toBe(formatAgentInstanceLabel('no-such-run'))
      expect(result.content).toBe(NOT_A_CHILD)
    })

    it('cancels a live child and says where its partial output lives', async () => {
      const childRunId = await createLiveChild()
      const result = await instanceHandlers.cancel_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(true)
      expect(result.summary).toBe(formatAgentInstanceLabel(childRunId))
      expect(result.content).toContain('phase: cancelling')
      expect(result.content).toContain('pull_agent_instance')
      expect(getRunAbort(childRunId)?.signal.aborted).toBe(true)
    })

    it('reports an already-terminal child with its status instead of failing', async () => {
      const childRunId = await createChild('done')
      const result = await instanceHandlers.cancel_agent_instance(
        workspacePath,
        { run_id: childRunId },
        signal,
        context()
      )
      expect(result.ok).toBe(true)
      expect(result.content).toContain('phase: already-terminal (done)')
    })
  })
})