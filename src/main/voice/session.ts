/**
 * A live voice session (docs/voice-mode.md §5, §6, §15): the mic audio in,
 * a cloud (or local) listener, turn-taking, and the state the voice bar
 * shows. This is the listening half. Phase 5 adds the agent bridge and the
 * spoken reply on top of the same state machine.
 *
 * Pure orchestration: the listener, keys, settings, clock and the way
 * events leave are all injected, so every behaviour is tested with the
 * fixture listener and fake timers.
 */
import { randomUUID } from 'crypto'
import {
  resolveModel,
  resolveSttProvider,
  sttEntry,
  type SttProviderId,
  type VoiceErrorCode,
  type VoiceKeyAvailability,
  type VoiceKeySource
} from '../../shared/voice'
import { AGENT_FLOOR_STATES, nextVoiceState, type VoiceSessionEvent, type VoiceSessionState } from '../../shared/voiceSession'
import type { AgentEvent } from '../../shared/ipc'
import type { VoiceEvent, VoiceSettings } from '../../shared/ipc/schemas/voice'
import { VoiceError, toVoiceError } from './errors'
import { PauseDetector } from './pauseDetector'
import type { SttEvent, SttProvider, SttSession, TtsStream } from './providers/types'
import { ReplySpeaker } from './replySpeaker'
import { isStopPhrase } from './speechText'

/** Reconnect waits (§15): five tries, then give up. */
export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const
/** Audio kept while reconnecting, at most (16 kHz samples): ten seconds. */
const RING_SAMPLES = 16000 * 10
/** Keep a muted listener's connection alive this often. */
const KEEPALIVE_MS = 5000

/** An event without its session id; the session stamps it. */
type Emitted = VoiceEvent extends infer E ? (E extends { sessionId: string } ? Omit<E, 'sessionId'> : never) : never

export type VoiceSessionDeps = {
  emit: (event: VoiceEvent) => void
  settings: () => VoiceSettings
  keys: () => VoiceKeyAvailability
  /** The key for a provider's source; throws `no_key` when missing. */
  readKey: (source: VoiceKeySource) => string
  sttProvider: (id: SttProviderId) => SttProvider
  keyterms?: readonly string[]
  /**
   * A text-to-speech stream for one spoken piece of the reply; null when no
   * speaking provider is usable (the session then stays text-only).
   */
  openTts?: (contextId: string, onError: (code: VoiceErrorCode) => void) => TtsStream | null
  /** Subscribe to a run's events (the run tap); returns the unsubscribe. */
  tapRun?: (runId: string, fn: (event: AgentEvent) => void) => () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newId?: () => string
}

export class VoiceSession {
  readonly id: string
  private stateValue: VoiceSessionState = 'off'
  private stt: SttSession | null = null
  private sttId: SttProviderId | null = null
  private turnDetection = false
  private ctrl = new AbortController()
  private readonly pause: PauseDetector
  private ring: Int16Array[] = []
  private ringSamples = 0
  private attempt = 0
  private reconnectTimer: unknown = null
  private keepAliveTimer: unknown = null
  private pttDown = false
  /** Bumps on every (re)connect, so a stale listener's events are ignored. */
  private generation = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly reply: ReplySpeaker
  private untap: (() => void) | null = null
  private followedRun: string | null = null
  /** Replies whose audio has started playing and not yet drained. */
  private playing = new Set<string>()
  private speakErrorShown = false

  constructor(private readonly deps: VoiceSessionDeps) {
    this.id = (deps.newId ?? randomUUID)()
    this.pause = new PauseDetector(deps.settings().endOfTurnPatience)
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.reply = new ReplySpeaker({
      openTts: (contextId) => this.openReplyTts(contextId),
      say: (contextId, text) => {
        if (this.deps.settings().captions) this.emitEvent({ kind: 'say', contextId, text })
      },
      onToolStart: () => this.dispatch({ type: 'tool_start' }),
      onRunEnd: () => this.dispatch({ type: 'run_done' }),
      speakProgress: () => this.deps.settings().speakProgress,
      newId: deps.newId ?? randomUUID,
      now: deps.now ?? Date.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
  }

  private openReplyTts(contextId: string): TtsStream | null {
    if (!this.deps.openTts) return null
    return this.deps.openTts(contextId, (code) => {
      // Say it once a session: the reply is still on screen.
      if (this.speakErrorShown) return
      this.speakErrorShown = true
      this.emitEvent({ kind: 'error', code, retryable: false })
    })
  }

  /**
   * Follow the run the last turn was sent to: its reply is spoken. Called
   * by the renderer after each turn it sends (D-07); the same run again for a
   * follow-up just starts a new spoken turn.
   */
  follow(runId: string): void {
    if (this.stateValue === 'off') return
    if (this.followedRun !== runId) {
      this.untap?.()
      this.untap = this.deps.tapRun ? this.deps.tapRun(runId, (ev) => this.reply.handle(ev)) : null
      this.followedRun = runId
    }
    this.reply.beginTurn()
  }

  /** The renderer's player: a reply's audio started, or everything queued for it played. */
  playback(contextId: string, phase: 'started' | 'drained'): void {
    if (phase === 'started') {
      this.playing.add(contextId)
      this.dispatch({ type: 'audio_start' })
      this.pause.setAgentSpeaking(true)
      return
    }
    if (!this.playing.delete(contextId) || this.playing.size > 0) return
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
  }

  get state(): VoiceSessionState {
    return this.stateValue
  }

  get listener(): SttProviderId | null {
    return this.sttId
  }

  /** Open the listener. Resolves once listening; a failure leaves the session in `error`. */
  async start(): Promise<void> {
    if (!this.dispatch({ type: 'start' })) return
    try {
      await this.connect()
      this.dispatch({ type: 'ready' })
    } catch (err) {
      this.failWith(toVoiceError(err).code)
    }
  }

  private async connect(): Promise<void> {
    const settings = this.deps.settings()
    const resolved = resolveSttProvider(settings.sttProvider, this.deps.keys())
    if (!resolved.ok) throw new VoiceError('no_key', 'No speech-to-text provider has a key')
    const entry = sttEntry(resolved.id)
    const apiKey = this.deps.readKey(entry.key)
    const gen = ++this.generation
    this.ctrl = new AbortController()
    this.pause.setPatience(settings.endOfTurnPatience)
    const session = await this.deps.sttProvider(entry.id).open({
      apiKey,
      model: resolveModel(entry.models, settings.stt[entry.id]?.model),
      language: settings.language,
      patience: settings.endOfTurnPatience,
      keyterms: this.deps.keyterms,
      signal: this.ctrl.signal,
      emit: (event) => {
        if (gen === this.generation) this.onStt(event)
      }
    })
    if (gen !== this.generation || this.stateValue === 'off') {
      await session.close()
      return
    }
    this.stt = session
    this.sttId = entry.id
    this.turnDetection = entry.caps.turnDetection
    this.emitEvent({
      kind: 'engine',
      stt: entry.id,
      ...(resolved.fellBackFrom ? { sttFellBackFrom: resolved.fellBackFrom } : {})
    })
  }

  /** Mic audio from the renderer. */
  pushAudio(pcm: Int16Array): void {
    const s = this.stateValue
    if (s === 'off' || s === 'connecting' || s === 'paused' || s === 'error') return
    if (s === 'reconnecting') {
      this.remember(pcm)
      return
    }
    const ptt = this.deps.settings().pushToTalkOnly
    if (ptt && !this.pttDown) return
    this.remember(pcm)
    this.stt?.pushAudio(pcm)
    for (const ev of this.pause.push(pcm)) {
      if (ev.kind === 'speech_start') this.onSpeechStart()
      // Listeners with their own turn model decide; the rest end on our pause.
      else if (!this.turnDetection && !ptt && ev.speechMs > 0) this.stt?.endTurn()
    }
  }

  /** Push-to-talk: release ends the turn now. */
  ptt(down: boolean): void {
    if (down === this.pttDown) return
    this.pttDown = down
    if (!down && (this.stateValue === 'hearing' || this.stateValue === 'listening')) {
      this.pause.reset()
      this.stt?.endTurn()
    }
  }

  setMuted(muted: boolean): void {
    if (muted) {
      if (!this.dispatch({ type: 'mute' })) return
      this.pause.reset()
      this.keepAliveTimer = this.setTimer(() => this.keepAlive(), KEEPALIVE_MS)
    } else {
      this.stopKeepAlive()
      this.dispatch({ type: 'unmute' })
    }
  }

  private keepAlive(): void {
    if (this.stateValue !== 'paused') return
    this.stt?.keepAlive?.()
    this.keepAliveTimer = this.setTimer(() => this.keepAlive(), KEEPALIVE_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) this.clearTimer(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /** Feed the session-level events Phase 5's agent bridge produces (run done, tool start…). */
  agentEvent(event: Extract<VoiceSessionEvent, { type: 'tool_start' | 'needs_you' | 'answered' | 'run_done' | 'audio_start' | 'audio_done' }>): void {
    this.dispatch(event)
    this.pause.setAgentSpeaking(this.stateValue === 'speaking')
  }

  async stop(): Promise<void> {
    if (this.stateValue === 'off') return
    this.dispatch({ type: 'stop' })
    this.generation++
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
    this.stopKeepAlive()
    this.untap?.()
    this.untap = null
    this.followedRun = null
    this.reply.dispose()
    this.playing.clear()
    this.ctrl.abort()
    const stt = this.stt
    this.stt = null
    this.ring = []
    this.ringSamples = 0
    await stt?.close()
  }

  // ── Listener events ──────────────────────────────────────────────────────

  private onStt(event: SttEvent): void {
    switch (event.kind) {
      case 'speech_start':
        this.onSpeechStart()
        return
      case 'partial':
        if (this.deps.settings().captions) this.emitEvent({ kind: 'partial', text: event.text })
        return
      case 'final':
        return
      case 'end_of_turn':
        this.onEndOfTurn(event.text)
        return
      case 'error':
        if (event.retryable) this.beginReconnect()
        else this.failWith(event.code)
        return
      case 'closed':
        // Closed under us (not by stop): try to get it back.
        if (this.stateValue !== 'off' && this.stateValue !== 'error') this.beginReconnect()
        return
      case 'open':
        return
    }
  }

  /**
   * "Stop speaking" (the bar's button, Esc): silence the reply without it
   * counting as the person talking. The run carries on.
   */
  interruptSpeech(): void {
    if (this.stateValue !== 'speaking') return
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
  }

  private onSpeechStart(): void {
    const s = this.stateValue
    if (!AGENT_FLOOR_STATES.has(s)) {
      this.dispatch({ type: 'speech_start' })
      return
    }
    // Barge-in (§6.2): stop speaking now and clear the speakers. What happens
    // to the run is the renderer's call when this turn ends (steer / cancel).
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'barge_in' })
  }

  private onEndOfTurn(raw: string): void {
    const text = raw.trim()
    this.pause.reset()
    this.ring = []
    this.ringSamples = 0
    if (!text) {
      this.dispatch({ type: 'false_start' })
      return
    }
    if (!this.dispatch({ type: 'end_of_turn' })) return
    this.emitEvent({ kind: 'turn', turnId: (this.deps.newId ?? randomUUID)(), text, stop: isStopPhrase(text) })
  }

  // ── Reconnect (§15) ──────────────────────────────────────────────────────

  private remember(pcm: Int16Array): void {
    this.ring.push(pcm)
    this.ringSamples += pcm.length
    while (this.ringSamples > RING_SAMPLES && this.ring.length > 1) this.ringSamples -= this.ring.shift()!.length
  }

  private beginReconnect(): void {
    if (this.stateValue === 'reconnecting') return
    if (!this.dispatch({ type: 'connection_lost' })) return
    this.generation++
    this.ctrl.abort()
    const stale = this.stt
    this.stt = null
    void stale?.close()
    this.attempt = 0
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[this.attempt]
    if (delay === undefined) {
      this.failWith('offline')
      return
    }
    this.attempt++
    this.emitEvent({ kind: 'reconnecting', attempt: this.attempt })
    this.reconnectTimer = this.setTimer(() => void this.tryReconnect(), delay)
  }

  private async tryReconnect(): Promise<void> {
    this.reconnectTimer = null
    if (this.stateValue !== 'reconnecting') return
    try {
      await this.connect()
    } catch (err) {
      const e = toVoiceError(err)
      if (!e.retryable) return this.failWith(e.code)
      return this.scheduleReconnect()
    }
    if (this.stateValue !== 'reconnecting') return
    // Replay what was said during the dropout, then carry on.
    for (const pcm of this.ring) this.stt?.pushAudio(pcm)
    this.dispatch({ type: 'connection_restored' })
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private failWith(code: VoiceErrorCode): void {
    if (!this.dispatch({ type: 'fail' })) return
    this.generation++
    this.ctrl.abort()
    const stt = this.stt
    this.stt = null
    void stt?.close()
    this.emitEvent({ kind: 'error', code, retryable: code === 'offline' || code === 'provider_down' || code === 'rate_limited' })
  }

  private dispatch(event: VoiceSessionEvent): boolean {
    const next = nextVoiceState(this.stateValue, event)
    if (next === null) return false
    if (next !== this.stateValue) {
      this.stateValue = next
      this.emitEvent({ kind: 'state', state: next })
    }
    return true
  }

  private emitEvent(event: Emitted): void {
    try {
      this.deps.emit({ ...event, sessionId: this.id } as VoiceEvent)
    } catch {
      /* the window went away */
    }
  }
}
