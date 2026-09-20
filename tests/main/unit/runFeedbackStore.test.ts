import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-runfeedback-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  getRunFeedbackEntry,
  loadRunFeedbackStore,
  recordRunFeedbackBestEffort,
  setRunFeedbackRating
} from '@main/agent/feedback/runFeedbackStore'
import { workspaceRunFeedbackPath } from '@main/storage/paths'
import {
  RUN_FEEDBACK_MAX_ENTRIES,
  RUN_FEEDBACK_RECENT_SLOTS,
  RUN_RECEIPT_VERSION
} from '@shared/ipc'
import type { RunReceipt } from '@shared/ipc'

const workspace = join(tmpdir(), `vyotiq-runfeedback-ws-${process.pid}-${Date.now()}`)

function receipt(overrides: Partial<RunReceipt> & Pick<RunReceipt, 'runId'>): RunReceipt {
  return {
    version: RUN_RECEIPT_VERSION,
    writtenAt: '2026-09-19T00:00:00.000Z',
    status: 'done',
    step: 1,
    compactionCount: 0,
    toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
    failureClusters: [],
    unreadEditPaths: [],
    wroteFiles: [],
    diagnostics: { calls: 0, ok: 0, clean: 0 },
    contractExcerpt: '',
    ...overrides
  }
}

function record(r: RunReceipt, inlineInstance = false): void {
  recordRunFeedbackBestEffort({ workspacePath: workspace, receipt: r, inlineInstance })
}

describe('runFeedbackStore', () => {
  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
  })

  it('records a finished run and reads it back', () => {
    record(
      receipt({
        runId: 'r1',
        goal: 'Fix the parser',
        failureClusters: [{ key: 'edit: old_string not found', count: 2 }]
      })
    )

    const entry = getRunFeedbackEntry(workspace, 'r1')
    expect(entry).toMatchObject({
      runId: 'r1',
      status: 'done',
      title: 'Fix the parser',
      failureClusters: [{ key: 'edit: old_string not found', count: 2 }]
    })
    expect(entry?.unchecked).toBeUndefined()
  })

  it('carries the verification gate verdict forward as `unchecked`', () => {
    record(receipt({ runId: 'r1', verificationGate: { wouldFire: true, reason: 'never_checked' } }))
    expect(getRunFeedbackEntry(workspace, 'r1')?.unchecked).toBe(true)
  })

  it('does not double-count when the same run is recorded twice', () => {
    // Interim receipts are rewritten every few steps and the final one lands
    // at teardown; both can reach the store.
    record(receipt({ runId: 'r1' }))
    record(receipt({ runId: 'r1', writtenAt: '2026-09-19T00:05:00.000Z' }))

    const store = loadRunFeedbackStore(workspace)
    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]?.at).toBe('2026-09-19T00:05:00.000Z')
  })

  it('skips runs that carry no signal', () => {
    record(receipt({ runId: 'cancelled', status: 'cancelled' }))
    record(receipt({ runId: 'running', status: 'running' }))
    record(receipt({ runId: 'child' }), true)
    recordRunFeedbackBestEffort({ workspacePath: workspace, receipt: null, inlineInstance: false })

    expect(loadRunFeedbackStore(workspace).entries).toHaveLength(0)
  })

  it('keeps errored runs', () => {
    record(receipt({ runId: 'r1', status: 'error', statusError: 'boom' }))
    expect(getRunFeedbackEntry(workspace, 'r1')?.status).toBe('error')
  })

  it('caps the store and prefers rated entries over newer unrated ones', () => {
    for (let i = 0; i < RUN_FEEDBACK_MAX_ENTRIES + 5; i++) {
      record(
        receipt({
          runId: `r${String(i).padStart(3, '0')}`,
          writtenAt: `2026-09-19T00:${String(i).padStart(2, '0')}:00.000Z`
        })
      )
      if (i === 0) {
        // Oldest run, but the only human verdict in the set.
        setRunFeedbackRating({ workspacePath: workspace, runId: 'r000', rating: 'down' })
      }
    }

    const store = loadRunFeedbackStore(workspace)
    expect(store.entries).toHaveLength(RUN_FEEDBACK_MAX_ENTRIES)
    expect(store.entries.find((e) => e.runId === 'r000')?.rating).toBe('down')
  })

  it('still records new runs when every stored entry is rated', () => {
    // The starvation case: a full store of human verdicts must not be able to
    // lock out the runs the store exists to remember.
    for (let i = 0; i < RUN_FEEDBACK_MAX_ENTRIES; i++) {
      const runId = `old${String(i).padStart(3, '0')}`
      record(receipt({ runId, writtenAt: `2026-09-19T00:${String(i).padStart(2, '0')}:00.000Z` }))
      setRunFeedbackRating({ workspacePath: workspace, runId, rating: 'up' })
    }
    expect(loadRunFeedbackStore(workspace).entries.every((e) => e.rating)).toBe(true)

    record(receipt({ runId: 'fresh', writtenAt: '2026-09-20T00:00:00.000Z' }))

    const store = loadRunFeedbackStore(workspace)
    expect(store.entries).toHaveLength(RUN_FEEDBACK_MAX_ENTRIES)
    expect(getRunFeedbackEntry(workspace, 'fresh')).toMatchObject({ runId: 'fresh' })
    // The evicted entry is the oldest rated one, not the new run.
    expect(store.entries.find((e) => e.runId === 'old000')).toBeUndefined()
    // And the reserve still holds ratings older than the recency floor.
    expect(store.entries.filter((e) => e.rating).length).toBe(RUN_FEEDBACK_MAX_ENTRIES - 1)
  })

  it('never gives the recency floor away to rated entries', () => {
    // 20 rated entries, then enough unrated runs to overflow the cap.
    for (let i = 0; i < 20; i++) {
      const runId = `rated${String(i).padStart(3, '0')}`
      record(receipt({ runId, writtenAt: `2026-09-19T00:${String(i).padStart(2, '0')}:00.000Z` }))
      setRunFeedbackRating({ workspacePath: workspace, runId, rating: 'down' })
    }
    for (let i = 0; i < 40; i++) {
      record(
        receipt({ runId: `new${String(i).padStart(3, '0')}`, writtenAt: `2026-09-21T00:${String(i).padStart(2, '0')}:00.000Z` })
      )
    }

    const store = loadRunFeedbackStore(workspace)
    expect(store.entries).toHaveLength(RUN_FEEDBACK_MAX_ENTRIES)
    const recent = store.entries.slice(0, RUN_FEEDBACK_RECENT_SLOTS)
    expect(recent.every((e) => e.runId.startsWith('new'))).toBe(true)
    // The remaining slots went to human verdicts rather than more recent runs.
    expect(store.entries.slice(RUN_FEEDBACK_RECENT_SLOTS).every((e) => e.rating === 'down')).toBe(
      true
    )
  })

  it('preserves a rating set before the run finished', () => {
    setRunFeedbackRating({
      workspacePath: workspace,
      runId: 'r1',
      rating: 'down',
      note: 'never ran the tests'
    })
    // Teardown then folds the deterministic fields in on top.
    record(receipt({ runId: 'r1', goal: 'Fix the parser' }))

    expect(getRunFeedbackEntry(workspace, 'r1')).toMatchObject({
      rating: 'down',
      note: 'never ran the tests',
      title: 'Fix the parser'
    })
  })

  it('clears the rating, its timestamp and its note together', () => {
    setRunFeedbackRating({ workspacePath: workspace, runId: 'r1', rating: 'up', note: 'good' })
    const cleared = setRunFeedbackRating({
      workspacePath: workspace,
      runId: 'r1',
      rating: null
    })

    expect(cleared.rating).toBeUndefined()
    expect(cleared.ratedAt).toBeUndefined()
    expect(cleared.note).toBeUndefined()
  })

  it('reads an unknown version as empty rather than migrating it', () => {
    const path = workspaceRunFeedbackPath(workspace)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, JSON.stringify({ version: 99, updatedAt: 'x', entries: [{ bogus: 1 }] }))

    expect(loadRunFeedbackStore(workspace).entries).toHaveLength(0)
    // And the next write replaces it cleanly.
    record(receipt({ runId: 'r1' }))
    expect(JSON.parse(readFileSync(path, 'utf8')).version).toBe(1)
  })

  it('reads a corrupt file as empty', () => {
    const path = workspaceRunFeedbackPath(workspace)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, '{ not json')

    expect(loadRunFeedbackStore(workspace).entries).toHaveLength(0)
  })

  it('returns an empty store when nothing has been recorded', () => {
    expect(loadRunFeedbackStore(workspace).entries).toEqual([])
    expect(getRunFeedbackEntry(workspace, 'nope')).toBeNull()
  })
})
