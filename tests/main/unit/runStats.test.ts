import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectRunStats } from '@main/agent/runStats'

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => join(tmpdir(), `vyotiq-${name}`),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  }
}))

const root = mkdtempSync(join(tmpdir(), `vyotiq-runstats-${process.pid}-`))

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
})

function makeRun(id: string, files: Record<string, string>): void {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content)
  }
}

describe('collectRunStats', () => {
  it('stitches archive heads + live transcript and extracts receipt tokenUsage', async () => {
    makeRun('run-1', {
      'messages.archive.20260101T000000.jsonl': '{"role":"user"}\n{"role":"assistant"}\n',
      'messages.jsonl': '{"role":"user"}\n',
      'receipt.json': JSON.stringify({
        tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
      })
    })

    const stats = await collectRunStats(root, ['run-1'])

    expect(stats).toEqual([
      {
        runId: 'run-1',
        messages: 3,
        tokenUsage: { billedInputTokens: 1500, outputTokens: 120 }
      }
    ])
  })

  it('counts a final line without trailing newline and handles missing receipt', async () => {
    makeRun('run-2', { 'messages.jsonl': '{"role":"user"}\n{"role":"assistant"}' })

    const stats = await collectRunStats(root, ['run-2'])

    expect(stats).toEqual([{ runId: 'run-2', messages: 2 }])
  })

  it('returns zero messages for a run dir without a transcript', async () => {
    makeRun('run-3', {})

    const stats = await collectRunStats(root, ['run-3'])

    expect(stats).toEqual([{ runId: 'run-3', messages: 0 }])
  })

  it('omits runs whose id fails the containment guard, never zero-filling them', async () => {
    makeRun('run-4', { 'messages.jsonl': 'x\n' })

    const stats = await collectRunStats(root, ['..\\escape', 'run-4'])

    expect(stats).toEqual([{ runId: 'run-4', messages: 1 }])
  })

  it('omits tokenUsage from a corrupt receipt but still counts messages', async () => {
    makeRun('run-5', { 'messages.jsonl': 'a\n', 'receipt.json': '{not json' })

    const stats = await collectRunStats(root, ['run-5'])

    expect(stats).toEqual([{ runId: 'run-5', messages: 1 }])
  })

  it('surfaces the full receipt detail — tools, verification, steps, cost, model, context window', async () => {
    makeRun('run-6', {
      'messages.jsonl': 'x\n',
      'receipt.json': JSON.stringify({
        version: 5,
        writtenAt: '2026-09-09T10:00:00.000Z',
        runId: 'run-6',
        status: 'done',
        step: 7,
        provider: 'zai',
        model: 'glm-5.3',
        billedCost: 1.25,
        contextWindow: 131072,
        compactionCount: 2,
        tokenUsage: {
          billedInputTokens: 1500,
          outputTokens: 120,
          peakInputTokens: 90000,
          reasoningTokens: 40
        },
        toolStats: {
          totalCalls: 12,
          ok: 10,
          failed: 2,
          byName: { edit: { ok: 5, failed: 2 } }
        },
        failureClusters: [{ key: 'edit: old_string not found', count: 2 }],
        maxConsecutiveToolFailures: 3,
        verification: {
          lastMutationAt: '2026-09-09T09:00:00.000Z',
          lastCheckAt: '2026-09-09T08:00:00.000Z',
          verifiedAfterLastMutation: false
        },
        diagnostics: { calls: 0, ok: 0, clean: 0 },
        unreadEditPaths: [],
        wroteFiles: [],
        contractExcerpt: ''
      })
    })

    const stats = await collectRunStats(root, ['run-6'])

    expect(stats[0]).toMatchObject({
      runId: 'run-6',
      messages: 1,
      model: 'glm-5.3',
      provider: 'zai',
      billedCost: 1.25,
      contextWindow: 131072,
      steps: 7,
      compactionCount: 2,
      maxConsecutiveToolFailures: 3,
      verification: { verifiedAfterLastMutation: false },
      toolStats: { totalCalls: 12, ok: 10, failed: 2 },
      failureClusters: [{ key: 'edit: old_string not found', count: 2 }],
      tokenUsage: { peakInputTokens: 90000, reasoningTokens: 40 },
      writtenAt: '2026-09-09T10:00:00.000Z'
    })
  })

  it('derives startedAt from the first persisted event for durations', async () => {
    makeRun('run-7', {
      'messages.jsonl': 'x\n',
      'events.jsonl': '{"type":"status","runId":"run-7","at":"2026-09-09T09:00:00.000Z"}\n',
      'receipt.json': JSON.stringify({
        version: 5,
        writtenAt: '2026-09-09T10:00:00.000Z',
        runId: 'run-7',
        status: 'done',
        step: 1,
        compactionCount: 0,
        toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
        failureClusters: [],
        unreadEditPaths: [],
        wroteFiles: [],
        diagnostics: { calls: 0, ok: 0, clean: 0 },
        contractExcerpt: ''
      })
    })

    const stats = await collectRunStats(root, ['run-7'])

    expect(stats[0]!.startedAt).toBe('2026-09-09T09:00:00.000Z')
  })

  it('keeps tokenUsage from a partial legacy receipt the strict parse rejects', async () => {
    makeRun('run-8', {
      'messages.jsonl': 'a\n',
      // No required receipt fields — only the tokenUsage blob is readable.
      'receipt.json': JSON.stringify({ tokenUsage: { billedInputTokens: 1500 } })
    })

    const stats = await collectRunStats(root, ['run-8'])

    expect(stats).toEqual([
      {
        runId: 'run-8',
        messages: 1,
        tokenUsage: { billedInputTokens: 1500 }
      }
    ])
  })
})
