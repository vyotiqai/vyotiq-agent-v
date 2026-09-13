import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  collectRecentReceipts,
  summarizeWeaknesses,
  writeHarnessProposal,
  runHarnessReview
} from '@main/agent/harnessReview'
import { extractProposedHarnessBody, upsertReceiptNotes } from '@main/agent/harnessApply'
import { RUN_RECEIPT_FILENAME, RUN_RECEIPT_VERSION } from '@main/agent/runReceipt'
import { workspaceSessionsRoot } from '@main/storage/paths'
import type { RunReceipt } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-harness-review-${process.pid}-${Date.now()}`)

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

function sampleReceipt(overrides?: Partial<RunReceipt>): RunReceipt {
  return {
    version: RUN_RECEIPT_VERSION,
    writtenAt: '2026-07-30T12:00:00.000Z',
    runId: 'run-a',
    status: 'done',
    step: 2,
    compactionCount: 0,
    toolStats: { totalCalls: 4, ok: 2, failed: 2, byName: { edit: { ok: 0, failed: 2 } } },
    failureClusters: [{ key: 'edit: ENOENT', count: 2 }],
    unreadEditPaths: ['src/foo.ts'],
    wroteFiles: ['src/foo.ts'],
    diagnostics: { calls: 0, ok: 0, clean: 0 },
    contractExcerpt: '## Done when',
    ...overrides
  }
}

describe('harnessReview', () => {
  let workspace: string

  beforeEach(() => {
    workspace = join(tmpdir(), `vyotiq-hr-ws-${process.pid}-${Date.now()}`)
    mkdirSync(workspace, { recursive: true })
    mkdirSync(userData, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
    if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
  })

  it('collects and summarizes receipts into a proposal file', async () => {
    const sessions = workspaceSessionsRoot(workspace)
    const runDir = join(sessions, 'run-a')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, RUN_RECEIPT_FILENAME), JSON.stringify(sampleReceipt()), 'utf8')

    const collected = collectRecentReceipts(workspace, { limit: 10 })
    expect(collected).toHaveLength(1)
    expect(collected[0]?.runId).toBe('run-a')

    const summary = summarizeWeaknesses(collected)
    expect(summary.receiptCount).toBe(1)
    expect(summary.bullets.some((b) => /Unread-before-edit/.test(b))).toBe(true)
    expect(summary.bullets.some((b) => /Recurring failure/.test(b))).toBe(true)
    expect(summary.evidenceBuckets.some((b) => b.component === 'loop_notices')).toBe(true)
    expect(summary.evidenceBuckets.some((b) => b.component === 'tool_policy')).toBe(true)
    expect(summary.evidenceBuckets.some((b) => b.component === 'system_prompt')).toBe(false)
    expect(summary.suggestions.join('\n')).toMatch(/runtime owners/i)
    expect(summary.suggestions.every((s) => !/Prefer file-backed|recovery hint|memory_write/i.test(s))).toBe(
      true
    )

    // Provide a harness so the proposal includes a Proposed harness body.
    mkdirSync(join(workspace, 'resources', 'harness'), { recursive: true })
    writeFileSync(
      join(workspace, 'resources', 'harness', 'default.md'),
      '# Agent V\n\n## Work style\n\nx\n',
      'utf8'
    )

    const written = writeHarnessProposal(workspace, summary)
    expect(written.relativePath).toMatch(/^resources\/harness\/proposals\//)
    expect(existsSync(written.proposalPath)).toBe(true)
    const body = readFileSync(written.proposalPath, 'utf8')
    expect(body).toMatch(/Suggested harness edits/)
    expect(body).toMatch(/Proposed harness body/)
    expect(body).toMatch(/## Evidence buckets/)
    const proposed = extractProposedHarnessBody(body)
    expect(proposed).toBe('# Agent V\n\n## Work style\n\nx\n')
    expect(proposed).not.toMatch(/Receipt review notes/)
    expect(body).toMatch(/run-a/)
    expect(body).toMatch(/receipt\.json/)
    expect(body).toMatch(/not unsupervised Self-Harness/)
    expect(body).toMatch(/writes only `resources\/harness\/default\.md`/)
    expect(body).toMatch(/runReceipt\.test\.ts/)

    const result = await runHarnessReview(workspace)
    expect(result.receiptCount).toBe(1)
    expect(existsSync(result.proposalPath)).toBe(true)
  })

  it('cites observational AHE trajectory and prediction artifacts in proposals', async () => {
    const sessions = workspaceSessionsRoot(workspace)
    const runDir = join(sessions, 'run-a')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, RUN_RECEIPT_FILENAME), JSON.stringify(sampleReceipt()), 'utf8')
    writeFileSync(join(runDir, 'trajectory.jsonl'), '{"step":0,"kind":"status"}\n', 'utf8')
    writeFileSync(
      join(runDir, 'prediction.json'),
      JSON.stringify({
        version: 1,
        runId: 'run-a',
        writtenAt: 't',
        observed_only: true,
        predictions: []
      }),
      'utf8'
    )

    const result = await runHarnessReview(workspace)
    const body = readFileSync(result.proposalPath, 'utf8')
    expect(body).toMatch(/trajectory\.jsonl/)
    expect(body).toMatch(/prediction\.json/)
    expect(body).toMatch(/observed_only|not auto-applied|not auto-merged/i)
    const proposed = extractProposedHarnessBody(body)
    expect(proposed).toMatch(/no editable harness|no resources\/harness\/default\.md/i)
    expect(proposed).not.toMatch(/Receipt review notes/)
  })

  it('migrates known legacy receipt versions without overstating diagnostics cleanliness', () => {
    const sessions = workspaceSessionsRoot(workspace)
    for (const version of [2, 3, 4]) {
      const runId = `legacy-${version}`
      const runDir = join(sessions, runId)
      mkdirSync(runDir, { recursive: true })
      const legacy = {
        ...sampleReceipt({
          runId,
          writtenAt: `2026-07-30T12:00:0${version}.000Z`
        }),
        version,
        diagnostics: { calls: 2, ok: 2 }
      } as Record<string, unknown>
      if (version < 4) {
        // older receipts lacked diagnostics.clean; migrate fills it
      }
      writeFileSync(join(runDir, RUN_RECEIPT_FILENAME), JSON.stringify(legacy), 'utf8')
    }

    const collected = collectRecentReceipts(workspace, { limit: 10 })
    expect(collected).toHaveLength(3)
    for (const { receipt } of collected) {
      expect(receipt.version).toBe(RUN_RECEIPT_VERSION)
      expect(receipt.diagnostics).toEqual({ calls: 2, ok: 2, clean: 0 })
      expect(receipt).not.toHaveProperty('verifyBeforeDone')
      expect(receipt).not.toHaveProperty('contractDoneWhen')
    }
  })



  it('mines verification staleness, diagnostics rate, and test outcomes', () => {
    const stale = sampleReceipt({
      runId: 'run-stale',
      verification: {
        lastMutationAt: '2026-07-30T12:00:00.000Z',
        lastCheckAt: '2026-07-30T11:00:00.000Z',
        verifiedAfterLastMutation: false
      },
      diagnostics: { calls: 2, ok: 2, clean: 1 },
      tests: { calls: 2, ok: 1, failed: 1, lastPassed: 18, lastFailed: 2 }
    })
    const summary = summarizeWeaknesses([{ runId: 'run-stale', receipt: stale }])
    expect(
      summary.bullets.some((b) =>
        /1 run\(s\) ended with file mutations after the last successful check/.test(b)
      )
    ).toBe(true)
    expect(summary.bullets.some((b) => /Diagnostics: 1\/2 clean/.test(b))).toBe(true)
    expect(
      summary.bullets.some((b) =>
        /run_tests: 1\/2 exited clean; latest run: 18 passed, 2 failed/.test(b)
      )
    ).toBe(true)
    expect(
      summary.evidenceBuckets.some(
        (b) =>
          b.component === 'tool_policy' &&
          b.evidence.some((e) => /successful diagnostics\/run_tests check/.test(e))
      )
    ).toBe(true)
  })

  it('reports consecutive tool-failure streaks from receipt metrics', () => {
    const sessions = workspaceSessionsRoot(workspace)
    const runs: Array<{ runId: string; streak?: number }> = [
      { runId: 'streak-low', streak: 1 },
      { runId: 'streak-high', streak: 3 }
    ]
    for (const { runId, streak } of runs) {
      const runDir = join(sessions, runId)
      mkdirSync(runDir, { recursive: true })
      writeFileSync(
        join(runDir, RUN_RECEIPT_FILENAME),
        JSON.stringify(
          sampleReceipt({
            runId,
            failureClusters: [],
            unreadEditPaths: [],
            ...(streak && streak >= 3 ? { maxConsecutiveToolFailures: streak } : {})
          })
        ),
        'utf8'
      )
    }

    const summary = summarizeWeaknesses(collectRecentReceipts(workspace))
    // Only the run with maxConsecutiveToolFailures >= 3 counts as a streak.
    expect(
      summary.bullets.some((b) =>
        /^1 run\(s\) had consecutive tool-failure streaks ≥ 3/.test(b)
      )
    ).toBe(true)
    // Streak-only evidence still routes into the tool_policy bucket.
    expect(summary.evidenceBuckets.some((b) => b.component === 'tool_policy')).toBe(true)
    expect(summary.suggestions.join('\n')).toMatch(/No harness-owned weakness found/i)
  })

  it('keeps a canonical proposed body valid (receipt notes stay outside default.md)', async () => {
    const { validateHarnessMarkdown } = await import('../../../scripts/sync-harness.mjs')
    const canonical = readFileSync(join(process.cwd(), 'resources', 'harness', 'default.md'), 'utf8')
    expect(validateHarnessMarkdown(canonical)).toEqual([])
    const withNotes = upsertReceiptNotes(canonical, ['Mined 1 receipt(s).'], [
      '- No harness-owned weakness found; route tool, loop, and memory signals to their runtime owners.'
    ])
    expect(validateHarnessMarkdown(withNotes).length).toBeGreaterThan(0)
    expect(withNotes).toMatch(/## Receipt review notes/)

    mkdirSync(join(workspace, 'resources', 'harness'), { recursive: true })
    writeFileSync(join(workspace, 'resources', 'harness', 'default.md'), canonical, 'utf8')
    const sessions = workspaceSessionsRoot(workspace)
    const runDir = join(sessions, 'run-a')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(join(runDir, RUN_RECEIPT_FILENAME), JSON.stringify(sampleReceipt()), 'utf8')

    const written = writeHarnessProposal(workspace, summarizeWeaknesses(collectRecentReceipts(workspace)))
    const proposed = extractProposedHarnessBody(readFileSync(written.proposalPath, 'utf8'))
    expect(proposed).toBeTruthy()
    expect(validateHarnessMarkdown(proposed!)).toEqual([])
    expect(proposed).not.toMatch(/^##\s+/m)
    expect(proposed).not.toMatch(/Receipt review notes/)
    expect(readFileSync(written.proposalPath, 'utf8')).toMatch(/## Evidence/)
  })
})
