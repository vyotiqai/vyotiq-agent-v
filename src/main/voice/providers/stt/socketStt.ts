/**
 * What every websocket speech-to-text adapter shares: connect with auth
 * headers, hold audio and control frames until the socket opens (up to ten
 * seconds of audio), time out a connection that never opens, and turn
 * closes and errors into typed `SttEvent`s exactly once.
 */
import type { VoiceErrorCode } from '../../../../shared/voice'
import { isRetryableVoiceError } from '../../../../shared/voice'
import { SOCKET_OPEN, openVoiceSocket, parseFrame, type VoiceSocket } from '../../socket'
import type { SttEvent, SttOpenOptions, SttSession } from '../types'

const OPEN_TIMEOUT_MS = 10_000
/** Audio held while connecting, at most (16 kHz samples): ten seconds. */
const MAX_PENDING_SAMPLES = 16000 * 10

type Frame = string | Uint8Array

export abstract class SocketStt implements SttSession {
  protected readonly socket: VoiceSocket
  protected readonly emit: (event: SttEvent) => void
  private outbox: Frame[] = []
  private pendingSamples = 0
  private closed = false
  private openTimer: ReturnType<typeof setTimeout> | null
  private readyResolve!: () => void
  private readyReject!: (err: Error) => void
  /** Resolves when the socket opens; rejects if it fails first. */
  readonly ready: Promise<void>

  protected constructor(
    url: string,
    headers: Record<string, string>,
    protected readonly opts: SttOpenOptions,
    private readonly vendor: string
  ) {
    this.emit = (event) => {
      try {
        opts.emit(event)
      } catch {
        /* a listener that throws must not break the socket */
      }
    }
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
    })
    this.ready.catch(() => {})
    this.socket = openVoiceSocket(url, headers)
    this.openTimer = setTimeout(() => this.fail('offline', `${vendor} did not connect`), OPEN_TIMEOUT_MS)
    this.socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      this.onOpen()
      for (const frame of this.outbox) this.socket.send(frame)
      this.outbox = []
      this.pendingSamples = 0
      this.readyResolve()
      this.emit({ kind: 'open' })
    }
    this.socket.onmessage = (ev) => {
      if (this.closed) return
      const msg = parseFrame(ev.data)
      if (msg) this.onMessage(msg)
    }
    this.socket.onerror = () => this.fail('offline', `${vendor} connection error`)
    this.socket.onclose = (ev) => {
      if (this.closed) return
      this.fail(this.closeCode(ev.code, ev.reason ?? ''), `${vendor} closed (${ev.code ?? '?'}) ${ev.reason ?? ''}`)
    }
    opts.signal.addEventListener('abort', () => void this.close(), { once: true })
  }

  /** Called once the socket is open, before queued frames are sent. */
  protected onOpen(): void {}
  protected abstract onMessage(msg: Record<string, unknown>): void
  /** Encode one chunk of 16 kHz mono Int16 audio for this vendor. */
  protected abstract audioFrame(pcm16k: Int16Array): Frame | null
  /** Map a close to a code; most vendors close with 1008/4001 for a bad key. */
  protected closeCode(code: number | undefined, reason: string): VoiceErrorCode {
    if (code === 1008 || code === 4001 || code === 4003 || /auth|unauthori[sz]ed|api key|credential/i.test(reason)) {
      return 'rejected_key'
    }
    if (code === 4002 || /credit|quota|payment|balance/i.test(reason)) return 'out_of_credit'
    if (code === 4029 || /rate|too many|concurren/i.test(reason)) return 'rate_limited'
    return code === 1000 ? 'engine_failed' : 'offline'
  }

  abstract endTurn(): void

  pushAudio(pcm16k: Int16Array): void {
    if (this.closed || pcm16k.length === 0) return
    const frame = this.audioFrame(pcm16k)
    if (!frame) return
    if (this.socket.readyState === SOCKET_OPEN) {
      this.socket.send(frame)
      return
    }
    if (this.pendingSamples + pcm16k.length > MAX_PENDING_SAMPLES) return
    this.pendingSamples += pcm16k.length
    this.outbox.push(frame)
  }

  protected sendJson(frame: Record<string, unknown>): void {
    if (this.closed) return
    const data = JSON.stringify(frame)
    if (this.socket.readyState === SOCKET_OPEN) this.socket.send(data)
    else this.outbox.push(data)
  }

  protected fail(code: VoiceErrorCode, message: string): void {
    if (this.closed) return
    this.emit({ kind: 'error', code, message, retryable: isRetryableVoiceError(code) })
    this.readyReject(new Error(message))
    this.shutdown(message)
  }

  /** A goodbye frame for the vendor (CloseStream, Terminate…); sent on close. */
  protected goodbye(): Record<string, unknown> | null {
    return null
  }

  async close(): Promise<void> {
    if (this.closed) return
    const bye = this.goodbye()
    if (bye && this.socket.readyState === SOCKET_OPEN) {
      try {
        this.socket.send(JSON.stringify(bye))
      } catch {
        /* closing anyway */
      }
    }
    this.shutdown('closed by client')
  }

  private shutdown(reason: string): void {
    this.closed = true
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
    this.outbox = []
    try {
      this.socket.close(1000)
    } catch {
      /* already closed */
    }
    this.emit({ kind: 'closed', reason })
  }
}

export function int16Bytes(pcm: Int16Array): Uint8Array {
  // Int16Array is little-endian on every platform Electron ships for.
  return new Uint8Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength))
}

export function int16Base64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

export function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}
