import { crc32 } from 'zlib'
import { isAbortError } from '../../../../shared/errors'
import { isRetriableNetworkError, RetriableStreamError } from '../fetchWithRetry'
import { isStreamIdleTimeoutError, readWithIdleTimeout, STREAM_IDLE_TIMEOUT_MS } from '../sse'

/**
 * Decoder for AWS's `application/vnd.amazon.eventstream` framing, which
 * Bedrock's streaming APIs use instead of SSE. Each message is:
 *
 *   total length (u32) · headers length (u32) · prelude CRC32 (u32)
 *   headers · payload · message CRC32 (u32)
 *
 * Both checksums are verified: a corrupted frame is an error, never a guess.
 */

export type EventStreamHeaderValue = string | number | boolean | bigint | Uint8Array | Date

export type EventStreamMessage = {
  headers: Record<string, EventStreamHeaderValue>
  payload: Uint8Array
}

/** A Bedrock frame is small; anything past this is a broken or hostile stream. */
export const EVENT_STREAM_MAX_MESSAGE_BYTES = 16 * 1024 * 1024

const PRELUDE_BYTES = 12
const MIN_MESSAGE_BYTES = PRELUDE_BYTES + 4

export class EventStreamDecodeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EventStreamDecodeError'
  }
}

function decodeHeaders(view: DataView, bytes: Uint8Array, start: number, end: number) {
  const headers: Record<string, EventStreamHeaderValue> = {}
  const text = new TextDecoder()
  let at = start
  const need = (n: number) => {
    if (at + n > end) throw new EventStreamDecodeError('Event stream header runs past its section')
  }
  while (at < end) {
    need(1)
    const nameLen = view.getUint8(at)
    at += 1
    need(nameLen + 1)
    const name = text.decode(bytes.subarray(at, at + nameLen))
    at += nameLen
    const type = view.getUint8(at)
    at += 1
    let value: EventStreamHeaderValue
    switch (type) {
      case 0:
        value = true
        break
      case 1:
        value = false
        break
      case 2:
        need(1)
        value = view.getInt8(at)
        at += 1
        break
      case 3:
        need(2)
        value = view.getInt16(at)
        at += 2
        break
      case 4:
        need(4)
        value = view.getInt32(at)
        at += 4
        break
      case 5:
        need(8)
        value = view.getBigInt64(at)
        at += 8
        break
      case 6:
      case 7: {
        need(2)
        const len = view.getUint16(at)
        at += 2
        need(len)
        const raw = bytes.subarray(at, at + len)
        value = type === 7 ? text.decode(raw) : raw.slice()
        at += len
        break
      }
      case 8:
        need(8)
        value = new Date(Number(view.getBigInt64(at)))
        at += 8
        break
      case 9:
        need(16)
        value = bytes.slice(at, at + 16)
        at += 16
        break
      default:
        throw new EventStreamDecodeError(`Unknown event stream header type ${type}`)
    }
    headers[name] = value
  }
  return headers
}

/** Decode one complete message (exactly `total length` bytes). */
export function decodeEventStreamMessage(bytes: Uint8Array): EventStreamMessage {
  if (bytes.length < MIN_MESSAGE_BYTES) {
    throw new EventStreamDecodeError('Event stream message is shorter than its prelude')
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const total = view.getUint32(0)
  const headersLen = view.getUint32(4)
  if (total !== bytes.length) {
    throw new EventStreamDecodeError('Event stream message length does not match its prelude')
  }
  if (crc32(bytes.subarray(0, 8)) !== view.getUint32(8)) {
    throw new EventStreamDecodeError('Event stream prelude checksum mismatch')
  }
  if (crc32(bytes.subarray(0, total - 4)) !== view.getUint32(total - 4)) {
    throw new EventStreamDecodeError('Event stream message checksum mismatch')
  }
  const headersEnd = PRELUDE_BYTES + headersLen
  if (headersEnd > total - 4) {
    throw new EventStreamDecodeError('Event stream headers run past the message')
  }
  return {
    headers: decodeHeaders(view, bytes, PRELUDE_BYTES, headersEnd),
    payload: bytes.slice(headersEnd, total - 4)
  }
}

/**
 * Yield each message of an event stream body as its bytes arrive, with the
 * same idle deadline and retriable-read semantics as the SSE reader. Stops when
 * the body ends; a trailing partial message is an error (the connection was cut
 * mid-frame).
 */
export async function* iterateEventStream(
  res: Response,
  signal: AbortSignal,
  opts?: { idleTimeoutMs?: number }
): AsyncGenerator<EventStreamMessage> {
  if (!res.body) throw new Error('No response body')
  const idleTimeoutMs = opts?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
  const reader = res.body.getReader()
  let buffer = new Uint8Array(0)
  let finished = false
  try {
    for (;;) {
      while (buffer.length >= PRELUDE_BYTES) {
        const total = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
        if (total < MIN_MESSAGE_BYTES || total > EVENT_STREAM_MAX_MESSAGE_BYTES) {
          throw new EventStreamDecodeError(`Event stream message size ${total} is out of range`)
        }
        if (buffer.length < total) break
        yield decodeEventStreamMessage(buffer.subarray(0, total))
        buffer = buffer.subarray(total)
      }
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      let read: Awaited<ReturnType<typeof reader.read>>
      try {
        read = await readWithIdleTimeout(reader, idleTimeoutMs, signal)
      } catch (err) {
        if (isAbortError(err) || isStreamIdleTimeoutError(err)) throw err
        if (isRetriableNetworkError(err)) {
          throw new RetriableStreamError(err instanceof Error ? err.message : String(err), err)
        }
        throw err
      }
      if (read.done) {
        finished = true
        break
      }
      const value = read.value
      if (!value?.length) continue
      const next = new Uint8Array(buffer.length + value.length)
      next.set(buffer, 0)
      next.set(value, buffer.length)
      buffer = next
    }
    if (buffer.length > 0) {
      throw new EventStreamDecodeError('Event stream ended in the middle of a message')
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined)
    try {
      reader.releaseLock()
    } catch {
      // already released
    }
  }
}

/** Encode a message — used by tests and local mocks to speak the same framing. */
export function encodeEventStreamMessage(
  headers: Record<string, string>,
  payload: Uint8Array | string
): Uint8Array {
  const enc = new TextEncoder()
  const body = typeof payload === 'string' ? enc.encode(payload) : payload
  const headerParts: Uint8Array[] = []
  for (const [name, value] of Object.entries(headers)) {
    const n = enc.encode(name)
    const v = enc.encode(value)
    const part = new Uint8Array(1 + n.length + 1 + 2 + v.length)
    const dv = new DataView(part.buffer)
    part[0] = n.length
    part.set(n, 1)
    part[1 + n.length] = 7
    dv.setUint16(2 + n.length, v.length)
    part.set(v, 4 + n.length)
    headerParts.push(part)
  }
  const headersLen = headerParts.reduce((s, p) => s + p.length, 0)
  const total = PRELUDE_BYTES + headersLen + body.length + 4
  const out = new Uint8Array(total)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, total)
  dv.setUint32(4, headersLen)
  dv.setUint32(8, crc32(out.subarray(0, 8)))
  let at = PRELUDE_BYTES
  for (const p of headerParts) {
    out.set(p, at)
    at += p.length
  }
  out.set(body, at)
  dv.setUint32(total - 4, crc32(out.subarray(0, total - 4)))
  return out
}
