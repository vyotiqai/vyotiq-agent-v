/**
 * The renderer half of a live voice session (docs/voice-mode.md §4): opens
 * the mic, streams 16 kHz chunks to main, follows `voice:event`, and hands
 * the voice's hand-offs to whoever sends them to the agent (D-44). The voice
 * view renders `snapshot`; nothing here draws anything.
 */
import { useSyncExternalStore } from 'react'
import type { VoiceEvent, VoiceHandOffFailure, VoiceScreen, VoiceWork } from '@shared/ipc/schemas/voice'
import { parseVoiceIpcCode, type SttProviderId, type TtsProviderId, type VoiceErrorCode } from '@shared/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { MicCaptureError, openMicCapture, type MicCapture, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import { levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'
import { VoicePlayer, type PlayerAudioContext } from './voicePlayer'
import { CaptionPacer } from './captionPacer'

export type VoiceSnapshot = {
  state: VoiceSessionState
  /** Muted until called by name ("Agent V"): listening, but only for that (§24.15). */
  standby: boolean
  /** Unsettled words of the turn in progress. */
  partial: string
  /** The last turn you finished, until the next one starts. */
  lastTurn: string
  /** What the agent is saying right now, for captions. */
  saying: string
  listener: SttProviderId | null
  listenerFellBackFrom: SttProviderId | null
  /** Who speaks the replies; null when nothing can (replies stay on screen), undefined before it's known. */
  speaker?: TtsProviderId | null
  speakerFellBackFrom: TtsProviderId | null
  /** What ended the session (state `error`). */
  error: VoiceErrorCode | null
  /** The provider's reason for `error`, one line (D-40). */
  errorDetail: string
  /** The agent's voice stopped working; replies stay on screen. Kept for the session. */
  speakError: VoiceProblemEvent | null
  /** The last spoken turn didn't go through; cleared when you start talking again. */
  turnError: VoiceProblemEvent | null
  reconnectAttempt: number
  muted: boolean
  deviceLabel: string
  /** Slow steps marked with a sound (spoken progress off); counts up. */
  cues: number
  /** The conversation so far, both sides, newest last (the voice view's transcript). */
  transcript: readonly VoiceLine[]
  /** The work of each run a hand-off went to, by run id (§25): steps, result, what it waits on. */
  works: Readonly<Record<string, VoiceWork>>
  /**
   * The reply you talked over (or stopped): its transcript line, which holds
   * exactly the words that had played. The view shows it dimmed, ending in a
   * dash, until the next reply. Null otherwise.
   */
  cutLineId: string | null
}

/**
 * One line of the conversation: what you said, what the voice said, or work
 * handed to the agent. A hand-off learns its run once the task takes it.
 */
export type VoiceLine = {
  id: string
  who: 'you' | 'voice' | 'agent'
  text: string
  runId?: string
  /** A hand-off the task never took, and why. */
  failed?: VoiceHandOffFailure
  /** Yours, heard and left unanswered on purpose (a filler, talk not meant for it). */
  unanswered?: true
}

/** Runs whose work is kept; the oldest go (their hand-offs keep their briefs). */
export const MAX_WORKS = 12

/** The line for a run that was already working when voice mode opened: the view reads "Doing …". */
export const CURRENT_WORK_BRIEF = 'the task’s current work'

/** What the view says when the microphone goes away mid-session (unplugged, or taken by another app). */
export const MIC_LOST_DETAIL = 'The microphone stopped: unplugged, or taken by another app.'

/**
 * A hold through mute that nothing was heard in is muted again after this
 * long, unless a turn started (it is then muted again once answered).
 */
export const PTT_REMUTE_MS = 1500

/** Lines kept on screen; older ones scroll away (the task record keeps the work). */
export const MAX_TRANSCRIPT_LINES = 60

/** A problem the session survived: our code and the provider's reason. */
export type VoiceProblemEvent = { code: VoiceErrorCode; detail: string }

/** voice_end: how long to wait for the goodbye to start, and the most to wait for it to finish. */
const END_GRACE_MS = 900
const END_WAIT_MS = 8000

export const IDLE_VOICE: VoiceSnapshot = {
  state: 'off',
  standby: false,
  partial: '',
  lastTurn: '',
  saying: '',
  listener: null,
  listenerFellBackFrom: null,
  speakerFellBackFrom: null,
  error: null,
  errorDetail: '',
  speakError: null,
  turnError: null,
  reconnectAttempt: 0,
  muted: false,
  deviceLabel: '',
  cues: 0,
  transcript: [],
  works: {},
  cutLineId: null
}

export type VoiceTurn = { turnId: string; text: string; stop: boolean }

/**
 * Where a hand-off went: the run to follow; `failed` when the task never took
 * it; null when it was sent but its run isn't known (the reply then isn't spoken).
 */
export type VoiceTurnResult = string | null | void | { failed: VoiceHandOffFailure }

type Bridge = Pick<
  typeof window.vyotiq,
  | 'voiceStart'
  | 'voiceStop'
  | 'voiceAudio'
  | 'voicePtt'
  | 'voiceMute'
  | 'onVoiceEvent'
  | 'voiceFollow'
  | 'voicePlayback'
  | 'voiceInterrupt'
  | 'voiceHandOffFailed'
  | 'onVoiceAudioOut'
> &
  // Optional: a main without it still runs voice mode, only without the task's conversation.
  Partial<Pick<typeof window.vyotiq, 'voiceTask'>>

export type VoiceControllerDeps = {
  bridge?: () => Bridge
  openCapture?: OpenMicCapture
  /**
   * Work the voice handed to the agent: send it to the task (it starts the
   * task, or joins the running one). Return the run it went to, so the
   * agent's result is spoken.
   */
  onTurn: (turn: VoiceTurn) => Promise<VoiceTurnResult> | VoiceTurnResult
  /** The voice was asked to stop the agent's work: press the task's Stop. */
  onStopAgent?: () => Promise<void> | void
  /** The voice was asked to end voice mode (voice_end). */
  onEndRequested?: () => Promise<void> | void
  createAudioContext?: () => PlayerAudioContext
}

export function micFailureCode(err: unknown): VoiceErrorCode {
  if (err instanceof MicCaptureError) {
    if (err.kind === 'blocked') return 'mic_blocked'
    if (err.kind === 'no_device') return 'mic_missing'
    if (err.kind === 'unsupported') return 'unsupported'
  }
  return 'engine_failed'
}

export class VoiceSessionController {
  private snap: VoiceSnapshot = IDLE_VOICE
  private listeners = new Set<() => void>()
  private sessionId: string | null = null
  private capture: MicCapture | null = null
  private offEvents: (() => void) | null = null
  private offAudio: (() => void) | null = null
  private starting = false
  private player: VoicePlayer | null = null
  /** Replies main told us about (by `say`), whose audio we play. */
  private replies = new Set<string>()
  /** Replies whose audio started and hasn't drained. */
  private sounding = new Set<string>()
  /**
   * The transcript's last line when each reply was said. Its caption waits for
   * its audio, but the hand-off it announced ("On it.") lands at once: the
   * reply goes back above it, in the order you heard them.
   */
  private saidAfter = new Map<string, string | null>()
  /** Each sentence's caption waits for its own audio to start playing. */
  private readonly captions = new CaptionPacer({
    reveal: (contextId, text) =>
      this.set({ saying: text, transcript: addLine(this.snap.transcript, contextId, 'voice', text, this.saidAfter.get(contextId)) }),
    sounding: (contextId) => this.player?.sounding(contextId) ?? false
  })
  /**
   * Bumps on every start and stop: a start whose mic or session arrives after
   * End (or a newer start) closes what it opened instead of keeping it.
   */
  private startSeq = 0
  /**
   * Your mic level 0..1. Not in the snapshot: it changes with every chunk (~8 a
   * second), and the orbs read it per frame through `micLevel()`.
   */
  private level = 0
  /** The run main follows for this session (handed off, or already working when it opened). */
  private followed: string | null = null
  /** A live run to follow once the session's id is known. */
  private wantFollow: string | null = null
  /** The task the session is on, as last told to main (`undefined`: not yet), and the one to tell once it can. */
  /** The task and screen last sent, as a key: the same again isn't sent. */
  private taskSent: string | undefined = undefined
  private task: { runId: string | null; workspacePath?: string; screen?: VoiceScreen } | null = null
  /** Hand-offs on their way to the task: their own follow names the run. */
  private handingOff = 0
  /** Where its voice plays (an audio output's id; '' the default), applied to each audio context made. */
  private sinkId = ''
  /** The audio context the player was given, so the output can be switched while it plays. */
  private audioCtx: PlayerAudioContext | null = null
  /** The mic stays open but nothing is sent: a voice sample is playing, and the mic must not hear it. */
  private micHeld = false
  /** The device the mic was opened on, for a switch that fails (the old one stays). */
  private deviceId: string | undefined
  /** Hold-to-talk unmuted a muted session: muted again once it is back to listening. */
  private pttUnmuted: 'held' | 'released' | null = null
  /** After a hold that nothing was heard in, the session never leaves listening: muted again after this. */
  private pttRemuteTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly deps: VoiceControllerDeps) {}

  get snapshot(): VoiceSnapshot {
    return this.snap
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private bridge(): Bridge {
    return this.deps.bridge ? this.deps.bridge() : window.vyotiq
  }

  private set(next: Partial<VoiceSnapshot>): void {
    const was = this.snap.state
    this.snap = { ...this.snap, ...next }
    // A hold that talked through mute: once its turn is answered (back into listening), muted again.
    if (this.pttUnmuted === 'released' && was !== 'listening' && this.snap.state === 'listening' && this.sessionId) {
      this.remuteAfterHold()
      return
    }
    for (const l of this.listeners) l()
  }

  private remuteAfterHold(): void {
    if (this.pttRemuteTimer) clearTimeout(this.pttRemuteTimer)
    this.pttRemuteTimer = null
    if (this.pttUnmuted !== 'released') return
    this.pttUnmuted = null
    this.setMuted(true)
  }

  get active(): boolean {
    return this.sessionId !== null || this.starting
  }

  async start(opts: { workspacePath?: string; deviceId?: string } = {}): Promise<void> {
    // "Try again" after the session failed: close the dead one and open afresh (A-10).
    // Not through `stop()`: passing through `off` would hand the line back and drop the bar.
    if (this.snap.state === 'error' && !this.starting) {
      const dead = this.sessionId
      this.sessionId = null
      this.teardown()
      if (dead) void this.bridge().voiceStop({ sessionId: dead })
    }
    if (this.active) return
    const seq = ++this.startSeq
    this.starting = true
    this.set({ ...IDLE_VOICE, state: 'connecting' })
    const bridge = this.bridge()
    // Listen before starting, so the first state events aren't missed.
    this.offEvents = bridge.onVoiceEvent((e) => this.onEvent(e))
    this.offAudio = bridge.onVoiceAudioOut((chunk) => {
      if (!this.replies.has(chunk.utteranceId)) return
      // The reply's speech is complete: it drains once it has played out (B9).
      if (chunk.last) {
        this.player?.endContext(chunk.utteranceId)
        this.captions.ended(chunk.utteranceId)
        return
      }
      const delayMs = this.ensurePlayer().enqueue({ pcm: chunk.pcm, sampleRate: chunk.sampleRate, contextId: chunk.utteranceId })
      if (delayMs !== null) this.captions.audio(chunk.utteranceId, chunk.piece, delayMs)
    })
    // Open the mic first: a blocked mic should fail before anything is billed.
    this.deviceId = opts.deviceId || undefined
    try {
      const capture = await (this.deps.openCapture ?? openMicCapture)({
        deviceId: opts.deviceId || undefined,
        onSamples: (pcm) => this.onSamples(pcm),
        onEnded: () => void this.micLost()
      })
      // Ended while the mic was opening: it must not stay on behind an "off" view.
      if (seq !== this.startSeq) {
        capture.stop()
        return
      }
      this.capture = capture
      this.set({ deviceLabel: capture.deviceLabel })
    } catch (err) {
      if (seq !== this.startSeq) return
      this.starting = false
      this.teardown()
      this.set({ state: 'error', error: micFailureCode(err) })
      return
    }
    const res = await bridge.voiceStart({ workspacePath: opts.workspacePath })
    // Ended while main opened the listener: close the session we were never told about.
    if (seq !== this.startSeq) {
      if (res.ok) void bridge.voiceStop({ sessionId: res.data.sessionId })
      return
    }
    this.starting = false
    if (!res.ok) {
      this.teardown()
      this.set({ state: 'error', error: parseVoiceIpcCode(res.code) ?? 'engine_failed' })
      return
    }
    this.sessionId = res.data.sessionId
    if (this.task) this.sendTask()
    const want = this.wantFollow
    this.wantFollow = null
    if (want) this.followRun(want)
  }

  /**
   * The task the session is on, working or not: main reads its conversation
   * so the voice knows what it's about. Voice mode opened on a finished task
   * used to tell you it had no record of it.
   */
  setTask(runId: string | null, workspacePath?: string, screen?: VoiceScreen): void {
    this.task = { runId, ...(workspacePath ? { workspacePath } : {}), ...(screen ? { screen } : {}) }
    if (this.sessionId) this.sendTask()
  }

  private sendTask(): void {
    const id = this.sessionId
    const task = this.task
    const key = `${task?.runId ?? ''}|${task?.screen ?? ''}`
    if (!id || !task || key === this.taskSent) return
    this.taskSent = key
    void this.bridge().voiceTask?.({ sessionId: id, ...task })
  }

  /**
   * Follow a run this session didn't hand anything to: one already working
   * on the task when voice mode opened, or when it moved to this task. Its
   * result is then spoken, "stop" and "is it done?" reach it, and what it
   * waits on is asked out loud. Once per run; a hand-off on its way names its own.
   */
  followRun(runId: string): void {
    if (this.followed === runId || this.handingOff > 0) return
    const id = this.sessionId
    if (!id) {
      if (this.starting) this.wantFollow = runId
      return
    }
    this.followed = runId
    // Its steps show under a line of their own, as a hand-off's do.
    if (!this.snap.transcript.some((l) => l.runId === runId)) {
      const line: VoiceLine = { id: `run:${runId}`, who: 'agent', text: CURRENT_WORK_BRIEF, runId }
      this.set({ transcript: [...this.snap.transcript, line].slice(-MAX_TRANSCRIPT_LINES) })
    }
    void this.bridge().voiceFollow({ sessionId: id, runId })
  }

  /**
   * The microphone went away under the session (unplugged, another app took
   * it). Say so, with the way back, instead of the view just vanishing; the
   * conversation stays on screen.
   */
  private async micLost(): Promise<void> {
    const id = this.sessionId
    if (!id && !this.starting) return
    this.startSeq++
    this.sessionId = null
    this.starting = false
    this.teardown()
    this.set({ state: 'error', error: 'mic_missing', errorDetail: MIC_LOST_DETAIL, partial: '', saying: '' })
    if (id) await this.bridge().voiceStop({ sessionId: id })
  }

  private onSamples(pcm: Int16Array): void {
    const deaf = this.snap.muted || this.micHeld
    this.level = deaf ? 0 : levelFromRms(rmsOfInt16(pcm))
    const id = this.sessionId
    if (!id || deaf) return
    void this.bridge().voiceAudio({ sessionId: id, pcm })
  }

  private onEvent(e: VoiceEvent): void {
    // Events from before our id is known (the start call is still returning) are ours too.
    if (this.sessionId && e.sessionId !== this.sessionId) return
    switch (e.kind) {
      case 'state':
        // A failed session doesn't keep the mic: the indicator says it's off, so it must be (A-11).
        if (e.state === 'error') this.releaseMic()
        this.set({
          state: e.state,
          ...(e.state === 'hearing' ? { partial: '', lastTurn: '', turnError: null } : {}),
          ...(e.state === 'listening' ? { reconnectAttempt: 0 } : {})
        })
        return
      case 'engine':
        this.set({
          listener: e.stt,
          listenerFellBackFrom: e.sttFellBackFrom ?? null,
          ...(e.tts !== undefined ? { speaker: e.tts, speakerFellBackFrom: e.ttsFellBackFrom ?? null } : {})
        })
        return
      case 'partial':
        this.set({ partial: e.text })
        return
      case 'turn':
        // What you said; main sends it on to the task as a hand-off, word for word (§27).
        this.set({ partial: '', lastTurn: e.text, saying: '', transcript: addLine(this.snap.transcript, e.turnId, 'you', e.text) })
        return
      case 'unanswered':
        this.set({ transcript: markUnanswered(this.snap.transcript, e.turnId, e.text) })
        return
      case 'hand_off':
        this.set({ transcript: addLine(this.snap.transcript, e.handOffId, 'agent', e.brief) })
        void this.routeTurn({ turnId: e.handOffId, text: e.brief, stop: false })
        return
      case 'followed':
        // Main follows the run your turn started: the line carries it, and a "couldn't follow" no longer stands.
        this.followed = e.runId
        this.set({ transcript: this.snap.transcript.map((l) => (l.id === e.handOffId ? { ...l, runId: e.runId, failed: undefined } : l)) })
        return
      case 'stop_agent':
        void this.deps.onStopAgent?.()
        return
      case 'say':
        // A new reply: the one you talked over stops being "cut" on screen.
        if (this.snap.cutLineId && this.snap.cutLineId !== e.contextId) this.set({ cutLineId: null })
        if (!this.saidAfter.has(e.contextId)) this.saidAfter.set(e.contextId, this.snap.transcript.at(-1)?.id ?? null)
        this.replies.add(e.contextId)
        this.captions.say(e.contextId, e.text, e.audible)
        return
      case 'flush':
        this.saidAfter.delete(e.contextId)
        this.replies.delete(e.contextId)
        this.sounding.delete(e.contextId)
        this.captions.drop(e.contextId)
        this.player?.cancel(e.contextId)
        // Its line holds the words that had played: that's where it was cut.
        this.set({ saying: '', cutLineId: this.snap.transcript.some((l) => l.id === e.contextId) ? e.contextId : this.snap.cutLineId })
        return
      case 'duck':
        this.player?.duck(e.on)
        return
      case 'work':
        this.set({ works: keepWork(this.snap.works, e.work) })
        return
      case 'standby':
        this.set({ standby: e.on })
        return
      case 'end_requested':
        // After its last words have played: ending first would cut them off.
        void this.afterSpeech().then(() => this.deps.onEndRequested?.())
        return
      case 'cue':
        this.set({ cues: this.snapshot.cues + 1 })
        return
      case 'reconnecting':
        this.set({ reconnectAttempt: e.attempt })
        return
      case 'error': {
        const problem = { code: e.code, detail: e.detail ?? '' }
        // Older mains sent no side: an error outside the error state was the voice.
        const side = e.side ?? (this.snap.state === 'error' ? 'session' : 'speak')
        if (side === 'turn') this.set({ turnError: problem })
        else if (side === 'speak') {
          // No audio is coming for what's waiting: show it.
          this.captions.speakFailed()
          this.set({ speakError: problem })
        }
        else this.set({ error: e.code, errorDetail: problem.detail })
        return
      }
    }
  }

  /**
   * Once the voice has finished talking: its goodbye comes just after the
   * request to end, so this waits a moment for it to start, then for it to
   * play out (at most END_WAIT_MS).
   */
  private afterSpeech(): Promise<void> {
    const started = Date.now()
    return new Promise((resolve) => {
      const check = (): void => {
        const quiet = this.sounding.size === 0 && this.snap.state !== 'speaking' && this.snap.state !== 'thinking'
        const waited = Date.now() - started
        if ((quiet && waited >= END_GRACE_MS) || waited >= END_WAIT_MS || this.snap.state === 'off') resolve()
        else setTimeout(check, 100)
      }
      check()
    })
  }

  private async routeTurn(turn: VoiceTurn): Promise<void> {
    const id = this.sessionId
    let result: VoiceTurnResult = null
    this.handingOff++
    try {
      result = await this.deps.onTurn(turn)
    } catch {
      result = { failed: 'error' }
    } finally {
      this.handingOff--
    }
    // Ended, or a new session, while the task took it: nothing here is ours to update.
    if (!id || id !== this.sessionId) return
    if (typeof result === 'string') {
      const runId = result
      this.followed = runId
      this.set({ transcript: this.snap.transcript.map((l) => (l.id === turn.turnId ? { ...l, runId } : l)) })
      void this.bridge().voiceFollow({ sessionId: id, runId, handOffId: turn.turnId })
      return
    }
    if (result && typeof result === 'object') {
      // Main already follows the run this turn started: the window losing track of it is no failure.
      if (result.failed === 'unfollowed' && this.snap.transcript.some((l) => l.id === turn.turnId && l.runId)) return
      // The line says it didn't go, and main has the voice say so.
      const failed = result.failed
      this.set({ transcript: this.snap.transcript.map((l) => (l.id === turn.turnId ? { ...l, failed } : l)) })
      void this.bridge().voiceHandOffFailed({ sessionId: id, handOffId: turn.turnId, reason: failed })
    }
  }

  /** An audio context on the chosen output; kept, so a switch reaches the one playing. */
  private makeAudioContext = (): PlayerAudioContext => {
    const ctx = this.deps.createAudioContext ? this.deps.createAudioContext() : new AudioContext({ sampleRate: 24000 })
    this.audioCtx = ctx
    if (this.sinkId) applySink(ctx, this.sinkId)
    return ctx
  }

  private ensurePlayer(): VoicePlayer {
    if (!this.player) {
      this.player = new VoicePlayer({
        createContext: this.makeAudioContext,
        onContextStart: (contextId) => {
          this.sounding.add(contextId)
          const id = this.sessionId
          if (id) void this.bridge().voicePlayback({ sessionId: id, contextId, phase: 'started' })
        },
        onContextDrained: (contextId) => {
          this.captions.drained(contextId)
          this.saidAfter.delete(contextId)
          this.replies.delete(contextId)
          if (!this.sounding.delete(contextId)) return
          const id = this.sessionId
          if (id) void this.bridge().voicePlayback({ sessionId: id, contextId, phase: 'drained' })
        },
        onIdle: () => {
          if (this.snap.saying) this.set({ saying: '' })
        }
      })
    }
    return this.player
  }

  /** The agent's voice level 0..1 while it speaks, for the orb. */
  speakingLevel(): number {
    return this.player?.level() ?? 0
  }

  /** Your mic level 0..1, for the orb; read per frame, never rendered from. */
  micLevel(): number {
    return this.level
  }

  /** What the orb shows: the agent's voice while it speaks, yours otherwise. */
  orbLevel(): number {
    return this.snap.state === 'speaking' ? this.speakingLevel() : this.level
  }

  /** Stop speaking now; the agent keeps working. */
  interrupt(): void {
    if (this.sessionId) void this.bridge().voiceInterrupt({ sessionId: this.sessionId })
  }

  /** The session id, while one is open (for tests and the bar's data attributes). */
  get id(): string | null {
    return this.sessionId
  }

  /**
   * Where its voice plays: an audio output's device id ('' the system
   * default). Applies to the reply playing now and every one after.
   */
  setOutput(deviceId: string): void {
    this.sinkId = deviceId
    if (this.audioCtx) applySink(this.audioCtx, deviceId)
  }

  /**
   * Listen on another microphone without ending the session: the new one
   * opens first, then the old one closes, so nothing is missed between them.
   * False when the new one couldn't be opened (the old one keeps listening).
   */
  async switchMic(deviceId: string): Promise<boolean> {
    if (!this.capture || !this.sessionId) {
      this.deviceId = deviceId || undefined
      return true
    }
    const seq = this.startSeq
    try {
      const next = await (this.deps.openCapture ?? openMicCapture)({
        deviceId: deviceId || undefined,
        onSamples: (pcm) => this.onSamples(pcm),
        onEnded: () => void this.micLost()
      })
      // Ended (or restarted) while the new mic opened: it isn't ours to keep.
      if (seq !== this.startSeq || !this.sessionId) {
        next.stop()
        return false
      }
      const old = this.capture
      this.capture = next
      this.deviceId = deviceId || undefined
      old?.stop()
      this.set({ deviceLabel: next.deviceLabel })
      return true
    } catch {
      return false
    }
  }

  /** The mic keeps running but sends nothing (a voice sample is playing); the mute state you set is untouched. */
  holdMic(held: boolean): void {
    this.micHeld = held
    if (held) this.level = 0
  }

  setMuted(muted: boolean): void {
    if (!this.sessionId) return
    // Muting or unmuting by hand ends a hold's temporary unmute.
    if (this.pttUnmuted === 'released') {
      this.pttUnmuted = null
      if (this.pttRemuteTimer) clearTimeout(this.pttRemuteTimer)
      this.pttRemuteTimer = null
    }
    this.level = 0
    this.set({ muted })
    void this.bridge().voiceMute({ sessionId: this.sessionId, muted })
  }

  /** The mic id the session listens on ('' or undefined: the system default). */
  get micDeviceId(): string | undefined {
    return this.deviceId
  }

  /**
   * Hold to talk (Space, the orb, the mini window). Held while it speaks, it
   * stops speaking at once rather than waiting for the barge-in to be heard.
   * Held while muted, it talks anyway: unmuted for the hold, muted again once
   * the turn is answered.
   */
  ptt(down: boolean): void {
    const id = this.sessionId
    if (!id) return
    if (down) {
      if (this.snap.state === 'speaking') this.interrupt()
      if (this.snap.muted) {
        this.pttUnmuted = 'held'
        this.setMuted(false)
      }
    }
    void this.bridge().voicePtt({ sessionId: id, down })
    if (!down && this.pttUnmuted === 'held') {
      this.pttUnmuted = 'released'
      // Nothing was heard: no turn will come back to listening, so the mute comes back on its own.
      if (this.pttRemuteTimer) clearTimeout(this.pttRemuteTimer)
      this.pttRemuteTimer = setTimeout(() => {
        this.pttRemuteTimer = null
        if (this.snap.state === 'listening') this.remuteAfterHold()
      }, PTT_REMUTE_MS)
    }
    if (down && this.pttRemuteTimer) {
      clearTimeout(this.pttRemuteTimer)
      this.pttRemuteTimer = null
    }
  }

  async stop(): Promise<void> {
    const id = this.sessionId
    this.startSeq++
    this.sessionId = null
    this.starting = false
    this.teardown()
    this.set({ ...IDLE_VOICE })
    if (id) await this.bridge().voiceStop({ sessionId: id })
  }

  private releaseMic(): void {
    this.capture?.stop()
    this.capture = null
    this.level = 0
    this.micHeld = false
    this.pttUnmuted = null
    if (this.pttRemuteTimer) clearTimeout(this.pttRemuteTimer)
    this.pttRemuteTimer = null
  }

  private teardown(): void {
    this.releaseMic()
    this.offEvents?.()
    this.offEvents = null
    this.offAudio?.()
    this.offAudio = null
    this.replies.clear()
    this.sounding.clear()
    this.saidAfter.clear()
    this.captions.clear()
    this.followed = null
    this.wantFollow = null
    this.taskSent = undefined
    const player = this.player
    this.player = null
    this.audioCtx = null
    void player?.close()
  }
}

/** `setSinkId` is Chromium's (Electron has it); a fake context or an older engine without it plays on the default. */
function applySink(ctx: PlayerAudioContext, deviceId: string): void {
  const sinkable = ctx as PlayerAudioContext & { setSinkId?: (id: string) => Promise<void> }
  void sinkable.setSinkId?.(deviceId)?.catch(() => {
    // An unplugged output: play on the default rather than not at all.
    void sinkable.setSinkId?.('')?.catch(() => undefined)
  })
}

/**
 * A new line, or more words for the line already open under this id (a reply
 * arrives a sentence at a time). `after`: the line that was last when the
 * reply was said (null: none yet). A new line goes straight after it when
 * only hand-offs came since, since those land the moment it is said and the
 * caption only once its audio plays; after anything else it goes last.
 */
export function addLine(lines: readonly VoiceLine[], id: string, who: VoiceLine['who'], text: string, after?: string | null): readonly VoiceLine[] {
  const words = text.trim()
  if (!words) return lines
  const i = lines.findIndex((l) => l.id === id)
  if (i >= 0) {
    const next = lines.slice()
    next[i] = { ...lines[i]!, text: `${lines[i]!.text} ${words}` }
    return next
  }
  const line: VoiceLine = { id, who, text: words }
  let at = lines.length
  if (after !== undefined) {
    const anchor = after === null ? -1 : lines.findIndex((l) => l.id === after)
    // Its anchor scrolled away, or something you said came since: last, as it was heard.
    if ((after === null || anchor >= 0) && lines.slice(anchor + 1).every((l) => l.who === 'agent')) at = anchor + 1
  }
  const next = [...lines.slice(0, at), line, ...lines.slice(at)]
  return next.length > MAX_TRANSCRIPT_LINES ? next.slice(-MAX_TRANSCRIPT_LINES) : next
}

/** Your line `id` left unanswered on purpose; with `text`, added first (it was never a turn). */
export function markUnanswered(lines: readonly VoiceLine[], id: string, text?: string): readonly VoiceLine[] {
  const withLine = text ? addLine(lines, id, 'you', text) : lines
  const i = withLine.findIndex((l) => l.id === id && l.who === 'you')
  if (i < 0) return withLine
  const next = withLine.slice()
  next[i] = { ...withLine[i]!, unanswered: true }
  return next
}

/** Keep a run's newest work; past MAX_WORKS runs, the one heard from longest ago goes. */
export function keepWork(works: Readonly<Record<string, VoiceWork>>, work: VoiceWork): Readonly<Record<string, VoiceWork>> {
  const { [work.runId]: _old, ...rest } = works
  const next: Record<string, VoiceWork> = { ...rest, [work.runId]: work }
  const ids = Object.keys(next)
  for (const id of ids.slice(0, Math.max(0, ids.length - MAX_WORKS))) delete next[id]
  return next
}

export function useVoiceSnapshot(controller: VoiceSessionController): VoiceSnapshot {
  return useSyncExternalStore(controller.subscribe, () => controller.snapshot, () => controller.snapshot)
}
