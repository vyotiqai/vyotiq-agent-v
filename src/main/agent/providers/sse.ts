/** Iterate SSE `data:` payloads from a fetch Response body. */
import { isAbortError } from '../../../shared/errors'
import { closeUnterminatedJson, completeJsonPrefix } from '../../../shared/utils/jsonish'
import { isRetriableNetworkError, RetriableStreamError } from './fetchWithRetry'
import { logProviderFailure } from './log'

/**
 * Abort if the body delivers no bytes for this long.
 * Sized for slow reasoning TTFT (e.g. OpenRouter Luna Pro multi-minute silence)
 * while still cutting truly hung sockets. OpenRouter `: keepalive` comments reset
 * the timer because they arrive as bytes on the reader.
 */
export const STREAM_IDLE_TIMEOUT_MS = 10 * 60 * 1000

/**
 * Hard cap on a single un-terminated SSE line. A well-behaved provider sends
 * small `data:` frames; a proxy error page or corrupted stream delivered as one
 * giant line would otherwise grow `buffer` without bound and can OOM the main
 * process in one allocation. Exceeding this is terminal (retrying re-delivers
 * the same bytes), so it fails fast with a clear message.
 */
export const SSE_MAX_LINE_CHARS = 32 * 1024 * 1024
/** Hard cap on one logical frame joined from multiple `data:` lines. */
export const SSE_MAX_FRAME_CHARS = 64 * 1024 * 1024

export class SseFrameTooLargeError extends Error {
  readonly limitChars: number

  constructor(limitChars: number, kind: 'line' | 'frame') {
    super(
      `Provider stream ${kind} exceeded ${Math.round(limitChars / (1024 * 1024))} MB — ` +
        'the upstream response is corrupt or not an SSE stream'
    )
    this.name = 'SseFrameTooLargeError'
    this.limitChars = limitChars
  }
}

export class StreamIdleTimeoutError extends Error {
  readonly idleMs: number

  constructor(idleMs: number) {
    super(
      `Provider stream idle for ${Math.round(idleMs / 1000)}s with no data (including keep-alives)`
    )
    this.name = 'StreamIdleTimeoutError'
    this.idleMs = idleMs
  }
}

export function isStreamIdleTimeoutError(err: unknown): err is StreamIdleTimeoutError {
  return err instanceof StreamIdleTimeoutError
}

export type IterateSseOptions = {
  /**
   * Idle watchdog threshold. Default {@link STREAM_IDLE_TIMEOUT_MS}.
   * Pass `0` to disable (tests / explicit opt-out only).
   */
  idleTimeoutMs?: number
  /** Override the unterminated-line cap (tests). Default {@link SSE_MAX_LINE_CHARS}. */
  maxLineChars?: number
  /** Override the joined-frame cap (tests). Default {@link SSE_MAX_FRAME_CHARS}. */
  maxFrameChars?: number
}

/**
 * Race one body read against the idle deadline. Any resolved chunk (including
 * SSE comment lines) resets the caller’s next deadline.
 */
function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleTimeoutMs: number,
  signal: AbortSignal
): Promise<Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>> {
  if (idleTimeoutMs <= 0) {
    if (signal.aborted) {
      return Promise.reject(new DOMException('Aborted', 'AbortError'))
    }
    return reader.read()
  }

  return new Promise((resolve, reject) => {
    let settled = false

    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      fn()
    }

    const timer = setTimeout(() => {
      settle(() => {
        void reader.cancel().catch(() => undefined)
        logProviderFailure('sse', 'timeout', {
          message: `idle ${Math.round(idleTimeoutMs / 1000)}s`
        })
        reject(new StreamIdleTimeoutError(idleTimeoutMs))
      })
    }, idleTimeoutMs)

    const onAbort = (): void => {
      settle(() => {
        void reader.cancel().catch(() => undefined)
        reject(new DOMException('Aborted', 'AbortError'))
      })
    }

    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })

    reader.read().then(
      (result) => settle(() => resolve(result)),
      (err) => settle(() => reject(err))
    )
  })
}

export async function* iterateSseData(
  res: Response,
  signal: AbortSignal,
  opts?: IterateSseOptions
): AsyncGenerator<string> {
  if (!res.body) {
    logProviderFailure('sse', 'stream', {})
    throw new Error('No response body')
  }
  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  const maxLineChars = opts?.maxLineChars ?? SSE_MAX_LINE_CHARS
  const maxFrameChars = opts?.maxFrameChars ?? SSE_MAX_FRAME_CHARS
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let dataLines: string[] = []
  let frameChars = 0

  const flush = (): string | null => {
    if (dataLines.length === 0) return null
    const data = dataLines.join('\n')
    dataLines = []
    frameChars = 0
    return data
  }

  let finished = false
  try {
    while (true) {
      if (signal.aborted) {
        await reader.cancel().catch(() => undefined)
        throw new DOMException('Aborted', 'AbortError')
      }
      let readResult: Awaited<ReturnType<typeof reader.read>>
      try {
        readResult = await readWithIdleTimeout(reader, idleTimeoutMs, signal)
      } catch (readErr) {
        if (isAbortError(readErr) || isStreamIdleTimeoutError(readErr)) throw readErr
        if (isRetriableNetworkError(readErr)) {
          throw new RetriableStreamError(formatStreamReadError(readErr), readErr)
        }
        throw readErr
      }
      const { done, value } = readResult
      if (done) {
        finished = true
        break
      }

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n')
      buffer = parts.pop() ?? ''
      // A provider that never sends a newline would grow this tail without
      // bound; complete lines are processed below (and frame-capped by bytes).
      if (buffer.length > maxLineChars) {
        throw new SseFrameTooLargeError(maxLineChars, 'line')
      }

      for (const raw of parts) {
        const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
        if (line === '') {
          const data = flush()
          if (data === null) continue
          // Trim: hosts send `data: [DONE]` with trailing whitespace/CR
          // variants; an un-trimmed compare fell through to JSON.parse and
          // counted the terminator as a dropped frame.
          if (data.trim() === '[DONE]') return
          yield data
          continue
        }
        if (line.startsWith(':')) continue
        if (line.startsWith('data:')) {
          const v = line.slice(5)
          frameChars += v.length
          if (frameChars > maxFrameChars) {
            throw new SseFrameTooLargeError(maxFrameChars, 'frame')
          }
          dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
        }
      }
    }

    if (buffer.length) {
      if (buffer.length > maxLineChars) {
        throw new SseFrameTooLargeError(maxLineChars, 'line')
      }
      const line = buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer
      if (line.startsWith('data:')) {
        const v = line.slice(5)
        frameChars += v.length
        if (frameChars > maxFrameChars) {
          throw new SseFrameTooLargeError(maxFrameChars, 'frame')
        }
        dataLines.push(v.startsWith(' ') ? v.slice(1) : v)
      }
    }

    const data = flush()
    if (data !== null && data.trim() !== '[DONE]') yield data
  } finally {
    if (!finished) {
      await reader.cancel().catch(() => undefined)
    }
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

function formatStreamReadError(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Counts frames a stream had to discard. Silently swallowing them turns a
 * corrupted stream into a plausible-looking short answer, so callers surface
 * the count once the stream ends.
 */
export type SseDropCounter = { dropped: number }

/**
 * Recover a corrupted frame when the failure is a known, safe class: a complete
 * value followed by junk (`{…}{…}` / proxy garbage) or a stream cut after a
 * complete value with containers still open (missing `]`/`}` — hosts that flush
 * early). Truncation inside a string never parses as complete, so it is not
 * fabricated content. The remainder after a recovered prefix is returned so the
 * caller can account for it — it used to be discarded silently, which turned a
 * corrupted stream into a plausible-looking short answer with no drop count.
 */
function salvageSseJson(
  text: string
): { value: Record<string, unknown>; remainder: string } | undefined {
  if (text[0] !== '{' && text[0] !== '[') return undefined
  const prefix = completeJsonPrefix(text)
  if (prefix) {
    try {
      const parsed = JSON.parse(prefix) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed as Record<string, unknown>, remainder: text.slice(prefix.length).trim() }
      }
    } catch {
      // fall through to the unterminated candidate
    }
  }
  const closed = closeUnterminatedJson(text)
  if (closed) {
    try {
      const parsed = JSON.parse(closed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { value: parsed as Record<string, unknown>, remainder: '' }
      }
    } catch {
      // unsalvageable
    }
  }
  return undefined
}

export async function* iterateSseJson(
  res: Response,
  signal: AbortSignal,
  drops?: SseDropCounter,
  opts?: IterateSseOptions
): AsyncGenerator<Record<string, unknown>> {
  for await (const data of iterateSseData(res, signal, opts)) {
    const text = data.trim()
    if (!text) continue
    try {
      yield JSON.parse(text) as Record<string, unknown>
      continue
    } catch {
      // salvage below
    }
    const salvaged = salvageSseJson(text)
    if (salvaged) {
      logProviderFailure('sse', 'parse', { bytes: text.length, message: 'frame salvaged' })
      yield salvaged.value
      const rest = salvaged.remainder
      if (rest) {
        try {
          const second = JSON.parse(rest) as unknown
          if (second && typeof second === 'object' && !Array.isArray(second)) {
            yield second as Record<string, unknown>
            continue
          }
        } catch {
          // remainder is not a complete frame — count it below
        }
        if (drops) drops.dropped++
        logProviderFailure('sse', 'parse', {
          bytes: rest.length,
          message: 'salvage remainder dropped'
        })
      }
      continue
    }
    if (drops) drops.dropped++
    logProviderFailure('sse', 'parse', { bytes: text.length })
  }
}
