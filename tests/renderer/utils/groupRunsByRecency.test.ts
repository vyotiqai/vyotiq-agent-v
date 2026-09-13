/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { groupRunsByRecency } from '@renderer/lib/utils/groupRunsByRecency'
import type { RunSummary } from '@shared/ipc'

function run(partial: Partial<RunSummary> & Pick<RunSummary, 'runId' | 'updatedAt'>): RunSummary {
  return {
    goal: partial.goal ?? partial.runId,
    status: partial.status ?? 'done',
    ...partial
  }
}

describe('groupRunsByRecency', () => {
  it('buckets runs by calendar day relative to now', () => {
    const now = new Date('2026-07-24T15:00:00.000Z')
    const groups = groupRunsByRecency(
      [
        run({ runId: 'a', updatedAt: '2026-07-24T12:00:00.000Z' }),
        run({ runId: 'b', updatedAt: '2026-07-23T12:00:00.000Z' }),
        run({ runId: 'c', updatedAt: '2026-07-20T12:00:00.000Z' }),
        run({ runId: 'd', updatedAt: '2026-06-01T12:00:00.000Z' })
      ],
      now
    )

    expect(groups.map((g) => g.id)).toEqual(['today', 'yesterday', 'week', 'older'])
    expect(groups.find((g) => g.id === 'today')?.runs.map((r) => r.runId)).toEqual(['a'])
    expect(groups.find((g) => g.id === 'yesterday')?.runs.map((r) => r.runId)).toEqual(['b'])
    expect(groups.find((g) => g.id === 'week')?.runs.map((r) => r.runId)).toEqual(['c'])
    expect(groups.find((g) => g.id === 'older')?.runs.map((r) => r.runId)).toEqual(['d'])
  })

  it('omits empty buckets', () => {
    const now = new Date('2026-07-24T15:00:00.000Z')
    const groups = groupRunsByRecency(
      [run({ runId: 'a', updatedAt: '2026-07-24T12:00:00.000Z' })],
      now
    )
    expect(groups).toHaveLength(1)
    expect(groups[0]?.id).toBe('today')
  })
})
