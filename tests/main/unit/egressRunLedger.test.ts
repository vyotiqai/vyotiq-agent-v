import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const activeRuns = vi.hoisted(() => ({
  value: [] as Array<{ runId: string; workspacePath: string; invokeId: number }>
}))

vi.mock('@main/storage/paths', () => ({
  resolveRunDir: (workspacePath: string, runId: string) => join(workspacePath, runId)
}))

vi.mock('@main/agent/runRegistry', () => ({
  listActiveRuns: () => activeRuns.value
}))

import {
  MAX_ORIGINS_PER_RUN,
  flushEgressRunLedgers,
  readEgressRunLedger,
  recordEgressForRun,
  startEgressRunLedger,
  stopEgressRunLedgerForTests
} from '@main/agent/egressRunLedger'
import { checkEgress, clearEgressLedger, type EgressLedgerEntry } from '@main/net/egress'

let workspace = ''

function entry(partial: Partial<EgressLedgerEntry> = {}): EgressLedgerEntry {
  return {
    at: 1_000,
    purpose: 'browser_subresource',
    method: 'GET',
    origin: 'https://example.com',
    allowed: true,
    reason: 'allowed',
    workspacePath: workspace,
    ...partial
  }
}

describe('egress run ledger', () => {
  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-egress-'))
    activeRuns.value = [{ runId: 'run-1', workspacePath: workspace, invokeId: 1 }]
    clearEgressLedger()
  })

  afterEach(async () => {
    stopEgressRunLedgerForTests()
    clearEgressLedger()
    rmSync(workspace, { recursive: true, force: true })
  })

  it('aggregates per origin instead of one row per request', async () => {
    recordEgressForRun(entry({ origin: 'https://cdn.example.com', at: 10 }))
    recordEgressForRun(entry({ origin: 'https://cdn.example.com', at: 20 }))
    recordEgressForRun(entry({ origin: 'https://cdn.example.com', at: 30 }))
    await flushEgressRunLedgers()

    const ledger = readEgressRunLedger(join(workspace, 'run-1'))
    expect(ledger?.origins).toHaveLength(1)
    expect(ledger?.origins[0]).toMatchObject({
      origin: 'https://cdn.example.com',
      allowed: 3,
      denied: 0,
      firstAt: 10,
      lastAt: 30
    })
  })

  it('counts refusals separately and keeps the distinct reasons and purposes', async () => {
    recordEgressForRun(entry({ origin: 'https://evil.com', allowed: true }))
    recordEgressForRun(
      entry({ origin: 'https://evil.com', allowed: false, reason: 'not_in_allowlist' })
    )
    recordEgressForRun(
      entry({ origin: 'https://evil.com', allowed: false, reason: 'not_in_allowlist' })
    )
    recordEgressForRun(
      entry({
        origin: 'https://evil.com',
        allowed: false,
        reason: 'blocked_host',
        purpose: 'browser_navigation'
      })
    )
    await flushEgressRunLedgers()

    const record = readEgressRunLedger(join(workspace, 'run-1'))?.origins[0]
    expect(record).toMatchObject({ allowed: 1, denied: 3 })
    expect(record?.denyReasons).toEqual(['not_in_allowlist', 'blocked_host'])
    expect(record?.purposes).toEqual(['browser_subresource', 'browser_navigation'])
  })

  it('attributes egress to the workspace active run when the entry carries no run id', async () => {
    recordEgressForRun(entry({ origin: 'https://api.example.com' }))
    await flushEgressRunLedgers()

    expect(readEgressRunLedger(join(workspace, 'run-1'))?.origins[0].origin).toBe(
      'https://api.example.com'
    )
  })

  it('ignores egress that belongs to no run', async () => {
    activeRuns.value = []
    recordEgressForRun(entry({ origin: 'https://api.example.com' }))
    recordEgressForRun(entry({ origin: 'https://api.example.com', workspacePath: undefined }))
    await flushEgressRunLedgers()

    expect(readEgressRunLedger(join(workspace, 'run-1'))).toBeNull()
  })

  it('sorts origins so the file is stable across writes', async () => {
    for (const origin of ['https://zulu.com', 'https://alpha.com', 'https://mike.com']) {
      recordEgressForRun(entry({ origin }))
    }
    await flushEgressRunLedgers()

    expect(readEgressRunLedger(join(workspace, 'run-1'))?.origins.map((o) => o.origin)).toEqual([
      'https://alpha.com',
      'https://mike.com',
      'https://zulu.com'
    ])
  })

  it('caps distinct origins and says how many it dropped', async () => {
    const overflow = 5
    for (let i = 0; i < MAX_ORIGINS_PER_RUN + overflow; i += 1) {
      recordEgressForRun(entry({ origin: `https://host-${i}.example` }))
    }
    await flushEgressRunLedgers()

    const ledger = readEgressRunLedger(join(workspace, 'run-1'))
    expect(ledger?.origins).toHaveLength(MAX_ORIGINS_PER_RUN)
    expect(ledger?.truncated).toBe(overflow)
  })

  it('returns null for an absent ledger', () => {
    expect(readEgressRunLedger(join(workspace, 'no-such-run'))).toBeNull()
  })

  /** The wiring: a real decision recorded in net/egress reaches the run file. */
  it('records decisions made through the live egress gate', async () => {
    startEgressRunLedger()

    checkEgress({
      url: 'https://tracker.example/collect?token=SUPERSECRET',
      purpose: 'browser_subresource',
      method: 'POST',
      workspacePath: workspace,
      allowlist: ['example.com']
    })
    await flushEgressRunLedgers()

    const ledger = readEgressRunLedger(join(workspace, 'run-1'))
    expect(ledger?.origins).toHaveLength(1)
    expect(ledger?.origins[0]).toMatchObject({
      origin: 'https://tracker.example',
      allowed: 0,
      denied: 1,
      denyReasons: ['not_in_allowlist']
    })
    expect(JSON.stringify(ledger)).not.toContain('SUPERSECRET')
  })

  it('startEgressRunLedger is idempotent, so a decision is not counted twice', async () => {
    startEgressRunLedger()
    startEgressRunLedger()

    checkEgress({
      url: 'https://example.com/a',
      purpose: 'browser_subresource',
      workspacePath: workspace
    })
    await flushEgressRunLedgers()

    expect(readEgressRunLedger(join(workspace, 'run-1'))?.origins[0].allowed).toBe(1)
  })
})
