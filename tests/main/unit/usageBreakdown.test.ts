import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectHomeActivity, collectUsageTaskDays } from '@main/agent/activityStats'
import { resetJsonDocCacheForTests } from '@main/agent/jsonDocCache'
import { csvField, usageCsvFileName, usageRowsToCsv, USAGE_CSV_COLUMNS } from '@main/agent/usageExport'
import { workspaceSessionsRoot } from '@main/storage/paths'
import { HomeActivityRequestSchema, UsageExportRequestSchema } from '@shared/ipc'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), `vyotiq-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

const WS_A = 'C:\\vyotiq-usage-breakdown-a'
const WS_B = 'C:\\vyotiq-usage-breakdown-b'
const NOW = new Date('2026-09-09T12:00:00.000Z')

function makeRun(ws: string, id: string, files: Record<string, unknown>): void {
  const dir = join(workspaceSessionsRoot(ws), id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
}

function receipt(runId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 5,
    writtenAt: '2026-09-09T10:00:00.000Z',
    runId,
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

function status(goal: string): Record<string, unknown> {
  return { status: 'done', step: 1, updatedAt: '2026-09-09T10:00:00.000Z', goal }
}

function ledger(days: Record<string, Record<string, number>>): Record<string, unknown> {
  return {
    version: 1,
    lastTotals: { steps: 2, billedInputTokens: 0, outputTokens: 0, billedCost: 0, cachedInputTokens: 0 },
    days
  }
}

function seed(): void {
  makeRun(WS_A, 'a-big', {
    'status.json': status('Port the **updater**'),
    'receipt.json': receipt('a-big', { model: 'claude-sonnet-5' }),
    'usage.json': ledger({
      '2026-09-01': { inputTokens: 900, outputTokens: 90, billedCost: 9 },
      '2026-09-08': { inputTokens: 100, outputTokens: 10, billedCost: 1, cachedInputTokens: 40 },
      '2026-09-09': { inputTokens: 300, outputTokens: 30, estimatedCost: 0.5 }
    })
  })
  makeRun(WS_A, 'a-small', {
    'status.json': status('Fix lint'),
    'usage.json': ledger({ '2026-09-09': { inputTokens: 50, outputTokens: 5 } })
  })
  makeRun(WS_B, 'b-one', {
    'status.json': status('=HYPERLINK("http://x","y"), with "quotes"'),
    'receipt.json': receipt('b-one', { model: 'gpt-5' }),
    'usage.json': ledger({ '2026-09-07': { inputTokens: 200, outputTokens: 20, billedCost: 2 } })
  })
}

afterEach(() => {
  rmSync(workspaceSessionsRoot(WS_A), { recursive: true, force: true })
  rmSync(workspaceSessionsRoot(WS_B), { recursive: true, force: true })
  resetJsonDocCacheForTests()
})

describe('Usage breakdown', () => {
  it('totals each task and workspace over the window, costliest first, only when asked', async () => {
    seed()
    const plain = await collectHomeActivity([WS_A, WS_B], NOW, 7)
    expect(plain.tasks).toBeUndefined()

    const res = await collectHomeActivity([WS_A], NOW, 7, { breakdown: true })
    // One workspace still gets its slice when a breakdown is asked for.
    expect(res.workspaces).toEqual([
      { path: WS_A, runs: 2, billedInputTokens: 450, outputTokens: 45, cachedInputTokens: 40, billedCost: 1, estimatedCost: 0.5 }
    ])
    expect(res.tasks).toEqual([
      {
        runId: 'a-big',
        workspacePath: WS_A,
        goal: 'Port the **updater**',
        model: 'claude-sonnet-5',
        days: 2,
        billedInputTokens: 400,
        outputTokens: 40,
        cachedInputTokens: 40,
        billedCost: 1,
        estimatedCost: 0.5
      },
      { runId: 'a-small', workspacePath: WS_A, goal: 'Fix lint', days: 1, billedInputTokens: 50, outputTokens: 5 }
    ])
  })

  it('ends a custom range on its own last day, leaving later days out', async () => {
    seed()
    const res = await collectHomeActivity([WS_A, WS_B], NOW, 7, { endDay: '2026-09-07', breakdown: true })
    expect(res.endDay).toBe('2026-09-07')
    // 2026-09-01 … 2026-09-07: a-big's first day and b-one; nothing from the 8th or 9th.
    expect(res.days.map((day) => day.date)).toEqual(['2026-09-01', '2026-09-07'])
    expect(res.tasks?.map((task) => [task.runId, task.billedCost])).toEqual([
      ['a-big', 9],
      ['b-one', 2]
    ])
    expect(res.totals.runs).toBe(2)
  })

  it('reads a window up to a year, and refuses anything longer or a malformed day', () => {
    expect(HomeActivityRequestSchema.safeParse({ workspacePaths: [WS_A], windowDays: 365 }).success).toBe(true)
    expect(HomeActivityRequestSchema.safeParse({ workspacePaths: [WS_A], windowDays: 366 }).success).toBe(false)
    expect(HomeActivityRequestSchema.safeParse({ workspacePaths: [WS_A], endDay: '2026-9-7' }).success).toBe(false)
    expect(UsageExportRequestSchema.safeParse({ workspacePaths: [WS_A], windowDays: 0 }).success).toBe(false)
    return expect(collectHomeActivity([WS_A], NOW, 7, { endDay: '2026-02-30' })).rejects.toThrow('Invalid end day')
  })
})

describe('Usage CSV export', () => {
  it('writes one row per task per day that sums to the page', async () => {
    seed()
    const rows = await collectUsageTaskDays([WS_A, WS_B], NOW, 7)
    expect(rows.map((row) => [row.date, row.runId])).toEqual([
      ['2026-09-07', 'b-one'],
      ['2026-09-08', 'a-big'],
      ['2026-09-09', 'a-small'],
      ['2026-09-09', 'a-big']
    ])
    const page = await collectHomeActivity([WS_A, WS_B], NOW, 7)
    const sum = (pick: (row: (typeof rows)[number]) => number): number => rows.reduce((s, row) => s + pick(row), 0)
    expect(sum((row) => row.inputTokens)).toBe(page.totals.billedInputTokens)
    expect(sum((row) => row.outputTokens)).toBe(page.totals.outputTokens)
    expect(sum((row) => (row.billedCost ?? 0) + (row.estimatedCost ?? 0))).toBeCloseTo(
      (page.totals.billedCost ?? 0) + (page.totals.estimatedCost ?? 0)
    )

    const csv = usageRowsToCsv(rows)
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe(USAGE_CSV_COLUMNS.join(','))
    expect(lines.at(-1)).toBe('')
    expect(lines).toHaveLength(rows.length + 2)
    // The title that reads as a formula stays text, its quotes doubled, its comma quoted.
    expect(lines[1]).toBe(
      `2026-09-07,vyotiq-usage-breakdown-b,C:\\vyotiq-usage-breakdown-b,"'=HYPERLINK(""http://x"",""y""), with ""quotes""",b-one,gpt-5,200,20,0,2,billed`
    )
    expect(lines[2]).toBe('2026-09-08,vyotiq-usage-breakdown-a,C:\\vyotiq-usage-breakdown-a,Port the updater,a-big,claude-sonnet-5,100,10,40,1,billed')
    // A task nobody priced: no cost, no source — never a $0.
    expect(lines[3]).toBe('2026-09-09,vyotiq-usage-breakdown-a,C:\\vyotiq-usage-breakdown-a,Fix lint,a-small,,50,5,0,,')
    expect(lines[4]).toMatch(/,0\.5,estimated$/)
  })

  it('quotes what a spreadsheet would split or run', () => {
    expect(csvField('plain')).toBe('plain')
    expect(csvField('a,b')).toBe('"a,b"')
    expect(csvField('line\nbreak')).toBe('"line\nbreak"')
    expect(csvField(' padded')).toBe('" padded"')
    expect(csvField('+SUM(A1)')).toBe("'+SUM(A1)")
    expect(csvField('@cmd')).toBe("'@cmd")
    expect(csvField(-5, false)).toBe('-5')
    expect(csvField(undefined)).toBe('')
    expect(usageCsvFileName('2026-09-03', '2026-10-02')).toBe('vyotiq-usage-2026-09-03-to-2026-10-02.csv')
  })
})
