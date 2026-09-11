import { describe, expect, it } from 'vitest'
import type { RunStat, RunSummary } from '@shared/ipc'
import {
  attentionHomeEntries,
  flattenHomeEntries,
  homeEntryKey,
  runningHomeEntries,
  stateOfHomeEntry
} from '@renderer/features/home/homeEntries'

function run(runId: string, status: RunSummary['status'], updatedAt: string, extra: Partial<RunSummary> = {}): RunSummary {
  return { runId, status, updatedAt, ...extra }
}

describe('Home operational entries', () => {
  it('uses workspace and run id together for identity', () => {
    expect(homeEntryKey({ workspacePath: '/a', run: run('same', 'done', '2026-01-01') }))
      .not.toBe(homeEntryKey({ workspacePath: '/b', run: run('same', 'done', '2026-01-01') }))
  })

  it('flattens parent sessions in workspace order and sorts by recency', () => {
    const entries = flattenHomeEntries(['/a', '/b'], {
      '/a': { runs: [run('older', 'done', '2026-01-01T00:00:00Z')] },
      '/b': { runs: [run('newer', 'done', '2026-01-02T00:00:00Z')] }
    })
    expect(entries.map((entry) => entry.run.runId)).toEqual(['newer', 'older'])
  })

  it('prioritizes failures, interruptions, then unverified changes', () => {
    const entries = flattenHomeEntries(['/repo'], {
      '/repo': {
        runs: [
          run('unverified', 'done', '2026-01-03T00:00:00Z'),
          run('interrupted', 'cancelled', '2026-01-02T00:00:00Z', { resumable: true }),
          run('failed', 'error', '2026-01-01T00:00:00Z')
        ]
      }
    })
    const stats: Record<string, RunStat> = {
      [homeEntryKey(entries.find((entry) => entry.run.runId === 'unverified')!)]: {
        runId: 'unverified',
        messages: 1,
        verification: { verifiedAfterLastMutation: false }
      }
    }
    expect(attentionHomeEntries(entries, stats, new Set()).map((entry) => entry.run.runId))
      .toEqual(['failed', 'interrupted', 'unverified'])
  })

  it('keeps running sessions out of attention even with stale error state', () => {
    const entry = { workspacePath: '/repo', run: run('active', 'error', '2026-01-01') }
    const active = new Set([homeEntryKey(entry)])
    expect(stateOfHomeEntry(entry, undefined, active)).toBe('running')
    expect(attentionHomeEntries([entry], {}, active)).toEqual([])
    expect(runningHomeEntries([entry], active)).toEqual([entry])
  })
})
