import { describe, expect, it } from 'vitest'
import type { NotificationItem, RunStat, RunSummary } from '@shared/ipc'
import {
  attentionGroups,
  attentionHomeEntries,
  blockedKeysForEntries,
  blockedRunTargets,
  flattenHomeEntries,
  homeEntryKey,
  inFlightHomeEntries,
  isRunningEntry,
  pinnedHomeEntries,
  stateOfHomeEntry
} from '@renderer/features/home/homeEntries'

function run(
  runId: string,
  status: RunSummary['status'],
  updatedAt: string,
  extra: Partial<RunSummary> = {}
): RunSummary {
  return { runId, status, updatedAt, ...extra }
}

function notification(runId: string, extra: Partial<NotificationItem> = {}): NotificationItem {
  return {
    id: `n-${runId}`,
    createdAt: '2026-01-01T00:00:00Z',
    read: false,
    source: 'agent',
    kind: 'needs_you',
    title: 'Needs your input',
    body: 'Approve write',
    dedupeKey: `needs_you:${runId}`,
    action: { type: 'open_run', workspacePath: '/repo', runId },
    ...extra
  }
}

describe('Home entry identity and ordering', () => {
  it('uses workspace and run id together for identity', () => {
    expect(homeEntryKey({ workspacePath: '/a', run: run('same', 'done', '2026-01-01') })).not.toBe(
      homeEntryKey({ workspacePath: '/b', run: run('same', 'done', '2026-01-01') })
    )
  })

  it('flattens parent sessions across workspaces and sorts by recency', () => {
    const entries = flattenHomeEntries(['/a', '/b'], {
      '/a': { runs: [run('older', 'done', '2026-01-01T00:00:00Z')] },
      '/b': { runs: [run('newer', 'done', '2026-01-02T00:00:00Z')] }
    })
    expect(entries.map((entry) => entry.run.runId)).toEqual(['newer', 'older'])
  })
})

describe('Home entry state', () => {
  it('ranks a blocked run above a live run', () => {
    const entry = { workspacePath: '/repo', run: run('live', 'running', '2026-01-01') }
    const active = new Set([homeEntryKey(entry)])
    const blocked = blockedKeysForEntries([entry], blockedRunTargets([notification('live')]))
    expect(stateOfHomeEntry(entry, undefined, active, blocked)).toBe('blocked')
    expect(stateOfHomeEntry(entry, undefined, active)).toBe('running')
  })

  it('keeps live runs out of attention even with a stale persisted error', () => {
    const entry = { workspacePath: '/repo', run: run('active', 'error', '2026-01-01') }
    const active = new Set([homeEntryKey(entry)])
    expect(stateOfHomeEntry(entry, undefined, active)).toBe('running')
    expect(attentionHomeEntries([entry], {}, active)).toEqual([])
    expect(isRunningEntry(entry, active)).toBe(true)
  })

  it('reports unverified edits only when a receipt says the check is stale', () => {
    const entry = { workspacePath: '/repo', run: run('edited', 'done', '2026-01-01') }
    const stale: RunStat = {
      runId: 'edited',
      messages: 1,
      verification: { verifiedAfterLastMutation: false }
    }
    const verified: RunStat = {
      runId: 'edited',
      messages: 1,
      verification: { verifiedAfterLastMutation: true }
    }
    expect(stateOfHomeEntry(entry, stale, new Set())).toBe('unverified')
    expect(stateOfHomeEntry(entry, verified, new Set())).toBe('done')
    expect(stateOfHomeEntry(entry, undefined, new Set())).toBe('done')
  })
})

describe('blocked run resolution', () => {
  it('counts only unread needs_you items that point at a run', () => {
    expect(
      blockedRunTargets([
        notification('waiting'),
        notification('answered', { read: true }),
        notification('other-kind', { kind: 'run_done' }),
        notification('no-action', { action: undefined })
      ]).map((target) => target.runId)
    ).toEqual(['waiting'])
  })

  it('matches a notification to its run across workspace path spellings', () => {
    const entries = flattenHomeEntries(['C:\\Repo-Alpha'], {
      'C:\\Repo-Alpha': { runs: [run('waiting', 'running', '2026-01-01')] }
    })
    // Windows paths compare case-insensitively, and separators canonicalize —
    // an exact key match would drop this row.
    const keys = blockedKeysForEntries(entries, [
      { workspacePath: 'c:/repo-alpha', runId: 'waiting' }
    ])
    expect([...keys]).toEqual([homeEntryKey(entries[0]!)])
  })

  it('does not match the same run id in a different workspace', () => {
    const entries = flattenHomeEntries(['/repo-a'], {
      '/repo-a': { runs: [run('shared', 'running', '2026-01-01')] }
    })
    expect(
      blockedKeysForEntries(entries, [{ workspacePath: '/repo-b', runId: 'shared' }]).size
    ).toBe(0)
  })

  it('does no work when nothing is blocked', () => {
    const entries = flattenHomeEntries(['/repo'], {
      '/repo': { runs: [run('a', 'done', '2026-01-01')] }
    })
    expect(blockedKeysForEntries(entries, []).size).toBe(0)
  })
})

describe('Home section selection', () => {
  const entries = flattenHomeEntries(['/repo'], {
    '/repo': {
      runs: [
        run('unverified', 'done', '2026-01-06T00:00:00Z'),
        run('goal', 'done', '2026-01-05T00:00:00Z', { goalStatus: 'active', goalContinueCount: 3 }),
        run('loop', 'done', '2026-01-04T00:00:00Z', {
          loopArmed: true,
          loopNextAt: '2026-01-07T00:00:00Z'
        }),
        run('live', 'running', '2026-01-03T00:00:00Z'),
        run('interrupted', 'cancelled', '2026-01-02T00:00:00Z', { resumable: true }),
        run('failed', 'error', '2026-01-01T00:00:00Z'),
        run('plain', 'done', '2025-12-31T00:00:00Z')
      ]
    }
  })
  const keyOf = (runId: string): string =>
    homeEntryKey(entries.find((entry) => entry.run.runId === runId)!)
  const stats: Record<string, RunStat> = {
    [keyOf('unverified')]: {
      runId: 'unverified',
      messages: 1,
      verification: { verifiedAfterLastMutation: false }
    }
  }

  it('orders attention by urgency then recency', () => {
    const blocked = blockedKeysForEntries(entries, blockedRunTargets([notification('goal')]))
    expect(
      attentionHomeEntries(entries, stats, new Set(), blocked).map((entry) => entry.run.runId)
    ).toEqual(['goal', 'failed', 'interrupted', 'unverified'])
  })

  it('folds attention rows by state, most urgent group first', () => {
    const blocked = blockedKeysForEntries(entries, blockedRunTargets([notification('goal')]))
    const groups = attentionGroups(attentionHomeEntries(entries, stats, new Set(), blocked))
    expect(groups.map((group) => group.state)).toEqual([
      'blocked',
      'failed',
      'interrupted',
      'unverified'
    ])
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.run.runId))).toEqual([
      'goal',
      'failed',
      'interrupted',
      'unverified'
    ])
  })

  it('groups every session of one state into a single lane', () => {
    const shared = flattenHomeEntries(['/repo'], {
      '/repo': {
        runs: [
          run('a', 'error', '2026-01-03T00:00:00Z'),
          run('b', 'error', '2026-01-02T00:00:00Z'),
          run('c', 'error', '2026-01-01T00:00:00Z')
        ]
      }
    })
    const groups = attentionGroups(attentionHomeEntries(shared, {}, new Set()))
    expect(groups).toHaveLength(1)
    expect(groups[0]!.state).toBe('failed')
    // Recency order inside the lane is the order the rows arrived in.
    expect(groups[0]!.entries.map((entry) => entry.run.runId)).toEqual(['a', 'b', 'c'])
  })

  it('collects live runs plus standing goals and armed loops, live first', () => {
    expect(inFlightHomeEntries(entries, new Set()).map((entry) => entry.run.runId)).toEqual([
      'live',
      'goal',
      'loop'
    ])
  })

  it('never repeats a run that a higher section already claimed', () => {
    const attention = attentionHomeEntries(entries, stats, new Set())
    const attentionKeys = new Set(attention.map(homeEntryKey))
    const inFlight = inFlightHomeEntries(entries, new Set(), attentionKeys)
    const shown = new Set([...attentionKeys, ...inFlight.map(homeEntryKey)])
    const pinned = pinnedHomeEntries(entries, [keyOf('live'), keyOf('plain')], shown)

    // `live` is already in flight, so the pinned section only adds `plain`.
    expect(pinned.map((entry) => entry.run.runId)).toEqual(['plain'])
    const allShown = [...attention, ...inFlight, ...pinned].map(homeEntryKey)
    expect(new Set(allShown).size).toBe(allShown.length)
  })

  it('drops pins whose run is no longer listed', () => {
    expect(pinnedHomeEntries(entries, ['/repo\0deleted'], new Set())).toEqual([])
  })
})
