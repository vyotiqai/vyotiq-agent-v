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
  resolveTtsProvider,
  sttEntry,
  type SttProviderId,
  type VoiceErrorCode,
  type VoiceKeyAvailability,
  type VoiceKeySource
} from '../../shared/voice'
import { AGENT_FLOOR_STATES, nextVoiceState, type VoiceSessionEvent, type VoiceSessionState } from '../../shared/voiceSession'
import type { AgentEvent, AgentQuestionAnswer, AgentQuestionRequest, ToolApprovalRequest } from '../../shared/ipc'
import type { VoiceEvent, VoiceSettings } from '../../shared/ipc/schemas/voice'
import { VoiceError, toVoiceError } from './errors'
import { PauseDetector } from './pauseDetector'
import type { SttEvent, SttProvider, SttSession, TtsStream } from './providers/types'
import { ReplySpeaker } from './replySpeaker'
import { EchoGuard } from './echoGuard'
import { approvalAnswer, isStopPhrase, toSpeakable } from './speechText'
import { answerableByVoice, describeQuestion, questionAnswer } from './questionByVoice'

/** Reconnect waits (§15): five tries, then give up. */
export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const
/** Audio kept while reconnecting, at most (16 kHz samples): ten seconds. */
const RING_SAMPLES = 16000 * 10
/**
 * Barge-in in two steps (§6.2, D-33): the agent's voice dips the moment you
 * seem to start talking, and stops only once it's sure — this much voiced
 * audio, or words from the listener that aren't the agent's own.
 */
export const DUCK_CONFIRM_MS = 600
/** A dip that isn't confirmed by then was a cough, a click or an echo: the voice comes back. */
export const DUCK_GIVE_UP_MS = 1200
/** Keep a muted listener's connection alive this often. */
const KEEPALIVE_MS = 5000

/**
 * How long one turn took, measured from the moment the listener decided you
 * had finished (docs/voice-mode.md §14). Null where a stage didn't happen.
 */
export type TurnLatency = {
  listener: SttProviderId | null
  /** Your turn reached the agent (sent and followed). */
  submitMs: number | null
  /** The first sentence of the reply was ready to speak. */
  firstTextMs: number | null
  /** The first audio started playing. */
  firstAudioMs: number
}

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
  /** Approvals being asked and settled, any run (§7.5). */
  watchApprovals?: (watcher: {
    asked: (request: ToolApprovalRequest) => void
    settled: (requestId: string, runId: string) => void
  }) => () => void
  /** The agent's own questions (`ask_question`) being asked and settled, any run (§7.5). */
  watchQuestions?: (watcher: {
    asked: (request: AgentQuestionRequest) => void
    settled: (requestId: string, runId: string) => void
  }) => () => void
  /** Answer the agent's question, as its card would. */
  resolveQuestion?: (answer: { requestId: string; runId: string; answers: AgentQuestionAnswer[] }) => boolean
  /** Per-turn timings, for tuning (§14). Timings only; never words. */
  logLatency?: (timings: TurnLatency) => void
  /** Answer an approval, as the card would. */
  resolveApproval?: (answer: { requestId: string; runId: string; decision: 'once' | 'deny' }) => boolean
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
  private unwatchApprovals: (() => void) | null = null
  /** The turn being timed, from your last word to the agent's first sound. */
  private timing: { endOfTurnAt: number; followedAt?: number; firstSayAt?: number } | null = null
  /** The followed run's approval waiting on the person, if any. */
  private approval: ToolApprovalRequest | null = null
  private unwatchQuestions: (() => void) | null = null
  /** The followed run's question waiting on the person, if any. */
  private question: AgentQuestionRequest | null = null
  /** What the agent just said, to recognise it coming back through the mic (§6.4). */
  private readonly echo = new EchoGuard()
  /** The agent's voice is dipped while we find out whether you're really talking. */
  private duck: { since: number } | null = null

  constructor(private readonly deps: VoiceSessionDeps) {
    this.id = (deps.newId ?? randomUUID)()
    this.pause = new PauseDetector(deps.settings().endOfTurnPatience)
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.reply = new ReplySpeaker({
      openTts: (contextId) => this.openReplyTts(contextId),
      say: (contextId, text) => {
        this.echo.said(text, this.now())
        if (this.timing && this.timing.firstSayAt === undefined) this.timing.firstSayAt = this.now()
        if (this.deps.settings().captions) this.emitEvent({ kind: 'say', contextId, text })
      },
      onToolStart: () => this.dispatch({ type: 'tool_start' }),
      onRunEnd: () => this.dispatch({ type: 'run_done' }),
      speakProgress: () => this.deps.settings().speakProgress,
      quietCue: () => this.emitEvent({ kind: 'cue' }),
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
    if (this.timing && this.timing.followedAt === undefined) this.timing.followedAt = this.now()
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** The renderer's player: a reply's audio started, or everything queued for it played. */
  playback(contextId: string, phase: 'started' | 'drained'): void {
    if (phase === 'started') {
      const t = this.timing
      if (t) {
        this.timing = null
        const at = this.now()
        this.deps.logLatency?.({
          listener: this.sttId,
          submitMs: t.followedAt !== undefined ? t.followedAt - t.endOfTurnAt : null,
          firstTextMs: t.firstSayAt !== undefined ? t.firstSayAt - t.endOfTurnAt : null,
          firstAudioMs: at - t.endOfTurnAt
        })
      }
      this.playing.add(contextId)
      this.echo.setPlaying(true, this.now())
      this.dispatch({ type: 'audio_start' })
      this.pause.setAgentSpeaking(true)
      return
    }
    if (!this.playing.delete(contextId) || this.playing.size > 0) return
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    const wasDucked = this.duck !== null
    if (wasDucked) this.endDuck()
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
    // The agent finished while you might have been talking: if you still are, it's your turn.
    if (wasDucked && this.pause.voicedMs > 0) this.onSpeechStart()
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
    this.unwatchApprovals ??=
      this.deps.watchApprovals?.({
        asked: (req) => this.onApprovalAsked(req),
        settled: (requestId) => this.onApprovalSettled(requestId)
      }) ?? null
    this.unwatchQuestions ??=
      this.deps.watchQuestions?.({
        asked: (req) => this.onQuestionAsked(req),
        settled: (requestId) => this.onQuestionSettled(requestId)
      }) ?? null
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
    // Who speaks, too: never a silent fallback on either side (§9.5).
    const speaking = this.deps.openTts ? resolveTtsProvider(settings.ttsProvider, this.deps.keys()) : null
    this.emitEvent({
      kind: 'engine',
      stt: entry.id,
      ...(resolved.fellBackFrom ? { sttFellBackFrom: resolved.fellBackFrom } : {}),
      ...(speaking
        ? {
            tts: speaking.ok ? speaking.id : null,
            ...(speaking.ok && speaking.fellBackFrom ? { ttsFellBackFrom: speaking.fellBackFrom } : {})
          }
        : {})
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
      if (ev.kind === 'speech_start') {
        this.stt?.speechStarted?.()
        this.onSpeechStart()
      }
      // Listeners with their own turn model decide; the rest end on our pause.
      else if (!this.turnDetection && !ptt && ev.speechMs > 0) this.stt?.endTurn()
    }
    if (this.duck) {
      if (this.pause.voicedMs >= DUCK_CONFIRM_MS) this.bargeIn()
      else if (this.now() - this.duck.since > DUCK_GIVE_UP_MS) this.releaseDuck()
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
    this.unwatchApprovals?.()
    this.unwatchApprovals = null
    this.approval = null
    this.echo.reset()
    this.duck = null
    this.unwatchQuestions?.()
    this.unwatchQuestions = null
    this.question = null
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
        // The agent's own voice coming back isn't your caption, and doesn't cut it off.
        if (this.echo.isEcho(event.text, this.now())) {
          if (this.duck) this.releaseDuck()
          return
        }
        // Words that aren't the agent's: you really are talking.
        if (this.duck && event.text.trim()) this.bargeIn()
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
    if (this.duck) this.endDuck()
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
  }

  private onSpeechStart(): void {
    const s = this.stateValue
    if (!AGENT_FLOOR_STATES.has(s)) {
      this.dispatch({ type: 'speech_start' })
      return
    }
    // The agent is talking: dip its voice first (D-33); `bargeIn` once it's sure.
    if (this.playing.size > 0) {
      if (!this.duck) {
        this.duck = { since: this.now() }
        this.emitEvent({ kind: 'duck', on: true })
      }
      return
    }
    this.bargeIn()
  }

  /** Not you after all: the agent's voice comes back, and the next sound starts afresh. */
  private releaseDuck(): void {
    if (!this.duck) return
    this.endDuck()
    this.pause.reset()
  }

  private endDuck(): void {
    this.duck = null
    this.emitEvent({ kind: 'duck', on: false })
  }

  /**
   * Barge-in (§6.2): stop speaking now and clear the speakers. What happens
   * to the run is the renderer's call when this turn ends (steer / cancel).
   */
  private bargeIn(): void {
    if (this.duck) this.endDuck()
    if (!AGENT_FLOOR_STATES.has(this.stateValue)) return
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'barge_in' })
  }

  private onEndOfTurn(raw: string): void {
    const text = raw.trim()
    this.pause.reset()
    this.ring = []
    this.ringSamples = 0
    // Nothing said, or only the agent's own words picked up by the mic (§6.4):
    // not a turn, and never a message to the agent.
    const echo = Boolean(text) && this.echo.isEcho(text, this.now())
    if (this.duck) {
      if (!text || echo) this.releaseDuck()
      else this.bargeIn()
    }
    if (!text || echo) {
      this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
      return
    }
    if (!this.dispatch({ type: 'end_of_turn' })) return
    if (this.answerApprovalByVoice(text)) return
    if (this.answerQuestionByVoice(text)) return
    this.timing = { endOfTurnAt: this.now() }
    this.emitEvent({ kind: 'turn', turnId: (this.deps.newId ?? randomUUID)(), text, stop: isStopPhrase(text) })
  }

  // ── Approvals by voice (§7.5, B9) ──────────────────────────────────────

  /** Whether a spoken answer may settle this approval (never a risky one). */
  private voiceMayAnswer(req: ToolApprovalRequest): boolean {
    return this.deps.settings().approveByVoice && !req.danger && Boolean(this.deps.resolveApproval)
  }

  private onApprovalAsked(req: ToolApprovalRequest): void {
    if (this.stateValue === 'off' || req.runId !== this.followedRun) return
    this.approval = req
    this.dispatch({ type: 'needs_you' })
    const what = describeApproval(req)
    this.reply.announce(
      req.danger
        ? `It wants to ${what}, which could be risky. Approve or deny it on screen.`
        : this.voiceMayAnswer(req)
          ? `It wants to ${what}. Say yes or no.`
          : `It wants to ${what}. Approve or deny it on screen.`
    )
  }

  private onApprovalSettled(requestId: string): void {
    if (this.approval?.requestId !== requestId) return
    this.approval = null
    this.dispatch({ type: 'answered' })
  }

  /** A whole-utterance yes/no answers the pending approval instead of becoming a message. */
  private answerApprovalByVoice(text: string): boolean {
    const req = this.approval
    if (!req || !this.voiceMayAnswer(req)) return false
    const decision = approvalAnswer(text)
    if (!decision) return false
    const ok = this.deps.resolveApproval?.({ requestId: req.requestId, runId: req.runId, decision }) ?? false
    if (!ok) return false
    this.emitEvent({ kind: 'say', contextId: `approval:${req.requestId}`, text: decision === 'once' ? 'Allowed.' : 'Denied.' })
    return true
  }

  // ── The agent's questions by voice (§7.5) ──────────────────────────────

  private onQuestionAsked(req: AgentQuestionRequest): void {
    if (this.stateValue === 'off' || req.runId !== this.followedRun) return
    this.question = req
    this.dispatch({ type: 'needs_you' })
    this.reply.announce(describeQuestion(req))
  }

  private onQuestionSettled(requestId: string): void {
    if (this.question?.requestId !== requestId) return
    this.question = null
    this.dispatch({ type: 'answered' })
  }

  /**
   * A reply that clearly answers the one question settles it, as the card
   * would. Anything else (a stop phrase, an unclear pick, a form with
   * several questions) goes on as a message, which the agent reads as the
   * answer when it is one.
   */
  private answerQuestionByVoice(text: string): boolean {
    const req = this.question
    if (!req || !this.deps.resolveQuestion || isStopPhrase(text) || !answerableByVoice(req)) return false
    const item = req.questions[0]!
    const values = questionAnswer(item, text)
    if (!values) return false
    const ok = this.deps.resolveQuestion({
      requestId: req.requestId,
      runId: req.runId,
      answers: [{ questionId: item.id, values }]
    })
    if (!ok) return false
    this.emitEvent({ kind: 'say', contextId: `question:${req.requestId}`, text: 'Got it.' })
    return true
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

/** What an approval asks for, in a few spoken words (§7.5). */
export function describeApproval(req: Pick<ToolApprovalRequest, 'name' | 'summary'>): string {
  const name = req.name.toLowerCase()
  const summary = toSpeakable(req.summary).replace(/[.]+$/, '').slice(0, 120)
  if (/terminal|shell|command|bash/.test(name)) return summary ? `run ${summary}` : 'run a command'
  if (/edit|write|patch|create|replace|delete/.test(name)) return summary ? `change ${summary}` : 'change a file'
  if (/fetch|browser|navigate/.test(name)) return summary ? `open ${summary}` : 'open a web page'
  return summary ? `use ${req.name}: ${summary}` : `use ${req.name}`
}
