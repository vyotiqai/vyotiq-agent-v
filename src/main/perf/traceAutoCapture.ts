/**
 * Automatic trace flight-recorder wiring. Perf-gated (VYOTIQ_PERF=1 starts the
 * ring at boot); otherwise triggers-only:
 *  - VYOTIQ_PERF=1 boot: starts the record-continuously ring buffer (traceCapture).
 *  - Always (unless VYOTIQ_TRACE_OFF=1): renderer crash (non-killed/clean),
 *    child-process crash (non-clean), renderer unresponsive (attached per
 *    webContents via browser-window-created), uncaughtException/unhandledRejection → dump the
 *    buffer to {userData}/traces/ and resume recording (30s auto
 *    cool-down dedupes trigger storms; manual IPC dumps always force).
 *    dumpNow() starts a buffer on demand, so triggers-only mode still yields
 *    a trace file for a real crash (post-trigger events only).
 *
 * Reliability note (honest): renderer-crash / child-crash / unresponsive
 * dumps are fully reliable because main survives. uncaughtException and
 * unhandledRejection are FATAL in this app (logging/init exits after a
 * 250ms flush) — those dumps are best-effort: this module registers its
 * process listener FIRST (initTraceAutoCapture runs before initMainLogging)
 * so the dump gets the full flush window, but a huge buffer can still lose
 * the tail. Crashpad minidumps + vyotiq.log remain the primary fatal-path
 * artifacts; the trace is a bonus when it lands.
 */
import { mkdirSync } from 'fs'
import { join } from 'path'
import { logger } from '../../shared/logger'
import {
  createTraceCapture,
  type TraceCapture,
  type TraceDumpReason
} from './traceCapture'

type CrashDetailsLike = { reason: string }
type ChildDetailsLike = { reason: string }

type AppLike = {
  on: (event: string, listener: (...args: never[]) => void) => unknown
  getPath: (name: 'userData') => string
}

export type TraceAutoCapture = {
  /** Idempotent boot: start the ring buffer + attach crash/hang triggers. */
  init: () => void
  /**
   * Idempotent boot variant: attach crash/hang triggers without starting the
   * always-on ring buffer (perf-gated default). dumpNow() starts a buffer on
   * demand, so a crash still yields a trace file.
   */
  initTriggersOnly: () => void
  capture: TraceCapture
}

export function createTraceAutoCapture(
  contentTracing: Parameters<typeof createTraceCapture>[0],
  app: AppLike,
  proc: Pick<NodeJS.Process, 'on'>
): TraceAutoCapture {
  const capture = createTraceCapture(contentTracing, () => {
    // Traces live in {userData}/traces/ (same volume as logs, never the
    // workspace) — mkdir here so dump paths always resolve.
    const dir = join(app.getPath('userData'), 'traces')
    mkdirSync(dir, { recursive: true })
    return dir
  })
  let initialized = false

  const dump = (reason: TraceDumpReason): void => {
    void capture.dumpNow(reason).catch((err: unknown) => {
      // Cool-down skips and fs failures must never surface as unhandled.
      logger.warn('Automatic trace dump did not run', {
        scope: 'perf',
        kind: 'trace',
        reason,
        err
      })
    })
  }

  const attachTriggers = (): void => {
    app.on('render-process-gone', ((_event: unknown, _wc: unknown, details: CrashDetailsLike) => {
      if (details.reason === 'killed' || details.reason === 'clean-exit') return
      dump('renderer-crash')
    }) as never)

    app.on('child-process-gone', ((_event: unknown, details: ChildDetailsLike) => {
      if (details.reason === 'clean-exit' || details.reason === 'killed') return
      dump('child-process-crash')
    }) as never)

    app.on('browser-window-created', ((_event: unknown, win: { webContents: { on: (event: string, listener: () => void) => void; isDestroyed: () => boolean } }) => {
      win.webContents.on('unresponsive', () => {
        if (win.webContents.isDestroyed()) return
        dump('renderer-unresponsive')
      })
    }) as never)

    // Register BEFORE logging/init's fatal handler so the dump starts
    // inside the 250ms pre-exit flush window (best-effort — see header).
    proc.on('uncaughtException', (() => {
      dump('uncaught-exception')
    }) as never)
    proc.on('unhandledRejection', (() => {
      dump('unhandled-rejection')
    }) as never)
  }

  return {
    capture,
    init(): void {
      if (initialized) return
      initialized = true

      void capture
        .ensureRecording()
        .then(() => {
          logger.info('Trace flight recorder active (automatic)', {
            scope: 'perf',
            kind: 'trace'
          })
        })
        .catch((err: unknown) => {
          logger.warn('Trace flight recorder failed to start', {
            scope: 'perf',
            kind: 'trace',
            err
          })
        })

      attachTriggers()
    },
    initTriggersOnly(): void {
      if (initialized) return
      initialized = true
      logger.info('Trace flight recorder triggers-only (ring starts on first dump)', {
        scope: 'perf',
        kind: 'trace'
      })
      attachTriggers()
    }
  }
}

let instance: TraceAutoCapture | null = null

/**
 * Process-wide singleton accessor. Creates + initializes on first call.
 * Called at boot (main/index.ts, before initMainLogging so fatal-path dump
 * listeners register first) and lazily from IPC handlers.
 */
export function getTraceAutoCapture(): TraceAutoCapture {
  if (!instance) {
    // Lazy require keeps unit tests that import this module off Electron.
    const electron = require('electron') as { app: AppLike; contentTracing: Parameters<typeof createTraceCapture>[0] }
    instance = createTraceAutoCapture(electron.contentTracing, electron.app, process)
  }
  return instance
}

/**
 * Boot hook. Off by default: an always-on trace ring is continuous idle cost
 * (STRICT perf rule), so the ring buffer only auto-starts under VYOTIQ_PERF=1
 * (measurement mode). VYOTIQ_TRACE_OFF=1 hard-disables everything, including
 * crash-triggered dumps. With both vars unset the crash/hang triggers stay
 * wired — dumpNow() restarts the buffer on demand, so a crash still produces
 * a trace file (post-trigger events; pre-crash events need VYOTIQ_PERF=1).
 */
export function initTraceAutoCapture(): void {
  if (process.env.VYOTIQ_TRACE_OFF === '1') {
    logger.info('Trace flight recorder disabled (VYOTIQ_TRACE_OFF=1)', {
      scope: 'perf',
      kind: 'trace'
    })
    return
  }
  instance ??= getTraceAutoCapture()
  if (process.env.VYOTIQ_PERF === '1') {
    instance.init()
    return
  }
  // Perf-gated: register only the crash/hang dump triggers (they self-start
  // the buffer inside dumpNow when a real problem signal fires). No ring at
  // boot — steady-state cost stays zero until something goes wrong.
  instance.initTriggersOnly()
}

/** @internal */
export function resetTraceAutoCaptureForTests(): void {
  instance = null
}
