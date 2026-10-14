/**
 * The renderer half of a live voice session (docs/voice-mode.md §4): opens
 * the mic, streams 16 kHz chunks to main, follows `voice:event`, and hands
 * the voice's hand-offs to whoever sends them to the agent (D-44). The voice
 * view renders `snapshot`; nothing here draws anything.
 */
import { useSyncExternalStore } from 'react'
import type { VoiceEvent, VoiceHandOffFailure, VoiceWork } from '@shared/ipc/schemas/voice'
import { parseVoiceIpcCode, type SttProviderId, type TtsProviderId, type VoiceErrorCode } from '@shared/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { MicCaptureError, openMicCapture, type MicCapture, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import { levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'
import { VoicePlayer, type PlayerAudioContext } from './voicePlayer'
import { CaptionPacer } from './captionPacer'

export type VoiceSnapshot = {
  state: VoiceSessionState
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

/** Lines kept on screen; older ones scroll away (the task record keeps the work). */
export const MAX_TRANSCRIPT_LINES = 60

/** A problem the session survived: our code and the provider's reason. */
export type VoiceProblemEvent = { code: VoiceErrorCode; detail: string }

export const IDLE_VOICE: VoiceSnapshot = {
  state: 'off',
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
  works: {}
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
  /** Each sentence's caption waits for its own audio to start playing. */
  private readonly captions = new CaptionPacer({
    reveal: (contextId, text) => this.set({ saying: text, transcript: addLine(this.snap.transcript, contextId, 'voice', text) }),
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
  private taskSent: string | null | undefined = undefined
  private task: { runId: string | null; workspacePath?: string } | null = null
  /** Hand-offs on their way to the task: their own follow names the run. */
  private handingOff = 0

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
    this.snap = { ...this.snap, ...next }
    for (const l of this.listeners) l()
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
  setTask(runId: string | null, workspacePath?: string): void {
    this.task = { runId, ...(workspacePath ? { workspacePath } : {}) }
    if (this.sessionId) this.sendTask()
  }

  private sendTask(): void {
    const id = this.sessionId
    const task = this.task
    if (!id || !task || task.runId === this.taskSent) return
    this.taskSent = task.runId
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
    this.level = this.snap.muted ? 0 : levelFromRms(rmsOfInt16(pcm))
    const id = this.sessionId
    if (!id || this.snap.muted) return
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
        // What you said; the voice answers it in main (D-44). Only a hand-off reaches the agent.
        this.set({ partial: '', lastTurn: e.text, saying: '', transcript: addLine(this.snap.transcript, e.turnId, 'you', e.text) })
        return
      case 'unanswered':
        this.set({ transcript: markUnanswered(this.snap.transcript, e.turnId, e.text) })
        return
      case 'hand_off':
        this.set({ transcript: addLine(this.snap.transcript, e.handOffId, 'agent', e.brief) })
        void this.routeTurn({ turnId: e.handOffId, text: e.brief, stop: false })
        return
      case 'stop_agent':
        void this.deps.onStopAgent?.()
        return
      case 'say':
        this.replies.add(e.contextId)
        this.captions.say(e.contextId, e.text, e.audible)
        return
      case 'flush':
        this.replies.delete(e.contextId)
        this.sounding.delete(e.contextId)
        this.captions.drop(e.contextId)
        this.player?.cancel(e.contextId)
        this.set({ saying: '' })
        return
      case 'duck':
        this.player?.duck(e.on)
        return
      case 'work':
        this.set({ works: keepWork(this.snap.works, e.work) })
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
      // The voice said "On it.": the line says it didn't go, and main has the voice say so.
      const failed = result.failed
      this.set({ transcript: this.snap.transcript.map((l) => (l.id === turn.turnId ? { ...l, failed } : l)) })
      void this.bridge().voiceHandOffFailed({ sessionId: id, handOffId: turn.turnId, reason: failed })
    }
  }

  private ensurePlayer(): VoicePlayer {
    if (!this.player) {
      this.player = new VoicePlayer({
        createContext: this.deps.createAudioContext,
        onContextStart: (contextId) => {
          this.sounding.add(contextId)
          const id = this.sessionId
          if (id) void this.bridge().voicePlayback({ sessionId: id, contextId, phase: 'started' })
        },
        onContextDrained: (contextId) => {
          this.captions.drained(contextId)
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

  setMuted(muted: boolean): void {
    if (!this.sessionId) return
    this.level = 0
    this.set({ muted })
    void this.bridge().voiceMute({ sessionId: this.sessionId, muted })
  }

  ptt(down: boolean): void {
    if (this.sessionId) void this.bridge().voicePtt({ sessionId: this.sessionId, down })
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
  }

  private teardown(): void {
    this.releaseMic()
    this.offEvents?.()
    this.offEvents = null
    this.offAudio?.()
    this.offAudio = null
    this.replies.clear()
    this.sounding.clear()
    this.captions.clear()
    this.followed = null
    this.wantFollow = null
    this.taskSent = undefined
    const player = this.player
    this.player = null
    void player?.close()
  }
}

/** A new line, or more words for the line already open under this id (a reply arrives a sentence at a time). */
export function addLine(lines: readonly VoiceLine[], id: string, who: VoiceLine['who'], text: string): readonly VoiceLine[] {
  const words = text.trim()
  if (!words) return lines
  const i = lines.findIndex((l) => l.id === id)
  if (i >= 0) {
    const next = lines.slice()
    next[i] = { ...lines[i]!, text: `${lines[i]!.text} ${words}` }
    return next
  }
  const next = [...lines, { id, who, text: words }]
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
