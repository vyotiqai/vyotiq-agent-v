import type { LogFields, LogLevel, LoggerBackend } from '../../../shared/logger'
import { setLoggerBackend } from '../../../shared/logger'

type ElectronLogRenderer = {
  transports: { console: { level: string } }
  debug: (...args: unknown[]) => void
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

function mapLevel(level: LogLevel): keyof Pick<ElectronLogRenderer, 'debug' | 'info' | 'warn' | 'error'> {
  if (level === 'fatal') return 'error'
  return level
}

let captureFn: ((err: unknown, fields?: LogFields) => void) | undefined

export function setRendererCaptureException(
  fn: ((err: unknown, fields?: LogFields) => void) | undefined
): void {
  captureFn = fn
}

/** Wire shared logger to electron-log/renderer (renderer console transport). */
export async function initRendererLogging(): Promise<void> {
  // electron-log/renderer can hang indefinitely when the main bridge is busy
  // (seen with Network Service child crashes + DevTools, or a cold dev
  // prebundle). Fail open so UI boots — but retry the import a few times first,
  // otherwise logging is lost for the whole session after one busy-bridge hit.
  const mod = await importElectronLogWithRetries([2000, 5000, 10000])
  const log = mod.default
  log.transports.console.level = import.meta.env.DEV ? 'debug' : 'warn'

  const backend: LoggerBackend = {
    log: (level, message, fields) => {
      // Fields arrive pre-sanitized by the shared logger facade (allowlist +
      // message scrub) — forward them like the main backend does, err included.
      const scope = fields?.scope ? `[${fields.scope}] ` : ''
      const cid = fields?.correlationId ? `{${fields.correlationId}} ` : ''
      const { scope: _s, correlationId: _c, ...rest } = fields ?? {}
      const meta = Object.keys(rest).length ? (rest as LogFields) : undefined
      const line = `${scope}${cid}${message}`
      const fn = log[mapLevel(level)].bind(log)
      if (meta) fn(line, meta)
      else fn(line)
    },
    captureException: (err, fields) => {
      captureFn?.(err, fields)
    }
  }
  setLoggerBackend(backend)
}

/**
 * Race the electron-log/renderer import against escalating timeouts and retry
 * on a timer. The pending dynamic import keeps loading after a timeout, so
 * later attempts typically resolve fast once the bridge frees up.
 */
async function importElectronLogWithRetries(
  timeoutsMs: readonly number[]
): Promise<{ default: ElectronLogRenderer }> {
  for (let attempt = 0; ; attempt++) {
    const isLast = attempt === timeoutsMs.length - 1
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const promise = import('electron-log/renderer')
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('electron-log/renderer import timed out')),
          timeoutsMs[attempt]
        )
      })
      try {
        return (await Promise.race([promise, guard])) as { default: ElectronLogRenderer }
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      if (isLast) throw err
      void err
      await new Promise<void>((resolve) => setTimeout(resolve, 1000))
    }
  }
}
