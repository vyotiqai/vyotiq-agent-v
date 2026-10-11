/**
 * The renderer half of a live voice session (docs/voice-mode.md §4): opens
 * the mic, streams 16 kHz chunks to main, follows `voice:event`, and hands
 * each finished turn to whoever sends it to the agent (D-07). The voice bar
 * (Phase 6) renders `snapshot`; nothing here draws anything.
 */
import { useSyncExternalStore } from 'react'
import type { VoiceEvent } from '@shared/ipc/schemas/voice'
import { parseVoiceIpcCode, type SttProviderId, type VoiceErrorCode } from '@shared/voice'
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
  /** What the agent is saying right now, for captions. */
  saying: string
  listener: SttProviderId | null
  listenerFellBackFrom: SttProviderId | null
  /** Your mic level 0..1, for the orb. */
  micLevel: number
  error: VoiceErrorCode | null
  reconnectAttempt: number
  muted: boolean
  deviceLabel: string
}

export const IDLE_VOICE: VoiceSnapshot = {
  state: 'off',
  partial: '',
  lastTurn: '',
  saying: '',
  listener: null,
  listenerFellBackFrom: null,
  micLevel: 0,
  error: null,
  reconnectAttempt: 0,
  muted: false,
  deviceLabel: ''
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
        this.set({
          state: e.state,
          ...(e.state === 'hearing' ? { partial: '', lastTurn: '' } : {}),
          ...(e.state === 'listening' ? { reconnectAttempt: 0, error: null } : {})
        })
        return
      case 'engine':
        this.set({ listener: e.stt, listenerFellBackFrom: e.sttFellBackFrom ?? null })
        return
      case 'partial':
        this.set({ partial: e.text })
        return
      case 'turn':
        this.set({ partial: '', lastTurn: e.text, saying: '' })
        void this.routeTurn({ turnId: e.turnId, text: e.text, stop: e.stop })
        return
      case 'say':
        this.replies.add(e.contextId)
        this.set({ saying: e.text })
        return
      case 'flush':
        this.replies.delete(e.contextId)
        this.sounding.delete(e.contextId)
        this.player?.cancel(e.contextId)
        this.set({ saying: '' })
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
    if (runId && id && id === this.sessionId) void this.bridge().voiceFollow({ sessionId: id, runId })
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
          if (this.snap.saying) this.set({ saying: '' })
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
