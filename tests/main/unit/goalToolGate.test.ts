import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'
import { activateGoalByUser, createGoal, readGoal } from '@main/agent/runGoal'

/**
 * The authority boundary around goals: an active goal unlocks turn-end auto-
 * continue, resumable-error relaunch, and app-start relaunch, so the agent must
 * not be able to grant itself one. These tests drive the real tool entry point,
 * because the gate is only worth anything at the door the model knocks on.
 */
describe('goal tool authority gate', () => {
  let workspace: string
  let runDir: string

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-goal-gate-'))
    runDir = join(workspace, '.run')
    mkdirSync(runDir, { recursive: true })
  }

  afterEach(() => {
    if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('create_goal lands a proposal, not an active goal', async () => {
    setup()
    const result = await executeTool(
      'create_goal',
      JSON.stringify({ objective: 'rewrite the build system' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )

    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/awaiting user confirmation/i)
    const goal = readGoal(runDir)
    expect(goal?.status).toBe('proposed')
    expect(goal?.origin).toBe('agent')
  })

  it('update_goal cannot promote a proposal the agent made itself', async () => {
    setup()
    await executeTool(
      'create_goal',
      JSON.stringify({ objective: 'rewrite the build system' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )

    const promote = await executeTool(
      'update_goal',
      JSON.stringify({ status: 'active' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )

    expect(promote.ok).toBe(false)
    expect(promote.content).toMatch(/awaiting user confirmation/i)
    expect(readGoal(runDir)?.status).toBe('proposed')
  })

  it('create_goal will not overwrite a live user-set goal', async () => {
    setup()
    createGoal(runDir, 'ship the 1.0 release')

    const result = await executeTool(
      'create_goal',
      JSON.stringify({ objective: 'rewrite the build system' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )

    expect(result.ok).toBe(false)
    const goal = readGoal(runDir)
    expect(goal?.objective).toBe('ship the 1.0 release')
    expect(goal?.status).toBe('active')
  })

  it('completing a goal stays available to the agent once the user started it', async () => {
    setup()
    await executeTool(
      'create_goal',
      JSON.stringify({ objective: 'rewrite the build system' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    activateGoalByUser(runDir)

    const done = await executeTool(
      'update_goal',
      JSON.stringify({ status: 'complete' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )

    expect(done.ok).toBe(true)
    expect(readGoal(runDir)?.status).toBe('complete')
  })
})
