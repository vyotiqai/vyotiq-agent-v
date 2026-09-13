/**
 * Always-on Chromium trace flight recorder (chrome://tracing JSON).
 *
 * ON by default, fully automatic — no manual recording workflow exists:
 *  - `ensureRecording()` starts a `record-continuously` ring buffer (bounded
 *    memory, no disk I/O until a dump) and is re-asserted after every dump.
 *  - `dumpNow(reason)` flushes the buffer to {userData}/traces/ and resumes
 *    recording. Manual dumps (IPC) force through; automatic dumps dedupe via
 *    a 30s cool-down so crash/hang trigger storms cannot thrash the disk.
 *  - Triggers are wired in traceAutoCapture.ts: renderer/child crashes,
 *    renderer unresponsive, uncaughtException/unhandledRejection.
 *
 * Performance reconciliation (STRICT perf rule): `record-continuously` is the
 * official Chromium/Electron pattern for always-on tracing — cost is a bounded
 * in-memory ring buffer with a narrow category set; nothing polls, nothing
 * writes to disk until a real problem signal fires. Measured on this machine:
 * see references/telemetry-runbook.md in the vyotiq-agent-v skill.
 */
import { join } from 'path'
import { readdir, stat, unlink } from 'fs/promises'
import { statSync } from 'fs'
import { logger } from '../../shared/logger'

export const TRACE_INCLUDED_CATEGORIES = [
  'devtools.timeline',
  'v8',
  'blink',
  'disabled-by-default-devtools.timeline.frame'
]

/** Continuous TraceConfig: ring buffer, PII argument filter, narrow categories. */
export const FLIGHT_RECORDER_CONFIG: Electron.TraceConfig = {
  included_categories: [...TRACE_INCLUDED_CATEGORIES],
  recording_mode: 'record-continuously',
  enable_argument_filter: true,
  // Bounded memory for an always-on recorder: 16MB (default is 100MB).
  trace_buffer_size_in_kb: 16_384
}

type ContentTracingLike = {
  startRecording: (
    options: Electron.TraceCategoriesAndOptions | Electron.TraceConfig
  ) => Promise<void>
  stopRecording: (resultFilePath?: string) => Promise<string>
  getTraceBufferUsage: () => Promise<{ value: number; percentage: number }>
}

export type TraceStartResult = { categoryFilter: string; traceOptions: string }
export type TraceStopResult = { path: string; bytes: number; durationMs: number }
export type TraceStatusResult = {
  recording: boolean
  startedAt: string | null
  bufferPercent: number | null
}

export type TraceDumpReason =
  | 'manual'
  | 'renderer-crash'
  | 'child-process-crash'
  | 'renderer-unresponsive'
  | 'uncaught-exception'
  | 'unhandled-rejection'

const AUTO_DUMP_COOLDOWN_MS = 30_000
const TRACE_RETENTION = 10

export type TraceCapture = ReturnType<typeof createTraceCapture>

export function createTraceCapture(
  contentTracing: ContentTracingLike,
  resolveTraceDir: () => string,
  now: () => number = Date.now
): {
  ensureRecording: () => Promise<TraceStartResult>
  status: () => Promise<TraceStatusResult>
  dumpNow: (reason: TraceDumpReason) => Promise<TraceStopResult>
} {
  let recording = false
  let startedAtMs: number | null = null
  let lastAutoDumpAtMs = 0
  // Serialize dumps: concurrent triggers chain instead of racing stopRecording.
  let dumpChain: Promise<unknown> = Promise.resolve()

  async function startBuffer(): Promise<TraceStartResult> {
    await contentTracing.startRecording({
      ...FLIGHT_RECORDER_CONFIG,
      included_categories: [...TRACE_INCLUDED_CATEGORIES]
    })
    recording = true
    startedAtMs = now()
    return {
      categoryFilter: TRACE_INCLUDED_CATEGORIES.join(','),
      traceOptions: 'record-continuously'
    }
  }

  async function pruneRetention(): Promise<number> {
    try {
      const dir = resolveTraceDir()
      const names = (await readdir(dir)).filter((n) => /^trace-.*\.json$/.test(n))
      if (names.length <= TRACE_RETENTION) return 0
      const dated = await Promise.all(
        names.map(async (name) => {
          try {
            return { name, ms: (await stat(join(dir, name))).mtimeMs }
          } catch {
            return { name, ms: 0 }
          }
        })
      )
      dated.sort((a, b) => b.ms - a.ms)
      const excess = dated.slice(TRACE_RETENTION)
      for (const entry of excess) {
        try {
          await unlink(join(dir, entry.name))
        } catch {
          // best-effort retention
        }
      }
      return excess.length
    } catch {
      return 0
    }
  }

  return {
    /** Idempotent: starts the ring buffer once; safe to call again at any time. */
    async ensureRecording(): Promise<TraceStartResult> {
      if (recording) {
        return {
          categoryFilter: TRACE_INCLUDED_CATEGORIES.join(','),
          traceOptions: 'record-continuously'
        }
      }
      const result = await startBuffer()
      logger.info('Trace flight recorder started', {
        scope: 'perf',
        kind: 'trace',
        action: 'start'
      })
      return result
    },

    async status(): Promise<TraceStatusResult> {
      let bufferPercent: number | null = null
      if (recording) {
        try {
          bufferPercent = (await contentTracing.getTraceBufferUsage()).percentage
        } catch {
          bufferPercent = null
        }
      }
      return {
        recording,
        startedAt:
          recording && startedAtMs != null ? new Date(startedAtMs).toISOString() : null,
        bufferPercent
      }
    },

    /**
     * Flush the ring buffer to disk and resume recording. Never throws
     * "no recording" — if the buffer is somehow down it is restarted first,
     * so a dump always produces a file. Auto dumps inside the cool-down are
     * skipped (logged); manual dumps always force through.
     */
    async dumpNow(reason: TraceDumpReason): Promise<TraceStopResult> {
      const force = reason === 'manual'
      if (!force && now() - lastAutoDumpAtMs < AUTO_DUMP_COOLDOWN_MS) {
        logger.info('Trace dump skipped (cool-down)', {
          scope: 'perf',
          kind: 'trace',
          action: 'skip',
          reason
        })
        // Return the previous state honestly: nothing was dumped. The last
        // manual result is unknown here, so surface a skipped marker via the
        // in-flight chain instead of fabricating a path.
        return dumpChain.then(() => {
          throw new Error(`Trace dump skipped (${reason}) — cool-down active`)
        })
      }
      const run = dumpChain.then(async () => {
        if (!recording) await startBuffer()
        const elapsed = startedAtMs != null ? now() - startedAtMs : 0
        const dir = resolveTraceDir()
        const path = join(
          dir,
          `trace-${reason}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
        )
        // Clear before awaiting so status() can't report a stale recording.
        recording = false
        startedAtMs = null
        const written = await contentTracing.stopRecording(path)
        const bytes = (() => {
          try {
            return statSync(written).size
          } catch {
            return 0
          }
        })()
        // Any completed dump (manual or auto) arms the auto-dump cool-down.
        lastAutoDumpAtMs = now()
        logger.info('Trace flight recorder dumped', {
          scope: 'perf',
          kind: 'trace',
          action: 'dump',
          reason,
          count: bytes
        })
        // Resume immediately — the recorder must never stay down.
        try {
          await startBuffer()
          logger.info('Trace flight recorder resumed', {
            scope: 'perf',
            kind: 'trace',
            action: 'resume'
          })
        } catch (err) {
          logger.warn('Trace flight recorder failed to resume', {
            scope: 'perf',
            kind: 'trace',
            err
          })
        }
        void pruneRetention()
        return { path: written, bytes, durationMs: Math.max(0, elapsed) }
      })
      // Keep the chain alive even when a dump fails, and surface the error
      // only to this caller.
      dumpChain = run.catch(() => undefined)
      return run
    }
  }
}
