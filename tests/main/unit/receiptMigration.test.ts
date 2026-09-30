import { describe, expect, it, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { migrateLegacyReceipt } from '@main/agent/receiptMigration'
import { RUN_RECEIPT_VERSION, RunReceiptSchema, type RunReceipt } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-receipt-migration-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

// `@main/agent/agentInstances` reads a run's receipt through readChildReceipt,
// whose public surface is summarizeChildRunAsync. startAgentRun is mocked so
// importing it does not boot the agent loop.
vi.mock('@main/agent/startAgentRun', () => ({ startAgentRunInBackground: vi.fn() }))

const { createRun } = await import('@main/agent/state')
const { resolveRunDir } = await import('@main/storage/paths')
const { pullChildRun, summarizeChildRunAsync } = await import('@main/agent/agentInstances')

const childRoot = join(tmpdir(), `vyotiq-receipt-migration-runs-${process.pid}`)

afterEach(() => {
  for (const dir of [userData, childRoot]) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }
})

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

/** Round-trip through JSON so the fixture is what a receipt.json on disk holds. */
function onDisk(doc: unknown): unknown {
  return JSON.parse(JSON.stringify(doc)) as unknown
}

describe('migrateLegacyReceipt', () => {
  it('migrates known legacy receipt versions without overstating diagnostics cleanliness', () => {
    for (const version of [2, 3, 4]) {
      const runId = `legacy-${version}`
      const legacy = onDisk({
        ...sampleReceipt({
          runId,
          writtenAt: `2026-07-30T12:00:0${version}.000Z`
        }),
        version,
        diagnostics: { calls: 2, ok: 2 }
      })

      const migrated = migrateLegacyReceipt(legacy)
      const receipt = migrated as Record<string, unknown>
      expect(receipt.version).toBe(RUN_RECEIPT_VERSION)
      expect(receipt.diagnostics).toEqual({ calls: 2, ok: 2, clean: 0 })
      expect(receipt).not.toHaveProperty('verifyBeforeDone')
      expect(receipt).not.toHaveProperty('contractDoneWhen')
      // The migrated document is what every reader then parses — a legacy
      // version is a `z.literal` mismatch, so an unmigrated parse drops the run.
      expect(RunReceiptSchema.safeParse(migrated).success).toBe(true)
    }
  })

  it('keeps a legacy receipt whose diagnostics object is partial', () => {
    // The migration copied calls/ok straight through; a missing value produced
    // a diagnostics object RunReceiptSchema rejected, so the run never reached
    // the review at all.
    const migrated = migrateLegacyReceipt(
      onDisk({
        ...sampleReceipt({
          runId: 'legacy-partial',
          writtenAt: '2026-07-30T12:00:00.000Z',
          failureClusters: [],
          unreadEditPaths: []
        }),
        version: 3,
        diagnostics: { calls: 2 }
      })
    )

    expect((migrated as Record<string, unknown>).diagnostics).toEqual({
      calls: 2,
      ok: 0,
      clean: 0
    })
    const parsed = RunReceiptSchema.safeParse(migrated)
    expect(parsed.success).toBe(true)
    expect(parsed.success ? parsed.data.diagnostics : null).toEqual({
      calls: 2,
      ok: 0,
      clean: 0
    })
  })

  it('drops the fields legacy receipts carried that the current schema does not accept', () => {
    const migrated = migrateLegacyReceipt(
      onDisk({
        ...sampleReceipt({ runId: 'legacy-fields' }),
        version: 2,
        verifyBeforeDone: true,
        contractDoneWhen: '- [ ] done'
      })
    )
    expect(migrated).not.toHaveProperty('verifyBeforeDone')
    expect(migrated).not.toHaveProperty('contractDoneWhen')
  })

  it('coerces a non-integer or negative diagnostics count to 0, never to a missing document', () => {
    const migrated = migrateLegacyReceipt(
      onDisk({
        ...sampleReceipt({ runId: 'legacy-dirty' }),
        version: 4,
        diagnostics: { calls: 1.5, ok: -2 }
      })
    )
    expect((migrated as Record<string, unknown>).diagnostics).toEqual({
      calls: 0,
      ok: 0,
      clean: 0
    })
    expect(RunReceiptSchema.safeParse(migrated).success).toBe(true)
  })

  it('survives a legacy receipt whose diagnostics value is not an object', () => {
    const migrated = migrateLegacyReceipt(
      onDisk({
        ...sampleReceipt({ runId: 'legacy-no-diag' }),
        version: 4,
        diagnostics: 7
      })
    )
    expect((migrated as Record<string, unknown>).diagnostics).toEqual({
      calls: 0,
      ok: 0,
      clean: 0
    })
    expect(RunReceiptSchema.safeParse(migrated).success).toBe(true)
  })

  it('leaves a current-version receipt untouched', () => {
    const current = onDisk(sampleReceipt({ runId: 'run-current' }))
    expect(migrateLegacyReceipt(current)).toEqual(current)
  })

  it('leaves a non-object or unknown version untouched', () => {
    expect(migrateLegacyReceipt(null)).toBe(null)
    expect(migrateLegacyReceipt('receipt')).toBe('receipt')
    expect(migrateLegacyReceipt([{ version: 2 }])).toEqual([{ version: 2 }])
    const unknownVersion = onDisk({ ...sampleReceipt(), version: 1 })
    expect(migrateLegacyReceipt(unknownVersion)).toEqual(unknownVersion)
  })

  it('does not rescue a legacy receipt that is otherwise invalid — the parse still fails', () => {
    const broken = migrateLegacyReceipt(
      onDisk({
        ...sampleReceipt({ runId: 'legacy-broken', status: 'nope' as RunReceipt['status'] }),
        version: 4
      })
    )
    expect(RunReceiptSchema.safeParse(broken).success).toBe(false)
  })

  /**
   * readChildReceipt is module-private; summarizeChildRunAsync / pullChildRun
   * are the public surface that reaches it, and their text is what the parent
   * agent is handed.
   */
  async function readChildReport(extra: Record<string, unknown>): Promise<{
    summary: string
    outline: string
  }> {
    const workspacePath = join(childRoot, `ws-${Date.now()}-${Math.random().toString(16).slice(2)}`)
    const childRunId = 'legacy-child'
    createRun(workspacePath, childRunId, 'child goal', {
      mode: 'agent',
      parentRunId: 'parent-run',
      inlineInstance: true
    })
    const runDir = resolveRunDir(workspacePath, childRunId)
    writeFileSync(
      join(runDir, 'messages.jsonl'),
      `${JSON.stringify({ role: 'user', content: 'go' })}\n${JSON.stringify({ role: 'assistant', content: 'child report' })}\n`
    )
    writeFileSync(
      join(runDir, 'receipt.json'),
      JSON.stringify({ ...sampleReceipt({ runId: childRunId }), ...extra })
    )
    return {
      summary: await summarizeChildRunAsync(workspacePath, childRunId),
      outline: await pullChildRun(workspacePath, childRunId, 'outline')
    }
  }

  it('keeps the parent verification line for a child receipt at legacy version 4', async () => {
    // readChildReceipt parses `version` as literal(5), so a receipt written by
    // an older build parsed to null and formatChildVerificationLine(null)
    // returned null — the parent got the child's prose with no `verification:`
    // line and no `wroteFiles:` block, silently.
    const { summary, outline } = await readChildReport({
      version: 4,
      diagnostics: { calls: 1, ok: 1 },
      wroteFiles: ['src/legacy.ts'],
      verification: {
        lastMutationAt: '2026-09-29T05:00:00.000Z',
        lastCheckAt: '2026-09-29T05:00:05.000Z',
        verifiedAfterLastMutation: true
      }
    })
    expect(summary).toContain('child report')
    expect(summary).toContain('wroteFiles:')
    expect(summary).toContain('src/legacy.ts')
    expect(summary).toContain('verification: checked')
    expect(summary).toContain('a check passed after its last code change')
    expect(outline).toContain('wroteFiles:')
    expect(outline).toContain('verification: checked')
  })

  it('keeps the parent verification line for child receipts at legacy versions 2 and 3', async () => {
    for (const version of [2, 3]) {
      const { summary } = await readChildReport({
        version,
        diagnostics: { calls: 2, ok: 2 },
        wroteFiles: [`src/legacy-${version}.ts`],
        verification: {
          lastMutationAt: '2026-09-29T05:00:00.000Z',
          lastCheckAt: '2026-09-29T05:00:05.000Z',
          verifiedAfterLastMutation: false
        }
      })
      expect(summary).toContain(`src/legacy-${version}.ts`)
      expect(summary).toContain('verification: UNCHECKED')
    }
  })

  it('still reports the verification line for a current-version child receipt', async () => {
    const { summary } = await readChildReport({
      wroteFiles: ['src/current.ts'],
      verification: {
        lastMutationAt: '2026-09-29T05:00:00.000Z',
        lastCheckAt: '2026-09-29T05:00:05.000Z',
        verifiedAfterLastMutation: true
      }
    })
    expect(summary).toContain('src/current.ts')
    expect(summary).toContain('verification: checked')
  })
})
