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

/** Wire shared logger to electron-log/renderer (IPC → main disk). */
export async function initRendererLogging(): Promise<void> {
  // electron-log/renderer can hang indefinitely when the main bridge is busy
  // (seen with Network Service child crashes + DevTools). Fail open so UI boots.
  const mod = (await Promise.race([
    import('electron-log/renderer'),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('electron-log/renderer import timed out')), 2000)
    )
  ])) as { default: ElectronLogRenderer }
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
