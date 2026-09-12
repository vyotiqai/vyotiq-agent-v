import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { execFile as execFileCb } from 'child_process'
import { promisify } from 'util'

const execFileAsync = promisify(execFileCb)

const userData = join(tmpdir(), `vyotiq-inst-${process.pid}-${Date.now()}`)

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

const mainWindowSend = vi.fn()
vi.mock('@main/app/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: mainWindowSend
    }
  })
}))

vi.mock('@main/agent/startAgentRun', () => ({
  startAgentRunInBackground: vi.fn()
}))

import {
  cancelChildInstance,
  emitAgentInstanceUpdate,
  handleInlineInstanceFinished,
  mergeAgentInstanceBranch,
  noteInlineInstanceDeniedTool,
  notifyChildTerminal,
  pullChildRun,
  registerChildInstance,
  registerParentInstanceEmitter,
  registerRunIpcSender,
  resetAgentInstancesForTests,
  spawnAgentInstance,
  summarizeChildRun,
  unregisterChildInstance,
  waitForChildTerminal
} from '@main/agent/agentInstances'
import {
  instanceWorktreeBranch,
  instanceWorktreePath,
  isSafeInstanceBranch,
  isSafeInstanceWorktreePath
} from '@main/git/instanceWorktree'
import {
  appendEvent,
  createRun,
  deleteRun,
  flushEventAppends,
  listRuns,
  loadStatus,
  runExists,
  updateStatus
} from '@main/agent/state'
import { startAgentRunInBackground } from '@main/agent/startAgentRun'
import { resolveRunDir } from '@main/storage/paths'
import { RUN_RECEIPT_VERSION } from '@shared/ipc'
import {
  CANCEL_FORCE_FINISH_MS,
  chatCancelResult,
  clearRunAbort,
  cancelRun,
  forceFinishCancelledRun,
  getActiveInlineChildRunIds,
  getRunAbort,
  isActive,
  MAX_ACTIVE_RUNS,
  resetActiveRunsForTests,
  tryRegisterRunAbort
} from '@main/agent/runRegistry'
function mockWebContents() {
  return {
    isDestroyed: () => false,
    send: vi.fn()
  } as unknown as import('electron').WebContents
}

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

describe('agentInstances', () => {
  let workspacePath: string
  let parentRunId: string
  const wc = mockWebContents()
  const root = join(tmpdir(), `vyotiq-inst-root-${process.pid}`)

  beforeEach(() => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    mainWindowSend.mockClear()
    workspacePath = join(root, `ws-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    parentRunId = 'parent-run'
    createRun(workspacePath, parentRunId, 'parent goal')
    const reg = tryRegisterRunAbort(parentRunId, workspacePath)
    if (!reg.ok) throw new Error(reg.error)
    registerRunIpcSender(parentRunId, wc)
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('spawn creates inline child with parent linkage', async () => {
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'child task',
      outcome: 'child task outcome',
      subTasks: ['child task step'],
      doneWhen: 'child task complete',
      pathScope: ['src/main/']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const status = loadStatus(resolveRunDir(workspacePath, result.runId))
    expect(status?.parentRunId).toBe(parentRunId)
    expect(status?.inlineInstance).toBe(true)
    expect(status?.pathScope).toEqual(['src/main/'])
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    const childText = JSON.stringify(started?.agentInput.messages)
    expect(childText).not.toMatch(/merge_agent_instance/)
    expect(childText).not.toMatch(/pin merge/i)
    clearRunAbort(result.runId)
  })

  it('appends the multi-line goal verbatim at the end of the composed child prompt', async () => {
    const goal = [
      'Fix auth token refresh in src/main/auth',
      '',
      'Outcome: refresh uses the existing token store.',
      'Sub-tasks:',
      '- Read token store',
      '- Fix expiry path',
      'Done when: typecheck passes on src/main/auth'
    ].join('\n')
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal,
      outcome: 'auth token refresh fixed',
      subTasks: ['read token store', 'fix expiry path'],
      doneWhen: 'typecheck passes',
      pathScope: ['src/main/auth']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    const first = started?.agentInput.messages?.[0]
    expect(first?.role).toBe('user')
    expect(typeof first?.content).toBe('string')
    if (typeof first?.content !== 'string') return
    // Structured brief composes first; the raw goal text is appended verbatim last.
    expect(first.content.startsWith('Outcome: auth token refresh fixed')).toBe(true)
    expect(first.content.endsWith(goal)).toBe(true)
    clearRunAbort(result.runId)
  })

  it('composes the structured brief into the child prompt in the documented order', async () => {
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'plain goal text',
      outcome: 'fix the widget',
      subTasks: ['read the widget', 'fix the widget'],
      doneWhen: 'typecheck passes',
      pathScope: ['src/widget']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    const first = started?.agentInput.messages?.[0]
    const content = typeof first?.content === 'string' ? first.content : ''
    expect(content.startsWith('Outcome: fix the widget\n\nSub-tasks:\n1. read the widget\n2. fix the widget\n\nDone when: typecheck passes\nPaths: src/widget\nplain goal text')).toBe(true)
    expect(content).toContain('Outcome: ')
    expect(content).toContain('Sub-tasks:')
    expect(content).toContain('1. ')
    expect(content).toContain('Done when: ')
    clearRunAbort(result.runId)
  })

  it('composes the brief without a Paths line when path_scope is absent', async () => {
    // A path_scope-less spawn needs worktree isolation, which needs a git repo.
    await gitInitWorkspace(workspacePath)
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'no paths line',
      outcome: 'no paths line outcome',
      subTasks: ['no paths line step'],
      doneWhen: 'no paths line complete'
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    const first = started?.agentInput.messages?.[0]
    const content = typeof first?.content === 'string' ? first.content : ''
    expect(content).not.toContain('\nPaths: ')
    clearRunAbort(result.runId)
  })

  it('rejects spawn when outcome is missing or empty', async () => {
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'no outcome',
      outcome: '',
      subTasks: ['a step'],
      doneWhen: 'done'
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/outcome/)
  })

  it('rejects spawn when sub_tasks is empty or has a blank entry', async () => {
    const empty = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'no subtasks',
      outcome: 'some outcome',
      subTasks: [],
      doneWhen: 'done'
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.error).toMatch(/sub_tasks/)

    const blank = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'blank subtask',
      outcome: 'some outcome',
      subTasks: ['   '],
      doneWhen: 'done'
    })
    expect(blank.ok).toBe(false)
    if (!blank.ok) expect(blank.error).toMatch(/sub_tasks/)
  })

  it('rejects spawn when done_when is missing or empty', async () => {
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'no done when',
      outcome: 'some outcome',
      subTasks: ['a step'],
      doneWhen: ''
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toMatch(/done_when/)
  })

  it('stores inline instance runs under session workspace, not worktree path', () => {
    const runId = `child-worktree-lookup-${Date.now()}`
    const worktree = join(workspacePath, '.vyotiq-instances', runId)
    mkdirSync(worktree, { recursive: true })
    createRun(workspacePath, runId, 'goal', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true,
      worktreePath: worktree,
      pathScope: ['src/']
    })
    expect(runExists(workspacePath, runId)).toBe(true)
    expect(runExists(worktree, runId)).toBe(false)
  })

  it('omits inline instances from default listRuns but returns them in instanceRuns', async () => {
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'hidden child',
      outcome: 'hidden child outcome',
      subTasks: ['hidden child step'],
      doneWhen: 'hidden child complete',
      pathScope: ['src']
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const listed = await listRuns(workspacePath)
    expect(listed.runs.some((r) => r.runId === result.runId)).toBe(false)
    expect(listed.instanceRuns.some((r) => r.runId === result.runId)).toBe(true)
    expect(listed.instanceRuns.find((r) => r.runId === result.runId)?.parentRunId).toBe(
      parentRunId
    )
    clearRunAbort(result.runId)
  })

  it('rejects nested spawn from inline child', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'child',
      outcome: 'child outcome',
      subTasks: ['child step'],
      doneWhen: 'child complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const nested = await spawnAgentInstance({
      parentRunId: child.runId,
      workspacePath,
      goal: 'nested',
      outcome: 'nested outcome',
      subTasks: ['nested step'],
      doneWhen: 'nested complete',
      pathScope: ['src']
    })
    expect(nested.ok).toBe(false)
    clearRunAbort(child.runId)
  })

  it('spawns many live children per parent up to the global run cap', async () => {
    const ids: string[] = []
    // One parent + children fill every global slot: no per-parent cap exists,
    // the only limit is MAX_ACTIVE_RUNS.
    for (let i = 0; i < MAX_ACTIVE_RUNS - 1; i += 1) {
      const r = await spawnAgentInstance({
        parentRunId,
        workspacePath,
        goal: `task ${i}`,
        outcome: `task ${i} outcome`,
        subTasks: [`task ${i} step`],
        doneWhen: `task ${i} complete`,
        pathScope: ['src']
      })
      expect(r.ok).toBe(true)
      if (r.ok) ids.push(r.runId)
    }
    expect(getActiveInlineChildRunIds(parentRunId)).toHaveLength(MAX_ACTIVE_RUNS - 1)
    const capped = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'beyond the global cap',
      outcome: 'beyond the global cap outcome',
      subTasks: ['beyond the global cap step'],
      doneWhen: 'beyond the global cap complete',
      pathScope: ['src']
    })
    expect(capped.ok).toBe(false)
    if (!capped.ok) expect(capped.error).toMatch(/Too many concurrent runs/)
    for (const id of ids) {
      chatCancelResult(id)
      clearRunAbort(id)
    }
  })

  it('cancel parent cascades to active children', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'child',
      outcome: 'child outcome',
      subTasks: ['child step'],
      doneWhen: 'child complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(getActiveInlineChildRunIds(parentRunId).some((id) => id === child.runId)).toBe(true)
    expect(getRunAbort(child.runId)?.signal.aborted).toBe(false)
    const cancelled = chatCancelResult(parentRunId)
    expect(cancelled.ok).toBe(true)
    expect(getRunAbort(child.runId)?.signal.aborted).toBe(true)
    clearRunAbort(parentRunId)
    clearRunAbort(child.runId)
  })

  it('spawns into the last global slot when runs are already active', async () => {
    const fillerIds: string[] = []
    // Parent holds one slot; fillers leave exactly one free.
    for (let i = 0; i < MAX_ACTIVE_RUNS - 2; i += 1) {
      const id = `filler-${i}`
      const reg = tryRegisterRunAbort(id, workspacePath)
      expect(reg.ok).toBe(true)
      fillerIds.push(id)
    }
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'fills the last global slot',
      outcome: 'fills the last global slot outcome',
      subTasks: ['fills the last global slot step'],
      doneWhen: 'fills the last global slot complete',
      pathScope: ['src']
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      chatCancelResult(result.runId)
      clearRunAbort(result.runId)
    }
    for (const id of fillerIds) clearRunAbort(id)
  })

  it('spawns via main-window fallback when parent IPC sender is missing', async () => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    createRun(workspacePath, parentRunId, 'parent goal')
    const reg = tryRegisterRunAbort(parentRunId, workspacePath)
    expect(reg.ok).toBe(true)
    // Intentionally skip registerRunIpcSender — resolveSpawnWebContents falls back to getMainWindow.
    const result = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'fallback spawn',
      outcome: 'fallback spawn outcome',
      subTasks: ['fallback spawn step'],
      doneWhen: 'fallback spawn complete',
      pathScope: ['src']
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      chatCancelResult(result.runId)
      clearRunAbort(result.runId)
    }
  })

  it('runAgent preserves inlineInstance when run dir pre-exists', async () => {
    const childRunId = `child-pre-${Date.now()}`
    createRun(workspacePath, childRunId, 'child goal', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true,
      pathScope: ['src/']
    })
    const reg = tryRegisterRunAbort(childRunId, workspacePath)
    expect(reg.ok).toBe(true)
    if (!reg.ok) return

    const { runAgent } = await import('@main/agent/loop')
    const gen = runAgent({
      runId: childRunId,
      workspacePath,
      messages: [{ role: 'user', content: 'child goal' }]
    })
    await gen.next()
    chatCancelResult(childRunId)
    try {
      for await (const _ of gen) {
        /* drain */
      }
    } catch {
      /* aborted */
    }
    clearRunAbort(childRunId)

    const status = loadStatus(resolveRunDir(workspacePath, childRunId))
    expect(status?.inlineInstance).toBe(true)
    expect(status?.parentRunId).toBe(parentRunId)
    expect(status?.pathScope).toEqual(['src/'])
  })

  it('await resolves with terminal summary including wroteFiles', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'await me',
      outcome: 'await me outcome',
      subTasks: ['await me step'],
      doneWhen: 'await me complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    const runDir = resolveRunDir(workspacePath, child.runId)
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'receipt.json'),
      JSON.stringify({
        version: RUN_RECEIPT_VERSION,
        writtenAt: new Date().toISOString(),
        runId: child.runId,
        status: 'done',
        step: 1,
        compactionCount: 0,
        toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
        failureClusters: [],
        unreadEditPaths: [],
        wroteFiles: ['src/a.ts'],
        diagnostics: { calls: 0, ok: 0, clean: 0 },
        contractExcerpt: 'await me'
      })
    )

    const waitPromise = waitForChildTerminal(child.runId, workspacePath, 5_000)
    notifyChildTerminal(child.runId, 'done', summarizeChildRun(workspacePath, child.runId))
    const terminal = await waitPromise
    expect(terminal.phase).toBe('done')
    expect(terminal.summary).toMatch(/wroteFiles/)
    expect(terminal.summary).toMatch(/src\/a\.ts/)
    clearRunAbort(child.runId)
  })

  it('await does not hang when child is already terminal on disk', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'race me',
      outcome: 'race me outcome',
      subTasks: ['race me step'],
      doneWhen: 'race me complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    const childDir = resolveRunDir(workspacePath, child.runId)
    await updateStatus(childDir, { status: 'done' }, { sync: true })
    const terminal = await waitForChildTerminal(child.runId, workspacePath, 2_000)
    expect(terminal.phase).toBe('done')
    clearRunAbort(child.runId)
  })

  it('await polls disk when in-memory registration is missing (restart)', async () => {
    const childRunId = `orphan-${Date.now()}`
    createRun(workspacePath, childRunId, 'orphan', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    await updateStatus(resolveRunDir(workspacePath, childRunId), { status: 'done' }, { sync: true })
    const terminal = await waitForChildTerminal(childRunId, workspacePath, 2_000)
    expect(terminal.phase).toBe('done')
  })

  it('emits live IPC via main window when parent emitter is absent', async () => {
    emitAgentInstanceUpdate(workspacePath, parentRunId, {
      parentRunId,
      instanceRunId: 'child-live',
      phase: 'done',
      summary: 'finished'
    })
    expect(mainWindowSend).toHaveBeenCalled()
    const payload = mainWindowSend.mock.calls[0]?.[1] as { type?: string; phase?: string }
    expect(payload?.type).toBe('agent_instance_update')
    expect(payload?.phase).toBe('done')
  })

  it('prefers parent emitter over main-window send while parent invoke is live', async () => {
    const emit = vi.fn()
    const release = registerParentInstanceEmitter(parentRunId, emit)
    emitAgentInstanceUpdate(workspacePath, parentRunId, {
      parentRunId,
      instanceRunId: 'child-batched',
      goal: 'x',
      outcome: 'x outcome',
      subTasks: ['x step'],
      doneWhen: 'x complete',
    })
    expect(emit).toHaveBeenCalled()
    expect(mainWindowSend).not.toHaveBeenCalled()
    release()
  })

  it('persists started event once when emitParentEvent is provided', async () => {
    const emitted: unknown[] = []
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'single start',
      outcome: 'single start outcome',
      subTasks: ['single start step'],
      doneWhen: 'single start complete',
      pathScope: ['src'],
      emitParentEvent: (ev) => {
        emitted.push(ev)
        appendEvent(resolveRunDir(workspacePath, parentRunId), ev)
      }
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const parentDir = resolveRunDir(workspacePath, parentRunId)
    await flushEventAppends(parentDir)
    const eventsPath = join(parentDir, 'events.jsonl')
    const lines = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const raw = JSON.parse(line) as {
          type?: string
          instanceRunId?: string
          phase?: string
          event?: { type?: string; instanceRunId?: string; phase?: string }
        }
        return raw.event ?? raw
      })
    const started = lines.filter(
      (e) =>
        e.type === 'agent_instance_update' &&
        e.instanceRunId === child.runId &&
        e.phase === 'started'
    )
    expect(started).toHaveLength(1)
    expect(emitted).toHaveLength(1)
    clearRunAbort(child.runId)
  })

  it('finish cleanup unregisters maps even when status was not terminal in memory', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'cleanup',
      outcome: 'cleanup outcome',
      subTasks: ['cleanup step'],
      doneWhen: 'cleanup complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(getActiveInlineChildRunIds(parentRunId)).toContain(child.runId)
    await handleInlineInstanceFinished(workspacePath, child.runId, 'error')
    expect(getActiveInlineChildRunIds(parentRunId)).not.toContain(child.runId)
    expect(isActive(child.runId)).toBe(true) // abort still registered until clear
    clearRunAbort(child.runId)
  })

  it('parent cancel notifies waiters with cancelled phase', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'cancel me',
      outcome: 'cancel me outcome',
      subTasks: ['cancel me step'],
      doneWhen: 'cancel me complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const waitPromise = waitForChildTerminal(child.runId, workspacePath, 5_000)
    await handleInlineInstanceFinished(workspacePath, child.runId, 'cancelled')
    const terminal = await waitPromise
    expect(terminal.phase).toBe('cancelled')
    clearRunAbort(child.runId)
  })

  it('unregisterChildInstance can be called after maps already cleared', async () => {
    registerChildInstance(parentRunId, 'ghost', workspacePath)
    unregisterChildInstance('ghost')
    unregisterChildInstance('ghost')
  })

  it('force-finishes a cancelled run whose loop never unwound', async () => {
    const zombieId = `zombie-${Date.now()}`
    createRun(workspacePath, zombieId, 'zombie goal', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    const reg = tryRegisterRunAbort(zombieId, workspacePath)
    expect(reg.ok).toBe(true)
    expect(await forceFinishCancelledRun(zombieId)).toBe(true)
    expect(loadStatus(resolveRunDir(workspacePath, zombieId))?.status).toBe('cancelled')
    // Already terminal — a second force-finish (or a late normal unwind) is a no-op.
    expect(await forceFinishCancelledRun(zombieId)).toBe(false)
    clearRunAbort(zombieId)
  })

  it('arms a bounded force-finish after cancelRun', async () => {
    vi.useFakeTimers()
    try {
      const zombieId = `timer-zombie-${Date.now()}`
      createRun(workspacePath, zombieId, 'timer goal', {
        mode: 'agent',
        parentRunId,
        inlineInstance: true
      })
      const reg = tryRegisterRunAbort(zombieId, workspacePath)
      expect(reg.ok).toBe(true)
      expect(cancelRun(zombieId)).toBe(true)
      await vi.advanceTimersByTimeAsync(CANCEL_FORCE_FINISH_MS - 1_000)
      expect(loadStatus(resolveRunDir(workspacePath, zombieId))?.status).toBe('running')
      await vi.advanceTimersByTimeAsync(2_000)
      expect(loadStatus(resolveRunDir(workspacePath, zombieId))?.status).toBe('cancelled')
      // Terminal run cleared from the registry — the timer must not fire again.
      clearRunAbort(zombieId)
      await vi.advanceTimersByTimeAsync(CANCEL_FORCE_FINISH_MS)
      expect(loadStatus(resolveRunDir(workspacePath, zombieId))?.status).toBe('cancelled')
    } finally {
      vi.useRealTimers()
    }
  })

  it('summarizeChildRun returns the full last assistant text', async () => {
    const childRunId = `cap-${Date.now()}`
    createRun(workspacePath, childRunId, 'cap', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    const runDir = resolveRunDir(workspacePath, childRunId)
    const huge = 'x'.repeat(4_500)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'go' })}\n${JSON.stringify({ role: 'assistant', content: huge })}\n`
    )
    const summary = summarizeChildRun(workspacePath, childRunId)
    expect(summary).toContain(huge)
    expect(summary).not.toContain('…(truncated)')
  })

  it('agent_instance_update uses a short status line instead of the transcript', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'lean ui',
      outcome: 'lean ui outcome',
      subTasks: ['lean ui step'],
      doneWhen: 'lean ui complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const huge = 'x'.repeat(4_500)
    writeFileSync(
      join(resolveRunDir(workspacePath, child.runId), 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'go' })}\n${JSON.stringify({ role: 'assistant', content: huge })}\n`
    )
    await handleInlineInstanceFinished(workspacePath, child.runId, 'done')
    await flushEventAppends(resolveRunDir(workspacePath, parentRunId))
    const lines = readFileSync(join(resolveRunDir(workspacePath, parentRunId), 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const raw = JSON.parse(line) as {
          type?: string
          phase?: string
          summary?: string
          event?: { type?: string; phase?: string; summary?: string }
        }
        return raw.event ?? raw
      })
    const done = lines.find((e) => e.type === 'agent_instance_update' && e.phase === 'done')
    expect(done?.summary).toBe('Instance finished.')
    expect(done?.summary).not.toContain(huge)
    expect(summarizeChildRun(workspacePath, child.runId)).toContain(huge)
    const ipc = mainWindowSend.mock.calls
      .map((call) => call[1] as { type?: string; phase?: string; summary?: string })
      .find((payload) => payload?.type === 'agent_instance_update' && payload.phase === 'done')
    expect(ipc?.summary).toBe('Instance finished.')
    clearRunAbort(child.runId)
  })

  it('pullChildRun returns summary outline and tail', async () => {
    const childRunId = `pull-${Date.now()}`
    createRun(workspacePath, childRunId, 'pull', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    const runDir = resolveRunDir(workspacePath, childRunId)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: 'find call sites' }),
        JSON.stringify({ role: 'assistant', content: 'Found three call sites in auth.' })
      ].join('\n') + '\n'
    )
    const summary = await pullChildRun(workspacePath, childRunId, 'summary')
    expect(summary).toMatch(/status:/)
    expect(summary).toMatch(/Found three call sites/)
    const outline = await pullChildRun(workspacePath, childRunId, 'outline')
    expect(outline).toMatch(/messages: 2/)
    expect(outline).toMatch(/1\. user:/)
    expect(outline).toMatch(/2\. assistant:/)
    const tail = await pullChildRun(workspacePath, childRunId, 'tail')
    expect(tail).toMatch(/\[assistant\]/)
    expect(tail).toMatch(/Found three call sites/)
  })

  it('await timeout rejects without cancelling and mentions pull', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'timeout me',
      outcome: 'timeout me outcome',
      subTasks: ['timeout me step'],
      doneWhen: 'timeout me complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    await expect(waitForChildTerminal(child.runId, workspacePath, 50)).rejects.toThrow(
      /still running|pull_agent_instance/
    )
    expect(getActiveInlineChildRunIds(parentRunId)).toContain(child.runId)
    clearRunAbort(child.runId)
  })

  it('includes every message in the outline view', async () => {
    const childRunId = `outline-${Date.now()}`
    createRun(workspacePath, childRunId, 'outline', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    const runDir = resolveRunDir(workspacePath, childRunId)
    const count = 90
    const rows = Array.from({ length: count }, (_, i) =>
      JSON.stringify({ role: 'user', content: `m${i}` })
    )
    writeFileSync(join(runDir, 'messages.jsonl'), `${rows.join('\n')}\n`)
    const outline = await pullChildRun(workspacePath, childRunId, 'outline')
    expect(outline).toContain(`messages: ${count}`)
    expect(outline).toContain('1. user:')
    expect(outline).toContain(`${count}. user:`)
    expect(outline).not.toContain('more messages')
  })

  it('fails await immediately when disk says running but the child is not active', async () => {
    const childRunId = `stale-${Date.now()}`
    createRun(workspacePath, childRunId, 'stale', {
      mode: 'agent',
      parentRunId,
      inlineInstance: true
    })
    const started = Date.now()
    const terminal = await waitForChildTerminal(childRunId, workspacePath, 5_000)
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(terminal.phase).toBe('error')
    expect(terminal.summary).toMatch(/is not running/)
  })

  it('refuses parent delete while a child is active', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'keep running',
      outcome: 'keep running outcome',
      subTasks: ['keep running step'],
      doneWhen: 'keep running complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    clearRunAbort(parentRunId)
    const refused = await deleteRun(workspacePath, parentRunId)
    expect(refused.ok).toBe(false)
    if (!refused.ok) expect(refused.error).toMatch(/Cancel instance runs first/)
    clearRunAbort(child.runId)
  })

  it('cascades finished children when deleting a parent', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'delete with parent',
      outcome: 'delete with parent outcome',
      subTasks: ['delete with parent step'],
      doneWhen: 'delete with parent complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    await handleInlineInstanceFinished(workspacePath, child.runId, 'cancelled')
    clearRunAbort(child.runId)
    clearRunAbort(parentRunId)
    const childDir = resolveRunDir(workspacePath, child.runId)
    expect(existsSync(childDir)).toBe(true)
    const deleted = await deleteRun(workspacePath, parentRunId)
    expect(deleted.ok).toBe(true)
    expect(existsSync(childDir)).toBe(false)
  })

  it('rejects shared-workspace spawn without path_scope', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'needs scope',
      outcome: 'needs scope outcome',
      subTasks: ['needs scope step'],
      doneWhen: 'needs scope complete',
    })
    expect(child.ok).toBe(false)
    if (!child.ok) {
      expect(child.error).toMatch(/path_scope/i)
      expect(child.error).toContain('Workspace resolved to')
      expect(child.error).toContain(`${resolve(workspacePath)}", which is not a git repository.`)
    }
  })

  it('rejects spawn with an unsafe path_scope prefix', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'escape',
      outcome: 'escape outcome',
      subTasks: ['escape step'],
      doneWhen: 'escape complete',
      pathScope: ['../secret']
    })
    expect(child.ok).toBe(false)
    if (!child.ok) expect(child.error).toMatch(/safe workspace-relative path/i)
  })

  it('spawns without worktree when workspace is not a git repo and path_scope is set', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'shared fallback',
      outcome: 'shared fallback outcome',
      subTasks: ['shared fallback step'],
      doneWhen: 'shared fallback complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(child.worktreeBranch).toBeUndefined()
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    expect(status?.worktreePath).toBeUndefined()
    expect(status?.worktreeBranch).toBeUndefined()
    expect(status?.pathScope).toEqual(['src'])
    clearRunAbort(child.runId)
  })

  it('auto-cancels an inline instance after repeated tool denials', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'will be denied',
      outcome: 'will be denied outcome',
      subTasks: ['will be denied step'],
      doneWhen: 'will be denied complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    // Denials are logged but never cancel the inline instance (cap removed):
    // the parent decides when to stop the child, not the denial counter.
    expect(noteInlineInstanceDeniedTool(child.runId)).toBe(false)
    expect(noteInlineInstanceDeniedTool(child.runId)).toBe(false)
    expect(noteInlineInstanceDeniedTool(child.runId)).toBe(false)
    expect(getRunAbort(child.runId)?.signal.aborted).toBe(false)
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    expect(status?.inlineInstance).toBe(true)
  })

  it('cancelChildInstance rejects non-children and cancels live children', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'cancellable',
      outcome: 'cancellable outcome',
      subTasks: ['cancellable step'],
      doneWhen: 'cancellable complete',
      pathScope: ['src']
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return

    const foreign = cancelChildInstance(workspacePath, 'not-the-parent', child.runId)
    expect(foreign.ok).toBe(false)
    if (!foreign.ok) expect(foreign.error).toMatch(/not an inline instance/)

    const cancelled = cancelChildInstance(workspacePath, parentRunId, child.runId)
    expect(cancelled.ok).toBe(true)
    if (cancelled.ok) expect(cancelled.phase).toBe('cancelled')
    expect(getRunAbort(child.runId)?.signal.aborted).toBe(true)

    // Already-terminal children report as such instead of failing.
    await updateStatus(resolveRunDir(workspacePath, child.runId), { status: 'done' }, { sync: true })
    const again = cancelChildInstance(workspacePath, parentRunId, child.runId)
    expect(again.ok).toBe(true)
    if (again.ok) expect(again.phase).toBe('already-terminal')
  })

  it('ignores denial strikes for unknown runs', () => {
    expect(noteInlineInstanceDeniedTool('no-such-run')).toBe(false)
  })
})

describe('agentInstances worktree', () => {
  let workspacePath: string
  let parentRunId: string
  const wc = mockWebContents()
  const root = join(tmpdir(), `vyotiq-wt-root-${process.pid}`)

  async function git(args: string[]): Promise<void> {
    await execFileAsync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', ...args],
      {
        cwd: workspacePath,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }
    )
  }

  beforeEach(async () => {
    resetAgentInstancesForTests()
    resetActiveRunsForTests()
    mainWindowSend.mockClear()
    workspacePath = join(root, `ws-${Date.now()}`)
    mkdirSync(workspacePath, { recursive: true })
    writeFileSync(join(workspacePath, 'README.md'), 'base\n')
    await git(['init'])
    await git(['add', '.'])
    await git(['commit', '-m', 'init'])
    parentRunId = 'parent-run'
    createRun(workspacePath, parentRunId, 'parent goal')
    const reg = tryRegisterRunAbort(parentRunId, workspacePath)
    if (!reg.ok) throw new Error(reg.error)
    registerRunIpcSender(parentRunId, wc)
  })

  afterEach(() => {
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
  })

  it('creates worktree metadata for agent instance in a git repo', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'edit in worktree',
      outcome: 'edit in worktree outcome',
      subTasks: ['edit in worktree step'],
      doneWhen: 'edit in worktree complete',
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    expect(child.worktreeBranch).toMatch(/^vyotiq\/instance\//)
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    expect(status?.worktreeBranch).toBe(child.worktreeBranch)
    expect(status?.worktreePath).toBeTruthy()
    expect(existsSync(status!.worktreePath!)).toBe(true)
    const started = vi.mocked(startAgentRunInBackground).mock.calls.at(-1)?.[0]
    expect(JSON.stringify(started?.agentInput.messages)).not.toMatch(/merge_agent_instance/)
    await handleInlineInstanceFinished(workspacePath, child.runId, 'done')
    expect(existsSync(status!.worktreePath!)).toBe(false)
    clearRunAbort(child.runId)
  })

  it('keeps the instance branch on error (checkpoint survives) and deletes it on cancelled', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'error then keep branch',
      outcome: 'error then keep branch outcome',
      subTasks: ['error then keep branch step'],
      doneWhen: 'error then keep branch complete',
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    const branch = status?.worktreeBranch
    expect(branch).toBeTruthy()
    await handleInlineInstanceFinished(workspacePath, child.runId, 'error')
    const listed = await execFileAsync('git', ['branch', '--list', branch!], {
      cwd: workspacePath,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    // Error'd children keep their committed checkpoint branch — it is the only
    // durable copy of their applied edits (2026-08-31: error'd children lost
    // the branch and survived only as fsck-unreachable commits). Merge remains
    // done-only; this branch is for recovery/forensics.
    expect(listed.stdout.trim()).not.toBe('')
    clearRunAbort(child.runId)

    const cancelled = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'cancel then drop branch',
      outcome: 'cancel then drop branch outcome',
      subTasks: ['cancel then drop branch step'],
      doneWhen: 'cancel then drop branch complete',
    })
    expect(cancelled.ok).toBe(true)
    if (!cancelled.ok) return
    const cancelledStatus = loadStatus(resolveRunDir(workspacePath, cancelled.runId))
    const cancelledBranch = cancelledStatus?.worktreeBranch
    expect(cancelledBranch).toBeTruthy()
    await handleInlineInstanceFinished(workspacePath, cancelled.runId, 'cancelled')
    const cancelledListed = await execFileAsync('git', ['branch', '--list', cancelledBranch!], {
      cwd: workspacePath,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    expect(cancelledListed.stdout.trim()).toBe('')
    clearRunAbort(cancelled.runId)
  })

  it('commits dirty worktree edits before remove so merge applies them', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'dirty then finish',
      outcome: 'dirty then finish outcome',
      subTasks: ['dirty then finish step'],
      doneWhen: 'dirty then finish complete',
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    const wt = status?.worktreePath
    const branch = status?.worktreeBranch
    expect(wt && branch).toBeTruthy()
    writeFileSync(join(wt!, 'auto-commit.txt'), 'persisted\n')
    await updateStatus(resolveRunDir(workspacePath, child.runId), { status: 'done' }, { sync: true })
    await handleInlineInstanceFinished(workspacePath, child.runId, 'done')
    expect(existsSync(wt!)).toBe(false)
    const merged = await mergeAgentInstanceBranch(workspacePath, parentRunId, child.runId)
    expect(merged.ok).toBe(true)
    expect(existsSync(join(workspacePath, 'auto-commit.txt'))).toBe(true)
    clearRunAbort(child.runId)
  })

  it('merges finished instance branch sequentially into parent HEAD', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'merge me',
      outcome: 'merge me outcome',
      subTasks: ['merge me step'],
      doneWhen: 'merge me complete',
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    const wt = status?.worktreePath
    const branch = status?.worktreeBranch
    expect(wt && branch).toBeTruthy()
    writeFileSync(join(wt!, 'from-child.txt'), 'hello\n')
    await execFileAsync('git', ['add', '.'], {
      cwd: wt!,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    await execFileAsync(
      'git',
      ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'child change'],
      {
        cwd: wt!,
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
      }
    )
    await updateStatus(resolveRunDir(workspacePath, child.runId), { status: 'done' }, { sync: true })
    await handleInlineInstanceFinished(workspacePath, child.runId, 'done')
    const merged = await mergeAgentInstanceBranch(workspacePath, parentRunId, child.runId)
    expect(merged.ok).toBe(true)
    expect(existsSync(join(workspacePath, 'from-child.txt'))).toBe(true)
    clearRunAbort(child.runId)
  })

  it('refuses merge when parent worktree is dirty', async () => {
    const child = await spawnAgentInstance({
      parentRunId,
      workspacePath,
      goal: 'dirty parent refuse',
      outcome: 'dirty parent refuse outcome',
      subTasks: ['dirty parent refuse step'],
      doneWhen: 'dirty parent refuse complete',
    })
    expect(child.ok).toBe(true)
    if (!child.ok) return
    const status = loadStatus(resolveRunDir(workspacePath, child.runId))
    writeFileSync(join(status!.worktreePath!, 'child.txt'), 'x\n')
    await updateStatus(resolveRunDir(workspacePath, child.runId), { status: 'done' }, { sync: true })
    await handleInlineInstanceFinished(workspacePath, child.runId, 'done')
    // Tracked modification (not untracked): untracked-only parents are allowed by the merge gate.
    writeFileSync(join(workspacePath, 'README.md'), 'dirty\n')
    const merged = await mergeAgentInstanceBranch(workspacePath, parentRunId, child.runId)
    expect(merged.ok).toBe(false)
    if (!merged.ok) {
      expect(merged.error).toMatch(/uncommitted tracked changes/i)
    }
    clearRunAbort(child.runId)
  })
})

describe('instance worktree path/branch guards', () => {
  const workspacePath = join(tmpdir(), 'vyotiq-wt-guard-ws')

  it('accepts paths under instance-worktrees and rejects escapes', () => {
    const safe = instanceWorktreePath(workspacePath, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')
    expect(isSafeInstanceWorktreePath(workspacePath, safe)).toBe(true)
    expect(isSafeInstanceWorktreePath(workspacePath, join(safe, '..', '..', 'evil'))).toBe(false)
    expect(isSafeInstanceWorktreePath(workspacePath, workspacePath)).toBe(false)
    expect(isSafeInstanceWorktreePath(workspacePath, '')).toBe(false)
  })

  it('accepts only sanitized vyotiq/instance branches', () => {
    const branch = instanceWorktreeBranch('run-id-1')
    expect(branch.startsWith('vyotiq/instance/')).toBe(true)
    expect(isSafeInstanceBranch(branch)).toBe(true)
    expect(isSafeInstanceBranch('main')).toBe(false)
    expect(isSafeInstanceBranch('vyotiq/instance/../evil')).toBe(false)
    expect(isSafeInstanceBranch('vyotiq/instance/')).toBe(false)
  })
})
