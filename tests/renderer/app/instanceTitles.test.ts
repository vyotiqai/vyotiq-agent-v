import { describe, expect, it } from 'vitest'
import { instanceDisplayTitle } from '@renderer/app/navigator/runTitle'
import { distinctTitles } from '@renderer/app/navigator/navigatorModel'
import { mergeLiveInstanceRuns } from '@renderer/app/mergeLiveInstanceRuns'
import { mergeAgentInstanceUpdate } from '@shared/utils/mergeAgentInstanceUpdate'

/**
 * Six analysts spawned with one background ("Repo: Vyotiq "Agent V" — an
 * Electron 44 + React 19 …") read as six identical rows in the navigator.
 * What tells siblings apart is the outcome each was asked for.
 */

const brief = (outcome: string): string =>
  `Outcome: ${outcome}\n\nSub-tasks:\n1. Repo: Vyotiq "Agent V" — an Electron 44 + React 19 coding-agent desktop app\n\nDone when: reported`

describe('an instance’s title', () => {
  it('is the outcome its brief names, not the background it shares', () => {
    expect(instanceDisplayTitle(brief('A map of the IPC boundary'), 'cc41c634-x')).toBe('A map of the IPC boundary')
    expect(instanceDisplayTitle(brief('Prove `pnpm test` exits 0'), 'cc41c634-x')).toBe('Prove pnpm test exits 0')
  })

  it('is cut like any other title when the outcome is long', () => {
    const title = instanceDisplayTitle(brief('A written analysis of how Agent V exposes tools to models and talks to providers'), 'x')
    expect(title.endsWith('…')).toBe(true)
    expect(title.length).toBeLessThanOrEqual(48)
  })
})

describe('distinctTitles', () => {
  it('drops the words every sibling opens with', () => {
    expect(
      distinctTitles([
        'A written analysis of the agent run lifecycle',
        'A written analysis of how Agent V exposes tools',
        'A written analysis of main-process services'
      ])
    ).toEqual(['The agent run lifecycle', 'How Agent V exposes tools', 'Main-process services'])
  })

  it('leaves titles alone whose shared opening is short, or that differ nowhere past it', () => {
    expect(distinctTitles(['Audit the docs', 'Audit the tests'])).toEqual(['Audit the docs', 'Audit the tests'])
    expect(distinctTitles(['Review docs', 'Review tests'])).toEqual(['Review docs', 'Review tests'])
    expect(distinctTitles(['Same title', 'Same title'])).toEqual(['Same title', 'Same title'])
    expect(distinctTitles(['Only one of them'])).toEqual(['Only one of them'])
  })
})

describe('an instance spawned for a step', () => {
  it('is named by that step, as the parent’s record names it', () => {
    expect(instanceDisplayTitle(brief('A verified integrity verdict'), 'x', undefined, 'Guard integrity: **removal** guards')).toBe(
      'Guard integrity: removal guards'
    )
  })

  it('keeps its step’s title through the live merges, and its helper type', () => {
    const started = mergeAgentInstanceUpdate(
      {},
      {
        type: 'agent_instance_update',
        runId: 'parent',
        parentRunId: 'parent',
        instanceRunId: 'kid',
        phase: 'started',
        stepId: 's2',
        stepTitle: 'Guard integrity'
      }
    )
    // A progress update carries no title: the start's stands.
    const progressed = mergeAgentInstanceUpdate(started, {
      type: 'agent_instance_update',
      runId: 'parent',
      parentRunId: 'parent',
      instanceRunId: 'kid',
      phase: 'started',
      activity: 'Thinking'
    })
    expect(progressed.kid?.stepTitle).toBe('Guard integrity')
    const listed = [{ runId: 'kid', status: 'running' as const, updatedAt: '2026-10-07T00:00:00.000Z', agentType: 'reviewer', stepTitle: 'Guard integrity' }]
    const [row] = mergeLiveInstanceRuns(listed, { kid: { instanceRunId: 'kid', phase: 'started' } }, 'parent')
    expect(row?.stepTitle).toBe('Guard integrity')
    expect(row?.agentType).toBe('reviewer')
  })
})
