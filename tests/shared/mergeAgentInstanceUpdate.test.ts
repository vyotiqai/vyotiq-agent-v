import { describe, expect, it } from 'vitest'
import {
  mergeAgentInstanceMaps,
  mergeAgentInstanceUpdate
} from '@shared/utils/mergeAgentInstanceUpdate'

describe('mergeAgentInstanceUpdate', () => {
  it('preserves goal and pathScope when terminal update omits them', () => {
    const prev = {
      child1: {
        instanceRunId: 'child1',
        phase: 'started' as const,
        goal: 'Fix auth',
        pathScope: ['src/main/']
      }
    }
    const next = mergeAgentInstanceUpdate(prev, {
      type: 'agent_instance_update',
      runId: 'parent',
      parentRunId: 'parent',
      instanceRunId: 'child1',
      phase: 'done',
      summary: 'Done.'
    })
    expect(next.child1?.goal).toBe('Fix auth')
    expect(next.child1?.pathScope).toEqual(['src/main/'])
    expect(next.child1?.summary).toBe('Done.')
  })
})

describe('mergeAgentInstanceMaps', () => {
  it('keeps live-only entries when disk map is empty', () => {
    const prior = {
      live: {
        instanceRunId: 'live',
        phase: 'started' as const,
        goal: 'still running'
      }
    }
    const merged = mergeAgentInstanceMaps(prior, {})
    expect(merged.live?.phase).toBe('started')
    expect(merged.live?.goal).toBe('still running')
  })

  it('prefers disk terminal phase over live started', () => {
    const prior = {
      child: {
        instanceRunId: 'child',
        phase: 'started' as const,
        goal: 'g'
      }
    }
    const fromDisk = {
      child: {
        instanceRunId: 'child',
        phase: 'done' as const,
        goal: 'g',
        summary: 'ok'
      }
    }
    const merged = mergeAgentInstanceMaps(prior, fromDisk)
    expect(merged.child?.phase).toBe('done')
    expect(merged.child?.summary).toBe('ok')
  })
})

describe('instance progress', () => {
  const update = (
    phase: 'started' | 'done',
    extra: Record<string, unknown> = {}
  ): Parameters<typeof mergeAgentInstanceUpdate>[1] => ({
    type: 'agent_instance_update',
    runId: 'parent',
    parentRunId: 'parent',
    instanceRunId: 'child',
    phase,
    ...extra
  })

  it('keeps when it started, takes each step and activity, and drops the activity once it ends', () => {
    let map = mergeAgentInstanceUpdate({}, update('started', { at: '2026-09-28T09:49:32.000Z', stepId: 's2' }))
    map = mergeAgentInstanceUpdate(map, update('started', { at: '2026-09-28T09:50:00.000Z', step: 4, activity: 'Reading loop.ts' }))
    expect(map.child).toMatchObject({ startedAt: '2026-09-28T09:49:32.000Z', step: 4, activity: 'Reading loop.ts', stepId: 's2' })
    map = mergeAgentInstanceUpdate(map, update('done', { at: '2026-09-28T09:53:51.000Z' }))
    expect(map.child).toMatchObject({ phase: 'done', endedAt: '2026-09-28T09:53:51.000Z', step: 4 })
    expect(map.child?.activity).toBeUndefined()
  })

  it('does not let a late progress update reopen a finished child', () => {
    const done = mergeAgentInstanceUpdate({}, update('done', { at: '2026-09-28T09:53:51.000Z' }))
    const late = mergeAgentInstanceUpdate(done, update('started', { step: 20, activity: 'Reading' }))
    expect(late.child?.phase).toBe('done')
  })

  it('stamps an update from its events.jsonl row when the event has no stamp of its own', () => {
    const map = mergeAgentInstanceUpdate({}, update('started'), '2026-09-28T09:49:32.432Z')
    expect(map.child?.startedAt).toBe('2026-09-28T09:49:32.432Z')
  })
})
