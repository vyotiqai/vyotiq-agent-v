/**
 * OpenAI live transcription for one take: a realtime session that hears the
 * audio as it is captured and writes words while you speak, instead of one
 * request per phrase after each pause. Opt-in — it costs about four times
 * as much a minute.
 *
 * The take's segmenter still decides where a phrase ends (the model has no
 * turn detection of its own); each cut is a commit. The session answers with
 * an item per commit: deltas while it is spoken, then the whole transcript.
 *
 * Items are matched to phrases by order. A committed item gets the next
 * phrase number when OpenAI confirms the commit; words for the item still
 * being spoken are only passed on while no commit is waiting for its
 * confirmation — until then they could belong to the phrase just cut.
 */
import { logger } from '../../shared/logger'
import type { DictationLiveEvent } from '../../shared/ipc'

export const OPENAI_LIVE_URL = 'wss://api.openai.com/v1/realtime?intent=transcription'
export const OPENAI_LIVE_MODEL = 'gpt-live-transcribe'
/** The realtime API takes 24 kHz PCM only; takes capture 16 kHz. */
const LIVE_RATE = 24000
/** A session that has not opened by now will not; the take falls back to per-phrase requests. */
const OPEN_TIMEOUT_MS = 10_000
/** Audio waiting for the socket to open, at most (16 kHz samples) — a minute. */
const MAX_QUEUED_SAMPLES = 16000 * 60

type LiveSocket = Pick<WebSocket, 'send' | 'close' | 'readyState'> & {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export type OpenLiveSocket = (url: string, headers: Record<string, string>) => LiveSocket

const defaultOpenSocket: OpenLiveSocket = (url, headers) =>
  new WebSocket(url, { headers } as unknown as string[]) as unknown as LiveSocket

let openSocket: OpenLiveSocket = defaultOpenSocket

export function setOpenLiveSocketForTests(fn: OpenLiveSocket | null): void {
  openSocket = fn ?? defaultOpenSocket
}

/** 16 kHz → 24 kHz by linear interpolation, carried across chunks. */
export class Upsampler16To24 {
  /** The last input sample of the previous chunk. */
  private prev: number | null = null
  /** Where the next output falls, in thirds of an input sample, from `prev`. */
  private t3 = 0

  push(input: Int16Array): Int16Array {
    const x = this.prev == null ? input : prependSample(this.prev, input)
    if (x.length < 2) {
      if (x.length === 1) this.prev = x[0]!
      return new Int16Array(0)
    }
    const last3 = (x.length - 1) * 3
    const n = this.t3 <= last3 ? Math.floor((last3 - this.t3) / 2) + 1 : 0
    const out = new Int16Array(n)
    let t3 = this.t3
    for (let k = 0; k < n; k++) {
      const i = Math.floor(t3 / 3)
      const f = (t3 - i * 3) / 3
      const a = x[i]!
      const b = x[Math.min(i + 1, x.length - 1)]!
      out[k] = Math.round(a + (b - a) * f)
      t3 += 2
    }
    this.t3 = t3 - last3
    this.prev = x[x.length - 1]!
    return out
  }
}

function prependSample(first: number, rest: Int16Array): Int16Array {
  const x = new Int16Array(rest.length + 1)
  x[0] = first
  x.set(rest, 1)
  return x
}

function int16ToBase64(pcm: Int16Array): string {
  return Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString('base64')
}

type Session = {
  socket: LiveSocket
  open: boolean
  closed: boolean
  /** Audio and commits waiting for the socket to open, in the order they came. */
  queued: Array<Int16Array | 'commit'>
  queuedSamples: number
  upsampler: Upsampler16To24
  /** Commits sent, and commits OpenAI has confirmed. */
  sent: number
  acked: number
  /** item id → phrase number, once its commit is confirmed. */
  ordinal: Map<string, number>
  /** Words so far per item, bound or not. */
  text: Map<string, string>
  /** Items done: their transcript went out. */
  finished: Set<string>
  /** Items whose words already went out while they were being spoken. */
  shown: Set<string>
  openTimer: ReturnType<typeof setTimeout> | null
  emit: (event: DictationLiveEvent) => void
}

const sessions = new Map<string, Session>()

export type OpenLiveOptions = {
  takeId: string
  apiKey: string
  language?: string
  prompt?: string
  keywords?: readonly string[]
  emit: (event: DictationLiveEvent) => void
}

export function openLiveTake(opts: OpenLiveOptions): void {
  closeLiveTake(opts.takeId)
  const socket = openSocket(OPENAI_LIVE_URL, { Authorization: `Bearer ${opts.apiKey}` })
  const s: Session = {
    socket,
    open: false,
    closed: false,
    queued: [],
    queuedSamples: 0,
    upsampler: new Upsampler16To24(),
    sent: 0,
    acked: 0,
    ordinal: new Map(),
    text: new Map(),
    finished: new Set(),
    shown: new Set(),
    openTimer: null,
    emit: (event) => {
      try {
        opts.emit(event)
      } catch {
        /* the window went away */
      }
    }
  }
  sessions.set(opts.takeId, s)
  const takeId = opts.takeId
  const fail = (message: string): void => {
    if (s.closed) return
    s.emit({ takeId, kind: 'error', message })
    endSession(takeId, s)
  }
  s.openTimer = setTimeout(() => fail('OpenAI live transcription did not connect'), OPEN_TIMEOUT_MS)
  socket.onopen = () => {
    if (s.closed) return
    if (s.openTimer) clearTimeout(s.openTimer)
    s.openTimer = null
    s.open = true
    const transcription: Record<string, unknown> = { model: OPENAI_LIVE_MODEL, delay: 'low' }
    if (opts.language) transcription.languages = [opts.language]
    if (opts.prompt) transcription.prompt = opts.prompt
    if (opts.keywords?.length) transcription.keywords = opts.keywords
    socket.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'transcription',
          audio: { input: { format: { type: 'audio/pcm', rate: LIVE_RATE }, transcription, turn_detection: null } }
        }
      })
    )
    for (const item of s.queued) {
      if (item === 'commit') socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
      else sendAudio(s, item)
    }
    s.queued = []
    s.queuedSamples = 0
    s.emit({ takeId, kind: 'open' })
  }
  socket.onmessage = (ev) => {
    if (s.closed) return
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data)) as Record<string, unknown>
    } catch {
      return
    }
    onServerEvent(takeId, s, msg)
  }
  socket.onerror = () => fail('OpenAI live transcription lost its connection')
  socket.onclose = (ev) => {
    if (s.closed) return
    fail(ev?.reason ? `OpenAI live transcription closed: ${ev.reason}` : 'OpenAI live transcription closed')
  }
}

function sendAudio(s: Session, pcm16k: Int16Array): void {
  const up = s.upsampler.push(pcm16k)
  if (up.length === 0) return
  s.socket.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: int16ToBase64(up) }))
}

export function appendLiveAudio(takeId: string, pcm16k: Int16Array): boolean {
  const s = sessions.get(takeId)
  if (!s || s.closed) return false
  if (!s.open) {
    if (s.queuedSamples + pcm16k.length > MAX_QUEUED_SAMPLES) return false
    s.queued.push(pcm16k)
    s.queuedSamples += pcm16k.length
    return true
  }
  sendAudio(s, pcm16k)
  return true
}

/** The segmenter cut a phrase: everything sent so far is one item. */
export function commitLive(takeId: string): boolean {
  const s = sessions.get(takeId)
  if (!s || s.closed) return false
  s.sent++
  if (!s.open) {
    s.queued.push('commit')
    return true
  }
  s.socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }))
  return true
}

export function closeLiveTake(takeId: string): void {
  const s = sessions.get(takeId)
  if (s) endSession(takeId, s)
}

/** Every live session, on quit. */
export function closeAllLiveTakes(): void {
  for (const [takeId, s] of sessions) endSession(takeId, s)
}

function endSession(takeId: string, s: Session): void {
  if (s.closed) return
  s.closed = true
  if (s.openTimer) clearTimeout(s.openTimer)
  s.openTimer = null
  if (sessions.get(takeId) === s) sessions.delete(takeId)
  try {
    s.socket.close()
  } catch {
    /* already closed */
  }
}

function onServerEvent(takeId: string, s: Session, msg: Record<string, unknown>): void {
  const type = typeof msg.type === 'string' ? msg.type : ''
  const itemId = typeof msg.item_id === 'string' ? msg.item_id : ''
  switch (type) {
    case 'input_audio_buffer.committed': {
      if (!itemId || s.ordinal.has(itemId)) return
      const ordinal = s.acked++
      s.ordinal.set(itemId, ordinal)
      // Words that came before the commit was confirmed were held back: send them now.
      const held = s.text.get(itemId)
      if (s.finished.has(itemId)) s.emit({ takeId, kind: 'words', ordinal, text: held ?? '', final: true })
      else if (held && !s.shown.has(itemId)) s.emit({ takeId, kind: 'words', ordinal, text: held.trim(), final: false })
      return
    }
    case 'conversation.item.input_audio_transcription.delta': {
      if (!itemId || s.finished.has(itemId)) return
      const delta = typeof msg.delta === 'string' ? msg.delta : ''
      const text = (s.text.get(itemId) ?? '') + delta
      s.text.set(itemId, text)
      const ordinal = s.ordinal.get(itemId) ?? (s.sent === s.acked ? s.acked : null)
      if (ordinal == null) return
      s.shown.add(itemId)
      s.emit({ takeId, kind: 'words', ordinal, text: text.trim(), final: false })
      return
    }
    case 'conversation.item.input_audio_transcription.completed': {
      if (!itemId) return
      const ordinal = s.ordinal.get(itemId)
      const transcript = typeof msg.transcript === 'string' ? msg.transcript.trim() : ''
      s.finished.add(itemId)
      s.text.set(itemId, transcript)
      if (ordinal != null) s.emit({ takeId, kind: 'words', ordinal, text: transcript, final: true })
      return
    }
    case 'conversation.item.input_audio_transcription.failed': {
      const ordinal = s.ordinal.get(itemId)
      s.finished.add(itemId)
      if (ordinal != null) s.emit({ takeId, kind: 'item_failed', ordinal })
      return
    }
    case 'error': {
      const err = (msg.error ?? {}) as { message?: unknown; code?: unknown }
      const message = typeof err.message === 'string' ? err.message : 'OpenAI live transcription failed'
      // The code only: OpenAI's messages can echo part of the key back.
      logger.warn('Dictation live session error', {
        scope: 'dictation',
        code: typeof err.code === 'string' ? err.code : 'unknown'
      })
      // An error event about one request (say a commit with nothing in the
      // buffer) does not end the session; the socket closing does.
      if (err.code === 'input_audio_buffer_commit_empty') return
      s.emit({ takeId, kind: 'error', message })
      endSession(takeId, s)
      return
    }
    default:
      return
  }
}

export function resetLiveTakesForTests(): void {
  closeAllLiveTakes()
  openSocket = defaultOpenSocket
}
