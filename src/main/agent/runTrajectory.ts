import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { atomicWriteJson } from '../storage/atomicWrite'
import type { PersistedEvent, RunReceipt } from '../../shared/ipc'
import {
  PredictionManifestSchema,
  TRAJECTORY_FILENAME,
  PREDICTION_FILENAME,
  PREDICTION_MANIFEST_VERSION,
  type PredictionManifest,
  type TrajectoryRow
} from '../../shared/ipc'
import { logger } from '../../shared/logger'

export { TRAJECTORY_FILENAME, PREDICTION_FILENAME, PREDICTION_MANIFEST_VERSION }
export type { TrajectoryRow, PredictionManifest }

const TRAJECTORY_SUMMARY_CAP = 160
const TRAJECTORY_ROW_CAP = 2000

function clip(text: string, cap = TRAJECTORY_SUMMARY_CAP): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length <= cap ? t : `${t.slice(0, cap)}…`
}

/** Derive observational trajectory rows from persisted events (no LLM). */
export function buildTrajectoryFromEvents(
  events: readonly PersistedEvent[],
  opts?: { runId?: string; cap?: number }
): TrajectoryRow[] {
  const cap = opts?.cap ?? TRAJECTORY_ROW_CAP
  const rows: TrajectoryRow[] = []
  let lastStep = 0

  for (const row of events) {
    if (rows.length >= cap) break
    const ev = row.event as Record<string, unknown> | undefined
    if (!ev || typeof ev.type !== 'string') continue
    const at = typeof row.at === 'string' ? row.at : undefined
    const step =
      typeof ev.step === 'number' && Number.isInteger(ev.step) && ev.step >= 0
        ? ev.step
        : lastStep

    switch (ev.type) {
      case 'tool_start':
      case 'tool_result': {
        if (typeof ev.name !== 'string') break
        const base: TrajectoryRow = {
          at,
          step: lastStep || step || 0,
          kind: 'tool',
          tool: ev.name,
          ...(typeof ev.toolCallId === 'string' ? { toolCallId: ev.toolCallId } : {}),
          ...(typeof ev.summary === 'string' ? { summary: clip(ev.summary) } : {}),
          ...(ev.type === 'tool_result' && typeof ev.ok === 'boolean' ? { ok: ev.ok } : {})
        }
        rows.push(base)
        break
      }
      case 'step_usage': {
        if (typeof ev.step === 'number') lastStep = ev.step
        rows.push({
          at,
          step: typeof ev.step === 'number' ? ev.step : lastStep,
          kind: 'step_usage',
          ...(typeof ev.inputTokens === 'number' ? { inputTokens: ev.inputTokens } : {}),
          ...(typeof ev.outputTokens === 'number' ? { outputTokens: ev.outputTokens } : {})
        })
        break
      }
      case 'context_usage': {
        rows.push({
          at,
          step: lastStep,
          kind: 'context_usage',
          ...(typeof ev.estimatedTokens === 'number'
            ? { estimatedTokens: ev.estimatedTokens }
            : {}),
          ...(typeof ev.overflow === 'boolean' ? { overflow: ev.overflow } : {})
        })
        break
      }
      case 'compaction_started': {
        rows.push({
          at,
          step: lastStep,
          kind: 'compaction_started',
          ...(typeof ev.mode === 'string' ? { mode: ev.mode } : {})
        })
        break
      }
      case 'compaction_verifying': {
        rows.push({
          at,
          step: lastStep,
          kind: 'compaction_verifying',
          ...(typeof ev.summary === 'string' ? { summary: clip(ev.summary) } : {})
        })
        break
      }
      case 'compaction_verify_retry': {
        rows.push({
          at,
          step: lastStep,
          kind: 'compaction_verify_retry',
          ...(typeof ev.summary === 'string' ? { summary: clip(ev.summary) } : {})
        })
        break
      }
      case 'compaction_verify_failed': {
        rows.push({
          at,
          step: lastStep,
          kind: 'compaction_verify_failed',
          ...(typeof ev.summary === 'string' ? { summary: clip(ev.summary) } : {})
        })
        break
      }
      case 'compaction': {
        rows.push({
          at,
          step: lastStep,
          kind: 'compaction',
          ...(typeof ev.summary === 'string' ? { summary: clip(ev.summary) } : {})
        })
        break
      }
      case 'incomplete': {
        rows.push({
          at,
          step: typeof ev.step === 'number' ? ev.step : lastStep,
          kind: 'incomplete',
          ...(typeof ev.reason === 'string' ? { reason: ev.reason } : {}),
          ...(typeof ev.message === 'string' ? { summary: clip(ev.message) } : {})
        })
        break
      }
      case 'status': {
        rows.push({
          at,
          step: lastStep,
          kind: 'status',
          ...(typeof ev.status === 'string' ? { status: ev.status } : {})
        })
        break
      }
      case 'tool_progress': {
        rows.push({
          at,
          step: lastStep,
          kind: 'tool_progress',
          ...(typeof ev.parentToolCallId === 'string'
            ? { parentToolCallId: ev.parentToolCallId }
            : {}),
          ...(typeof ev.kind === 'string' ? { progressKind: ev.kind } : {}),
          ...(typeof ev.text === 'string' ? { summary: clip(ev.text) } : {})
        })
        break
      }
      case 'mode_changed': {
        rows.push({
          at,
          step: lastStep,
          kind: 'mode_changed',
          ...(typeof ev.mode === 'string' ? { mode: ev.mode } : {})
        })
        break
      }
      case 'follow_up_queued':
      case 'follow_up_applied':
      case 'follow_up_dropped': {
        rows.push({
          at,
          step: lastStep,
          kind:
            ev.type === 'follow_up_queued'
              ? 'follow_up_queued'
              : ev.type === 'follow_up_applied'
                ? 'follow_up_applied'
                : 'follow_up_dropped'
        })
        break
      }
      case 'writes_checkpoint': {
        const files = Array.isArray(ev.files) ? ev.files.length : 0
        rows.push({
          at,
          step: lastStep,
          kind: 'writes_checkpoint',
          ...(files > 0 ? { fileCount: files } : {})
        })
        break
      }
      case 'stream_reset': {
        rows.push({
          at,
          step: typeof ev.step === 'number' ? ev.step : lastStep,
          kind: 'stream_reset'
        })
        break
      }
      default:
        break
    }
  }

  return rows
}

export function writeTrajectoryJsonl(runDir: string, rows: readonly TrajectoryRow[]): void {
  if (!existsSync(runDir)) mkdirSync(runDir, { recursive: true })
  const body = rows.map((r) => JSON.stringify(r)).join('\n')
  writeFileSync(join(runDir, TRAJECTORY_FILENAME), body ? `${body}\n` : '', 'utf8')
}

/**
 * Observational prediction manifest from receipt heuristics.
 * Never applied to harness sections — `observed_only` always true.
 */
export function buildPredictionManifest(
  runId: string,
  receipt: Pick<
    RunReceipt,
    | 'unreadEditPaths'
    | 'failureClusters'
    | 'compactionCount'
    | 'toolStats'
  >,
  writtenAt = new Date().toISOString()
): PredictionManifest {
  const predictions: PredictionManifest['predictions'] = []

  if (receipt.unreadEditPaths.length > 0) {
    predictions.push({
      at: writtenAt,
      type: 'harness_section',
      target: 'work_style',
      bucket: 'loop_notices',
      confidence: 0,
      observed_only: true,
      reason: `${receipt.unreadEditPaths.length} unread-before-edit path(s)`
    })
  }
  if (receipt.failureClusters.length > 0) {
    predictions.push({
      at: writtenAt,
      type: 'harness_section',
      target: 'tool_policy',
      bucket: 'tool_policy',
      confidence: 0,
      observed_only: true,
      reason: receipt.failureClusters[0]
        ? `Top failure: ${receipt.failureClusters[0].key}`
        : 'Consecutive tool-failure streak ≥ 3'
    })
  }
  if (receipt.compactionCount >= 2) {
    predictions.push({
      at: writtenAt,
      type: 'harness_section',
      target: 'memory',
      bucket: 'memory',
      confidence: 0,
      observed_only: true,
      reason: `compactionCount=${receipt.compactionCount}`
    })
  }
  const memoryFails = receipt.toolStats.byName['memory_write']?.failed ?? 0
  if (memoryFails > 0) {
    predictions.push({
      at: writtenAt,
      type: 'harness_section',
      target: 'memory',
      bucket: 'memory',
      confidence: 0,
      observed_only: true,
      reason: `memory_write failed ${memoryFails}×`
    })
  }

  return PredictionManifestSchema.parse({
    version: PREDICTION_MANIFEST_VERSION,
    runId,
    writtenAt,
    observed_only: true,
    predictions
  })
}

export function writePredictionManifest(runDir: string, manifest: PredictionManifest): void {
  atomicWriteJson(join(runDir, PREDICTION_FILENAME), manifest)
}

/** Best-effort: write trajectory.jsonl + prediction.json beside receipt. Never throws. */
export function writeTrajectoryArtifactsBestEffort(input: {
  runDir: string
  runId: string
  loadEvents: (dir: string) => PersistedEvent[]
  /** When provided, also write prediction.json from receipt heuristics. */
  receipt?: RunReceipt | null
}): void {
  try {
    const events = input.loadEvents(input.runDir)
    const rows = buildTrajectoryFromEvents(events, { runId: input.runId })
    writeTrajectoryJsonl(input.runDir, rows)
  } catch (err) {
    logger.warn('Failed to write trajectory.jsonl', {
      scope: 'agent',
      correlationId: input.runId,
      err
    })
  }

  if (!input.receipt) return
  try {
    const manifest = buildPredictionManifest(input.runId, input.receipt)
    writePredictionManifest(input.runDir, manifest)
  } catch (err) {
    logger.warn('Failed to write prediction.json', {
      scope: 'agent',
      correlationId: input.runId,
      err
    })
  }
}

export function trajectoryArtifactExists(runDir: string): boolean {
  return existsSync(join(runDir, TRAJECTORY_FILENAME))
}

export function predictionArtifactExists(runDir: string): boolean {
  return existsSync(join(runDir, PREDICTION_FILENAME))
}
