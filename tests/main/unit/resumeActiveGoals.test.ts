import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import type { WebContents } from 'electron'
import { formatGoalContinueMessage } from '@shared/goalRuntime'

const userData = join(tmpdir(), `vyotiq-goal-resume-${process.pid}-${Date.now()}`)
const launchMock = vi.hoisted(() => vi.fn(() => ({ ok: true as const })))
const rearmMock = vi.hoisted(() => vi.fn(() => null))
const workspaceState = vi.hoisted(() => ({ path: '' }))

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

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({
    openPaths: workspaceState.path ? [workspaceState.path] : [],
    recentPaths: [],
    activePath: workspaceState.path || null
  })
}))

vi.mock('@main/agent/launchRunInvoke', () => ({
  launchRunFollowUpOrStart: (...args: unknown[]) => launchMock(...args),
  resolveRunWebContents: () => null
}))

vi.mock('@main/agent/runLoopScheduler', () => ({
  rearmLoopFromDisk: (...args: unknown[]) => rearmMock(...args)
}))

import { createRun } from '@main/agent/state'
import { createGoal, pauseGoalIfActive, proposeGoal, readGoal } from '@main/agent/runGoal'
import { resolveRunDir } from '@main/storage/paths'
import { resetGoalResumeForTests, resumeActiveGoalsAndLoops } from '@main/agent/resumeActiveGoals'

describe('resumeActiveGoalsAndLoops', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-goal-resume-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    workspaceState.path = workspace
    launchMock.mockClear()
    rearmMock.mockClear()
    resetGoalResumeForTests()
  })

  afterEach(() => {
    workspaceState.path = ''
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('resumes active root goals and re-arms loops; skips paused and inline', () => {
    const activeId = 'goal-active'
    const pausedId = 'goal-paused'
    const inlineId = 'goal-inline'
    createRun(workspace, activeId, 'chat')
    createGoal(resolveRunDir(workspace, activeId), 'make CI green')
    createRun(workspace, pausedId, 'chat')
    createGoal(resolveRunDir(workspace, pausedId), 'paused objective')
    pauseGoalIfActive(resolveRunDir(workspace, pausedId))
    createRun(workspace, inlineId, 'chat', {
      inlineInstance: true,
      parentRunId: activeId
    })
    createGoal(resolveRunDir(workspace, inlineId), 'child should not resume')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(rearmMock).toHaveBeenCalledTimes(2)
    expect(launchMock).toHaveBeenCalledTimes(1)
    const launched = launchMock.mock.calls[0]?.[0] as {
      runId: string
      message: { content: string; synthetic?: boolean }
    }
    expect(launched.runId).toBe(activeId)
    expect(launched.message.content).toBe(formatGoalContinueMessage('make CI green'))
    // Protocol turn — must not render as a user chat bubble after resume.
    expect(launched.message.synthetic).toBe(true)
  })

  const launchCalls = (): Array<[{ runId: string; mode: string }]> =>
    launchMock.mock.calls as unknown as Array<[{ runId: string; mode: string }]>

  it('resumes a goal in its persisted interaction mode', () => {
    const askId = 'goal-ask-mode'
    createRun(workspace, askId, 'chat', 'ask')
    createGoal(resolveRunDir(workspace, askId), 'ask objective')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(launchMock).toHaveBeenCalledTimes(1)
    const launched = launchCalls()[0]?.[0]
    expect(launched?.runId).toBe(askId)
    expect(launched?.mode).toBe('ask')
  })

  it('resumes a pre-merge Plan run in Agent mode', () => {
    // status.json written before Plan merged into Agent still says "plan".
    // readStatus discards a status.json it cannot parse, so the value has to be
    // FOLDED, not rejected — otherwise the run loses its status and its goal
    // never resumes. This is that migration, end to end through resume.
    const legacyId = 'goal-legacy-plan-mode'
    const runDir = createRun(workspace, legacyId, 'chat', 'agent')
    const status = JSON.parse(readFileSync(join(runDir, 'status.json'), 'utf8')) as Record<
      string,
      unknown
    >
    writeFileSync(join(runDir, 'status.json'), JSON.stringify({ ...status, mode: 'plan' }))
    createGoal(runDir, 'legacy plan objective')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(launchMock).toHaveBeenCalledTimes(1)
    const launched = launchCalls()[0]?.[0]
    expect(launched?.runId).toBe(legacyId)
    expect(launched?.mode).toBe('agent')
  })

  it('skips the app-start relaunch when the run stopped on provider quota', () => {
    // Run 6265fa90 (2026-09-01): quota-exhausted terminal stops were relaunched
    // at every app restart and re-stopped instantly on the same billing-gate
    // error. quotaGate's contract is "no automatic relaunch"; the app-start
    // path must honor it too.
    const quotaId = 'goal-quota'
    createRun(workspace, quotaId, 'chat')
    createGoal(resolveRunDir(workspace, quotaId), 'quota objective')
    const statusPath = join(resolveRunDir(workspace, quotaId), 'status.json')
    writeFileSync(
      statusPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(statusPath, 'utf8')),
        status: 'error',
        error: 'Weekly usage limit reached. Resets in 6 days'
      })
    )

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(launchMock).not.toHaveBeenCalled()
  })
  it('never relaunches a goal the user has not started', () => {
    // A proposal is inert: app start must not be the thing that grants it.
    const proposedId = 'goal-proposed'
    createRun(workspace, proposedId, 'chat')
    proposeGoal(resolveRunDir(workspace, proposedId), 'agent suggested this')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(launchMock).not.toHaveBeenCalled()
    expect(readGoal(resolveRunDir(workspace, proposedId))?.status).toBe('proposed')
  })

  it('auto-resumes once, then waits for the user at the next restart', () => {
    const runId = 'goal-ceiling'
    createRun(workspace, runId, 'chat')
    const runDir = resolveRunDir(workspace, runId)
    createGoal(runDir, 'make CI green')

    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)
    expect(launchMock).toHaveBeenCalledTimes(1)
    expect(readGoal(runDir)?.autoResumeCount).toBe(1)

    // Second boot with no user turn in between: a crash loop must not keep
    // relaunching the same goal at every launch.
    resetGoalResumeForTests()
    launchMock.mockClear()
    resumeActiveGoalsAndLoops({ isDestroyed: () => false } as WebContents)

    expect(launchMock).not.toHaveBeenCalled()
    // The goal stays active and visible so the banner's Resume is the way back.
    expect(readGoal(runDir)?.status).toBe('active')
  })
})
