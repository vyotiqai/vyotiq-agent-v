/**
 * What every websocket speech-to-text adapter shares: connect with auth
 * headers, hold audio and control frames until the socket opens (up to ten
 * seconds of audio), time out a connection that never opens, and turn
 * closes and errors into typed `SttEvent`s exactly once.
 */
import type { VoiceErrorCode } from '../../../../shared/voice'
import { isRetryableVoiceError, voiceDetail } from '../../../../shared/voice'
import { VoiceError } from '../../errors'
import { SOCKET_OPEN, openVoiceSocket, parseFrame, type VoiceSocket } from '../../socket'
import type { SttEvent, SttOpenOptions, SttSession } from '../types'

const OPEN_TIMEOUT_MS = 10_000
/** Audio held while connecting, at most (16 kHz samples): ten seconds. */
const MAX_PENDING_SAMPLES = 16000 * 10

type Frame = string | Uint8Array

/** A cheap authenticated GET that answers 401 for a bad key. */
export type KeyCheck = { url: string; headers: Record<string, string> }

const KEY_CHECK_TIMEOUT_MS = 5_000
let keyCheckFetch: typeof fetch = (...args) => fetch(...args)

/** Tests only: a fake `fetch` for the key check. */
export function setKeyCheckFetchForTests(fn: typeof fetch | null): void {
  keyCheckFetch = fn ?? ((...args) => fetch(...args))
}

/**
 * Why a socket that never opened was refused (A-12). A refused handshake
 * reaches us only as close 1006, with no HTTP status, so ask the vendor's
 * REST API once with the same key. Only a clear answer counts: 401 (and not
 * a restricted key missing a permission), 402 or 429. Anything else, or no
 * answer, is null and the drop stays a dropped connection.
 */
export async function diagnoseRefusal(check: KeyCheck): Promise<{ code: VoiceErrorCode; reason: string } | null> {
  let res: Response
  try {
    res = await keyCheckFetch(check.url, { headers: check.headers, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) })
  } catch {
    return null
  }
  const body = await res.text().catch(() => '')
  const reason = voiceDetail(body)
  if (res.status === 401 && !/permission/i.test(body)) return { code: 'rejected_key', reason }
  if (res.status === 402) return { code: 'out_of_credit', reason }
  if (res.status === 429) return { code: 'rate_limited', reason }
  return null
}

export abstract class SocketStt implements SttSession {
  protected readonly socket: VoiceSocket
  protected readonly emit: (event: SttEvent) => void
  private outbox: Frame[] = []
  private pendingSamples = 0
  private closed = false
  private opened = false
  private diagnosing = false
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
    this.openTimer = setTimeout(() => this.refused('offline', `${vendor} did not connect`), OPEN_TIMEOUT_MS)
    this.socket.onopen = () => {
      if (this.openTimer) clearTimeout(this.openTimer)
      this.openTimer = null
      this.opened = true
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
    this.socket.onerror = () => this.refused('offline', `${vendor} connection error`)
    this.socket.onclose = (ev) => {
      if (this.closed) return
      this.refused(this.closeCode(ev.code, ev.reason ?? ''), `${vendor} closed (${ev.code ?? '?'}) ${ev.reason ?? ''}`)
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

  /** The vendor's key check, for a handshake that's refused (A-12); none by default. */
  protected keyCheck(): KeyCheck | null {
    return null
  }

  /**
   * A failure from the socket. Before it ever opened, a plain "offline" may
   * really be a refused key: check once, then fail with what was found.
   */
  private refused(code: VoiceErrorCode, message: string): void {
    if (this.closed || this.diagnosing) return
    const check = !this.opened && code === 'offline' ? this.keyCheck() : null
    if (!check) return this.fail(code, message)
    this.diagnosing = true
    if (this.openTimer) clearTimeout(this.openTimer)
    this.openTimer = null
    void diagnoseRefusal(check).then((found) => {
      this.diagnosing = false
      if (found) this.fail(found.code, `${this.vendor} refused the connection${found.reason ? `: ${found.reason}` : ''}`)
      else this.fail(code, message)
    })
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
    // Typed, so a refused open keeps its code: a plain Error read as engine_failed and ended a reconnect.
    this.readyReject(new VoiceError(code, message))
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
