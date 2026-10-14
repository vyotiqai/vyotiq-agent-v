/**
 * The renderer half of a live voice session (docs/voice-mode.md §4): opens
 * the mic, streams 16 kHz chunks to main, follows `voice:event`, and hands
 * each finished turn to whoever sends it to the agent (D-07). The voice bar
 * (Phase 6) renders `snapshot`; nothing here draws anything.
 */
import { useSyncExternalStore } from 'react'
import type { VoiceEvent } from '@shared/ipc/schemas/voice'
import { parseVoiceIpcCode, type SttProviderId, type TtsProviderId, type VoiceErrorCode } from '@shared/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { MicCaptureError, openMicCapture, type MicCapture, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import { levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'
import { VoicePlayer, type PlayerAudioContext } from './voicePlayer'

export type VoiceSnapshot = {
  state: VoiceSessionState
  /** Unsettled words of the turn in progress. */
  partial: string
  /** The last turn you finished, until the next one starts. */
  lastTurn: string
  /** What the agent is saying right now, for captions: the reply so far, newest words last. */
  saying: string
  /** The question it asked while it waits on you (an approval, a question), kept until you answer. */
  asked: string
  listener: SttProviderId | null
  listenerFellBackFrom: SttProviderId | null
  /** Who speaks the replies; null when nothing can (replies stay on screen), undefined before it's known. */
  speaker?: TtsProviderId | null
  speakerFellBackFrom: TtsProviderId | null
  /** Your mic level 0..1, for the orb. */
  micLevel: number
  error: VoiceErrorCode | null
  reconnectAttempt: number
  muted: boolean
  deviceLabel: string
  /** Slow steps marked with a sound (spoken progress off); counts up. */
  cues: number
}

export const IDLE_VOICE: VoiceSnapshot = {
  state: 'off',
  partial: '',
  lastTurn: '',
  saying: '',
  asked: '',
  listener: null,
  listenerFellBackFrom: null,
  speakerFellBackFrom: null,
  micLevel: 0,
  error: null,
  reconnectAttempt: 0,
  muted: false,
  deviceLabel: '',
  cues: 0
}

export type VoiceTurn = { turnId: string; text: string; stop: boolean }

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
  | 'onVoiceAudioOut'
>

export type VoiceControllerDeps = {
  bridge?: () => Bridge
  openCapture?: OpenMicCapture
  /**
   * A finished turn: send it to the agent (or cancel the run for a stop
   * phrase). Return the run it went to, so its reply is spoken.
   */
  onTurn: (turn: VoiceTurn) => Promise<string | null> | string | null | void
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
  /** The reply the caption is building up. */
  private sayingId: string | null = null
  /** Replies whose audio started and hasn't drained. */
  private sounding = new Set<string>()

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
    if (this.active) return
    this.starting = true
    this.set({ ...IDLE_VOICE, state: 'connecting' })
    const bridge = this.bridge()
    // Listen before starting, so the first state events aren't missed.
    this.offEvents = bridge.onVoiceEvent((e) => this.onEvent(e))
    this.offAudio = bridge.onVoiceAudioOut((chunk) => {
      if (!this.replies.has(chunk.utteranceId)) return
      this.ensurePlayer().enqueue({ pcm: chunk.pcm, sampleRate: chunk.sampleRate, contextId: chunk.utteranceId })
    })
    // Open the mic first: a blocked mic should fail before anything is billed.
    try {
      this.capture = await (this.deps.openCapture ?? openMicCapture)({
        deviceId: opts.deviceId || undefined,
        onSamples: (pcm) => this.onSamples(pcm),
        onEnded: () => void this.stop()
      })
      this.set({ deviceLabel: this.capture.deviceLabel })
    } catch (err) {
      this.starting = false
      this.teardown()
      this.set({ state: 'error', error: micFailureCode(err) })
      return
    }
    const res = await bridge.voiceStart({ workspacePath: opts.workspacePath })
    this.starting = false
    if (!res.ok) {
      this.teardown()
      this.set({ state: 'error', error: parseVoiceIpcCode(res.code) ?? 'engine_failed' })
      return
    }
    this.sessionId = res.data.sessionId
  }

  private onSamples(pcm: Int16Array): void {
    this.set({ micLevel: this.snap.muted ? 0 : levelFromRms(rmsOfInt16(pcm)) })
    const id = this.sessionId
    if (!id || this.snap.muted) return
    void this.bridge().voiceAudio({ sessionId: id, pcm })
  }

  private onEvent(e: VoiceEvent): void {
    // Events from before our id is known (the start call is still returning) are ours too.
    if (this.sessionId && e.sessionId !== this.sessionId) return
    switch (e.kind) {
      case 'state':
        // Your own turn starts the next caption afresh. Not on other state
        // changes: a reply's words arrive while the run works, and its audio
        // often starts only after the run has finished.
        if (e.state === 'hearing') this.sayingId = null
        this.set({
          ...(e.state === 'hearing' ? { saying: '' } : {}),
          state: e.state,
          ...(e.state !== 'waiting_on_you' ? { asked: '' } : {}),
          ...(e.state === 'hearing' ? { partial: '', lastTurn: '' } : {}),
          ...(e.state === 'listening' ? { reconnectAttempt: 0, error: null } : {})
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
        this.set({ partial: '', lastTurn: e.text, saying: '' })
        void this.routeTurn({ turnId: e.turnId, text: e.text, stop: e.stop })
        return
      case 'say': {
        // Sentences of one reply build up; a new reply starts the caption afresh.
        const same = this.replies.has(e.contextId) && this.sayingId === e.contextId
        this.replies.add(e.contextId)
        this.sayingId = e.contextId
        this.set({
          saying: same && this.snap.saying ? `${this.snap.saying} ${e.text}` : e.text,
          ...(this.snap.state === 'waiting_on_you' ? { asked: e.text } : {})
        })
        return
      }
      case 'flush':
        this.replies.delete(e.contextId)
        this.sounding.delete(e.contextId)
        this.player?.cancel(e.contextId)
        this.set({ saying: '' })
        return
      case 'duck':
        this.player?.duck(e.on)
        return
      case 'cue':
        this.set({ cues: this.snapshot.cues + 1 })
        return
      case 'reconnecting':
        this.set({ reconnectAttempt: e.attempt })
        return
      case 'error':
        this.set({ error: e.code })
        return
    }
  }

  private async routeTurn(turn: VoiceTurn): Promise<void> {
    const id = this.sessionId
    let runId: string | null | void = null
    try {
      runId = await this.deps.onTurn(turn)
    } catch {
      runId = null
    }
    if (!id || id !== this.sessionId) return
    // Every turn reports where it went, so the session never waits on a run that isn't coming.
    if (runId) void this.bridge().voiceFollow({ sessionId: id, runId })
    else void this.bridge().voiceFollow({ sessionId: id, runId: null, reason: turn.stop ? 'stopped' : 'not_sent' })
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
        onIdle: () => {
          const id = this.sessionId
          const drained = [...this.sounding]
          this.sounding.clear()
          // The caption stays until the session leaves speaking (no flash of "Speaking").
          if (!id) return
          for (const contextId of drained) void this.bridge().voicePlayback({ sessionId: id, contextId, phase: 'drained' })
        }
      })
    }
    return this.player
  }

  /** The agent's voice level 0..1 while it speaks, for the orb. */
  speakingLevel(): number {
    return this.player?.level() ?? 0
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
    this.set({ muted, micLevel: 0 })
    void this.bridge().voiceMute({ sessionId: this.sessionId, muted })
  }

  ptt(down: boolean): void {
    if (this.sessionId) void this.bridge().voicePtt({ sessionId: this.sessionId, down })
  }

  async stop(): Promise<void> {
    const id = this.sessionId
    this.sessionId = null
    this.starting = false
    this.teardown()
    this.set({ ...IDLE_VOICE })
    if (id) await this.bridge().voiceStop({ sessionId: id })
  }

  private teardown(): void {
    this.capture?.stop()
    this.capture = null
    this.offEvents?.()
    this.offEvents = null
    this.offAudio?.()
    this.offAudio = null
    this.replies.clear()
    this.sounding.clear()
    const player = this.player
    this.player = null
    void player?.close()
  }
}

export function useVoiceSnapshot(controller: VoiceSessionController): VoiceSnapshot {
  return useSyncExternalStore(controller.subscribe, () => controller.snapshot, () => controller.snapshot)
}
