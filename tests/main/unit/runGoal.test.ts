import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  bumpGoalContinueCount,
  createGoal,
  formatActiveGoalSection,
  pauseGoalIfActive,
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
})
