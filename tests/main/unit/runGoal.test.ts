import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  activateGoalByUser,
  bumpGoalAutoResume,
  bumpGoalContinueCount,
  clearGoalAutoResume,
  createGoal,
  dismissGoalProposal,
  formatActiveGoalSection,
  goalOrigin,
  pauseGoalIfActive,
  proposeGoal,
  readGoal,
  updateGoalStatus
} from '@main/agent/runGoal'

describe('runGoal store', () => {
  let runDir: string

  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-goal-'))
  })

  afterEach(() => {
    if (existsSync(runDir)) rmSync(runDir, { recursive: true, force: true })
  })

  it('creates, replaces, pauses, resumes, and completes', () => {
    const first = createGoal(runDir, 'fix tests')
    expect(first.status).toBe('active')
    expect(readGoal(runDir)?.objective).toBe('fix tests')

    const replaced = createGoal(runDir, 'make CI green')
    expect(replaced.objective).toBe('make CI green')
    expect(readGoal(runDir)?.status).toBe('active')

    const paused = pauseGoalIfActive(runDir)
    expect(paused?.status).toBe('paused')

    const resumed = updateGoalStatus(runDir, 'active')
    expect(resumed.status).toBe('active')

    const completed = updateGoalStatus(runDir, 'complete')
    expect(completed.status).toBe('complete')
    expect(() => updateGoalStatus(runDir, 'active')).toThrow(/completed goal/i)
  })

  it('bumps continueCount only while active', () => {
    createGoal(runDir, 'ship')
    expect(bumpGoalContinueCount(runDir)?.continueCount).toBe(1)
    expect(bumpGoalContinueCount(runDir)?.continueCount).toBe(2)
    pauseGoalIfActive(runDir)
    expect(bumpGoalContinueCount(runDir)?.continueCount).toBe(2)
  })

  it('wraps an overlay for active and paused goals', () => {
    const active = createGoal(runDir, 'ship')
    const overlay = formatActiveGoalSection(active)
    expect(overlay).toContain('<active_goal>')
    expect(overlay).toContain('ship')
    expect(overlay).toMatch(/Never pause yourself/i)
    expect(formatActiveGoalSection(pauseGoalIfActive(runDir))).toContain('Status: paused')
    expect(formatActiveGoalSection(updateGoalStatus(runDir, 'complete'))).toBe('')
  })
  it('marks a user-set goal as user origin and active', () => {
    const goal = createGoal(runDir, 'fix tests')
    expect(goal.status).toBe('active')
    expect(goalOrigin(goal)).toBe('user')
  })

  it('reads a legacy goal.json with no origin as user-set', () => {
    const goal = createGoal(runDir, 'fix tests')
    const { origin: _origin, ...legacy } = goal
    writeFileSync(join(runDir, 'goal.json'), JSON.stringify(legacy), 'utf8')
    const read = readGoal(runDir)
    expect(read?.origin).toBeUndefined()
    expect(read && goalOrigin(read)).toBe('user')
  })

  it('lands an agent-created goal as an inert proposal', () => {
    const goal = proposeGoal(runDir, 'refactor everything')
    expect(goal.status).toBe('proposed')
    expect(goalOrigin(goal)).toBe('agent')
    // The proposal must not inject the "never stop" overlay before the grant.
    expect(formatActiveGoalSection(goal)).toBe('')
    // Nor may it be auto-continued, relaunched, or counted as progress.
    expect(bumpGoalContinueCount(runDir)?.continueCount).toBeUndefined()
    expect(bumpGoalAutoResume(runDir)?.autoResumeCount).toBeUndefined()
  })

  it('refuses to let the agent promote its own proposal', () => {
    proposeGoal(runDir, 'refactor everything')
    expect(() => updateGoalStatus(runDir, 'active')).toThrow(/awaiting user confirmation/i)
    expect(readGoal(runDir)?.status).toBe('proposed')
  })

  it('refuses to let the agent replace a live user-set goal', () => {
    createGoal(runDir, 'ship the release')
    expect(() => proposeGoal(runDir, 'rewrite the build')).toThrow(/already has a user-set goal/i)
    expect(readGoal(runDir)?.objective).toBe('ship the release')

    // A completed user goal is no longer live, so a proposal may take its place.
    updateGoalStatus(runDir, 'complete')
    expect(proposeGoal(runDir, 'rewrite the build').status).toBe('proposed')
  })

  it('activates a proposal only through the user path', () => {
    proposeGoal(runDir, 'refactor everything')
    const activated = activateGoalByUser(runDir)
    expect(activated.status).toBe('active')
    // Origin is a record of who authored it; the grant is the `active` status.
    expect(goalOrigin(activated)).toBe('agent')
    expect(bumpGoalContinueCount(runDir)?.continueCount).toBe(1)
  })

  it('dismisses a proposal and leaves no goal behind', () => {
    proposeGoal(runDir, 'refactor everything')
    expect(dismissGoalProposal(runDir)).toBe(true)
    expect(readGoal(runDir)).toBeNull()
    // Only proposals are dismissable.
    createGoal(runDir, 'ship it')
    expect(dismissGoalProposal(runDir)).toBe(false)
    expect(readGoal(runDir)?.status).toBe('active')
  })

  it('gives a resumed goal a fresh budget', () => {
    // A goal that paused on its auto-continue budget would otherwise re-pause
    // at the next turn end, making Resume useless.
    createGoal(runDir, 'make CI green')
    bumpGoalContinueCount(runDir)
    bumpGoalContinueCount(runDir)
    pauseGoalIfActive(runDir)
    expect(activateGoalByUser(runDir).continueCount).toBe(0)
  })

  it('tracks and clears the auto-resume ceiling', () => {
    createGoal(runDir, 'ship it')
    expect(bumpGoalAutoResume(runDir)?.autoResumeCount).toBe(1)
    expect(bumpGoalAutoResume(runDir)?.autoResumeCount).toBe(2)
    clearGoalAutoResume(runDir)
    expect(readGoal(runDir)?.autoResumeCount).toBe(0)
    // A user activation also starts the ceiling over.
    bumpGoalAutoResume(runDir)
    pauseGoalIfActive(runDir)
    expect(activateGoalByUser(runDir).autoResumeCount).toBe(0)
  })
})
