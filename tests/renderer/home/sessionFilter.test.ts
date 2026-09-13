import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@shared/ipc'
import { filterRecentEntries } from '@renderer/features/home/sessionFilter'

interface RecentEntry {
  workspacePath: string
  run: RunSummary
}

function makeRun(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    runId: 'run-0001',
    status: 'done',
    updatedAt: '2026-09-08T00:00:00.000Z',
    ...overrides
  }
}

function makeEntry(
  workspacePath: string,
  overrides: Partial<RunSummary> = {}
): RecentEntry {
  return { workspacePath, run: makeRun(overrides) }
}

describe('filterRecentEntries', () => {
  it('passes entries through unchanged for empty and whitespace-only queries', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Write docs' }),
      makeEntry('C:\\repos\\beta', { runId: 'run-b' }),
      makeEntry('C:\\repos\\gamma', { runId: 'run-c', goal: 'Fix bug' })
    ]

    expect(filterRecentEntries(entries, '')).toEqual(entries)
    expect(filterRecentEntries(entries, '   ')).toEqual(entries)
    expect(filterRecentEntries(entries, ' \t ').map((e) => e.run.runId)).toEqual([
      'run-a',
      'run-b',
      'run-c'
    ])
  })

  it('matches session titles case-insensitively', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Write docs' }),
      makeEntry('C:\\repos\\beta', { runId: 'run-b', goal: 'Fix the Login Bug' }),
      makeEntry('C:\\repos\\gamma', { runId: 'abcdefgh', goal: undefined })
    ]

    expect(filterRecentEntries(entries, 'login').map((e) => e.run.runId)).toEqual(['run-b'])
    expect(filterRecentEntries(entries, 'LOGIN').map((e) => e.run.runId)).toEqual(['run-b'])
  })

  it('matches the run id prefix as title when a run has no goal', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Write docs' }),
      makeEntry('C:\\repos\\beta', { runId: 'abcdefgh' })
    ]

    expect(filterRecentEntries(entries, 'abcdefg').map((e) => e.run.runId)).toEqual(['abcdefgh'])
  })

  it('matches workspace display names', () => {
    const entries = [
      makeEntry('C:\\repos\\Vyotiq-App', { runId: 'run-a', goal: 'Write docs' }),
      makeEntry('C:\\repos\\other', { runId: 'run-b', goal: 'Fix bug' }),
      makeEntry('C:\\', { runId: 'run-c', goal: 'Read logs' })
    ]

    expect(filterRecentEntries(entries, 'vyotiq-app').map((e) => e.run.runId)).toEqual(['run-a'])
    expect(filterRecentEntries(entries, 'Other').map((e) => e.run.runId)).toEqual(['run-b'])
    expect(filterRecentEntries(entries, 'no workspace').map((e) => e.run.runId)).toEqual(['run-c'])
  })

  it('returns an empty array when nothing matches', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Write docs' }),
      makeEntry('C:\\repos\\beta', { runId: 'run-b', goal: 'Fix bug' })
    ]

    expect(filterRecentEntries(entries, 'zzz')).toEqual([])
  })

  it('preserves input order among matches', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Fix login flow' }),
      makeEntry('C:\\repos\\beta', { runId: 'run-b', goal: 'Write docs' }),
      makeEntry('C:\\repos\\gamma', { runId: 'run-c', goal: 'Fix login timeout' }),
      makeEntry('C:\\repos\\delta', { runId: 'run-d', goal: 'Refactor parser' })
    ]

    expect(filterRecentEntries(entries, 'login').map((e) => e.run.runId)).toEqual([
      'run-a',
      'run-c'
    ])
  })

  it('trims whitespace-padded multi-word queries before matching', () => {
    const entries = [
      makeEntry('C:\\repos\\alpha', { runId: 'run-a', goal: 'Fix login flow' }),
      makeEntry('C:\\repos\\beta', { runId: 'run-b', goal: 'Write docs' })
    ]

    expect(filterRecentEntries(entries, '  Fix Login  ').map((e) => e.run.runId)).toEqual([
      'run-a'
    ])
  })
})
