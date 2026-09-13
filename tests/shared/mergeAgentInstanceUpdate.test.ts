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
