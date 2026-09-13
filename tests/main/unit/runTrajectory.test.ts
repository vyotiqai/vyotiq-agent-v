import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  buildPredictionManifest,
  buildTrajectoryFromEvents,
  writeTrajectoryArtifactsBestEffort,
  writeTrajectoryJsonl,
  TRAJECTORY_FILENAME,
  PREDICTION_FILENAME,
  PREDICTION_MANIFEST_VERSION
} from '@main/agent/runTrajectory'
import { PredictionManifestSchema } from '@shared/ipc'
import type { PersistedEvent, RunReceipt } from '@shared/ipc'
import { RUN_RECEIPT_VERSION } from '@shared/ipc'

function minimalReceipt(over: Partial<RunReceipt> = {}): RunReceipt {
  return {
    version: RUN_RECEIPT_VERSION,
    writtenAt: '2026-07-30T00:00:00.000Z',
    runId: 'run-1',
    status: 'done',
    step: 2,
    compactionCount: 0,
    toolStats: { totalCalls: 0, ok: 0, failed: 0, byName: {} },
    failureClusters: [],
    unreadEditPaths: [],
    wroteFiles: [],
    diagnostics: { calls: 0, ok: 0, clean: 0 },
    contractExcerpt: '',
    ...over
  }
}

describe('runTrajectory', () => {
  it('builds trajectory rows from tool and step events', () => {
    const events: PersistedEvent[] = [
      {
        at: '2026-07-30T00:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'run-1',
          toolCallId: 't1',
          name: 'read',
          summary: 'a.ts'
        }
      },
      {
        at: '2026-07-30T00:00:01.000Z',
        event: {
          type: 'tool_result',
          runId: 'run-1',
          toolCallId: 't1',
          name: 'read',
          summary: 'ok',
          ok: true
        }
      },
      {
        at: '2026-07-30T00:00:02.000Z',
        event: {
          type: 'step_usage',
          runId: 'run-1',
          step: 1,
          inputTokens: 10,
          outputTokens: 5
        }
      },
      {
        at: '2026-07-30T00:00:03.000Z',
        event: {
          type: 'context_usage',
          runId: 'run-1',
          step: 1,
          estimatedTokens: 1000,
          contextWindow: 128000,
          compactionTrigger: 100000,
          source: 'estimate',
          overflow: false,
          layers: { system: 1, history: 1, tools: 1, buffer: 1 }
        }
      },
      {
        at: '2026-07-30T00:00:03.500Z',
        event: { type: 'compaction_started', runId: 'run-1', mode: 'auto' }
      },
      {
        at: '2026-07-30T00:00:03.600Z',
        event: {
          type: 'compaction_verifying',
          runId: 'run-1',
          summary: 'Folded prior turns'
        }
      },
      {
        at: '2026-07-30T00:00:03.800Z',
        event: {
          type: 'compaction',
          runId: 'run-1',
          summary: 'Folded prior turns',
          kind: 'summary',
          verified: true
        }
      },
      {
        at: '2026-07-30T00:00:04.000Z',
        event: { type: 'status', runId: 'run-1', status: 'done' }
      }
    ]
    const rows = buildTrajectoryFromEvents(events)
    expect(rows.some((r) => r.kind === 'tool' && r.tool === 'read' && r.ok === true)).toBe(true)
    expect(rows.some((r) => r.kind === 'step_usage' && r.inputTokens === 10)).toBe(true)
    expect(rows.some((r) => r.kind === 'context_usage' && r.overflow === false)).toBe(true)
    expect(rows.some((r) => r.kind === 'compaction_started' && r.mode === 'auto')).toBe(true)
    expect(rows.some((r) => r.kind === 'compaction_verifying')).toBe(true)
    expect(rows.some((r) => r.kind === 'compaction' && r.summary?.includes('Folded'))).toBe(true)
    expect(rows.some((r) => r.kind === 'status' && r.status === 'done')).toBe(true)
  })

  it('builds observed_only prediction manifest from receipt heuristics', () => {
    const manifest = buildPredictionManifest(
      'run-1',
      minimalReceipt({
        unreadEditPaths: ['a.ts'],
        failureClusters: [{ key: 'edit: boom', count: 2 }],
        compactionCount: 2
      })
    )
    expect(manifest.version).toBe(PREDICTION_MANIFEST_VERSION)
    expect(manifest.observed_only).toBe(true)
    expect(manifest.predictions.every((p) => p.observed_only === true)).toBe(true)
    expect(manifest.predictions.some((p) => p.target === 'work_style')).toBe(true)
    expect(manifest.predictions.some((p) => p.target === 'tool_policy')).toBe(true)
    expect(manifest.predictions.some((p) => p.bucket === 'verify')).toBe(false)
    expect(manifest.predictions.some((p) => p.target === 'memory')).toBe(true)
    expect(PredictionManifestSchema.safeParse(manifest).success).toBe(true)
  })

  it('writes trajectory.jsonl and prediction.json best-effort', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-traj-'))
    try {
      const events: PersistedEvent[] = [
        {
          at: '2026-07-30T00:00:00.000Z',
          event: {
            type: 'tool_result',
            runId: 'run-1',
            toolCallId: 't1',
            name: 'read',
            summary: 'ok',
            ok: true
          }
        }
      ]
      writeTrajectoryArtifactsBestEffort({
        runDir: dir,
        runId: 'run-1',
        loadEvents: () => events,
        receipt: minimalReceipt({ unreadEditPaths: ['x.ts'] })
      })
      const traj = readFileSync(join(dir, TRAJECTORY_FILENAME), 'utf8').trim()
      expect(traj.length).toBeGreaterThan(0)
      expect(JSON.parse(traj).kind).toBe('tool')
      const pred = JSON.parse(readFileSync(join(dir, PREDICTION_FILENAME), 'utf8'))
      expect(pred.observed_only).toBe(true)
      expect(pred.predictions.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('still writes trajectory when prediction receipt is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-traj-norec-'))
    try {
      writeTrajectoryArtifactsBestEffort({
        runDir: dir,
        runId: 'run-1',
        loadEvents: () => [
          {
            at: 't',
            event: { type: 'status', runId: 'run-1', status: 'done' }
          }
        ],
        receipt: null
      })
      expect(readFileSync(join(dir, TRAJECTORY_FILENAME), 'utf8')).toContain('status')
      expect(() => readFileSync(join(dir, PREDICTION_FILENAME), 'utf8')).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('isolates trajectory write failures from callers', () => {
    expect(() =>
      writeTrajectoryArtifactsBestEffort({
        runDir: join(tmpdir(), 'vyotiq-traj-missing-parent', 'nope'),
        runId: 'run-x',
        loadEvents: () => {
          throw new Error('boom')
        }
      })
    ).not.toThrow()
  })

  it('writeTrajectoryJsonl creates readable jsonl', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-traj-jsonl-'))
    try {
      mkdirSync(dir, { recursive: true })
      writeTrajectoryJsonl(dir, [{ step: 1, kind: 'status', status: 'done' }])
      const line = readFileSync(join(dir, TRAJECTORY_FILENAME), 'utf8').trim()
      expect(JSON.parse(line)).toEqual({ step: 1, kind: 'status', status: 'done' })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
