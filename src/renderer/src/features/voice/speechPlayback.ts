/**
 * Speaking one thing at a time outside a live session: a voice preview in
 * Settings, or an answer read aloud (docs/voice-mode.md Phase 3). Main makes
 * the audio; this store plays it through one VoicePlayer and tells each
 * button whether it is the one speaking.
 */
import { useSyncExternalStore } from 'react'
import type { VoiceSpeakRequest } from '@shared/ipc/schemas/voice'
import { parseVoiceIpcCode, type VoiceErrorCode } from '@shared/voice'
import { VoicePlayer, type PlayerAudioContext } from './voicePlayer'

export type SpeechState = {
  /** Who asked: e.g. `answer:<run>` or `preview`. Null when quiet. */
  owner: string | null
  phase: 'idle' | 'starting' | 'playing'
  /** The last failure, for the owner that hit it. */
  error: { owner: string; code: VoiceErrorCode | null; message: string } | null
}

let state: SpeechState = { owner: null, phase: 'idle', error: null }
const listeners = new Set<() => void>()
let utteranceId: string | null = null
/** Main said the utterance ended; idle once the player has drained too. */
let mainDone = false
let player: VoicePlayer | null = null
let unsubscribe: (() => void) | null = null
let createContext: (() => PlayerAudioContext) | undefined

function set(next: Partial<SpeechState>): void {
  state = { ...state, ...next }
  for (const l of listeners) l()
}

function finishIfDrained(): void {
  if (mainDone && !(player?.playing ?? false)) {
    utteranceId = null
    set({ owner: null, phase: 'idle' })
  }
}

function ensureWired(): VoicePlayer {
  if (!player) {
    player = new VoicePlayer({
      createContext,
      onIdle: finishIfDrained,
      onContextStart: () => set({ phase: 'playing' })
    })
  }
  if (!unsubscribe && window.vyotiq?.onVoiceAudioOut) {
    const offAudio = window.vyotiq.onVoiceAudioOut((chunk) => {
      if (chunk.utteranceId !== utteranceId) return
      player?.enqueue({ pcm: chunk.pcm, sampleRate: chunk.sampleRate, contextId: chunk.utteranceId })
    })
    const offEnd = window.vyotiq.onVoiceSpeakEnd((end) => {
      if (end.utteranceId !== utteranceId) return
      mainDone = true
      if (end.error && state.owner) {
        set({ error: { owner: state.owner, code: end.error, message: describeSpeechError(end.error, end.detail) } })
        player?.cancel(end.utteranceId)
      }
      finishIfDrained()
    })
    unsubscribe = () => {
      offAudio()
      offEnd()
    }
  }
  return player
}

/** Our sentence, then the provider's own reason when there is one (D-40). */
export function describeSpeechError(code: VoiceErrorCode | null, detail?: string): string {
  const words = speechErrorWords(code)
  return detail ? `${words} ${detail}` : words
}

function speechErrorWords(code: VoiceErrorCode | null): string {
  switch (code) {
    case 'no_key':
      return 'Add a key for a speaking provider in Settings → Voice to hear it.'
    case 'rejected_key':
      return 'The speaking provider rejected its key. Check it in Settings → Voice.'
    case 'out_of_credit':
      return 'The speaking provider says this account is out of credit.'
    case 'rate_limited':
      return 'The speaking provider is busy. Try again in a moment.'
    case 'offline':
    case 'provider_down':
      return 'Couldn’t reach the speaking provider.'
    default:
      return 'It couldn’t be read aloud.'
  }
}

export async function speakText(owner: string, req: VoiceSpeakRequest): Promise<void> {
  ensureWired()
  stopSpeech()
  set({ owner, phase: 'starting', error: null })
  mainDone = false
  const res = await window.vyotiq.voiceSpeak(req)
  // Another request may have started while this one was on its way.
  if (state.owner !== owner || state.phase !== 'starting') {
    if (res.ok) void window.vyotiq.voiceStopSpeaking({ utteranceId: res.data.utteranceId })
    return
  }
  if (!res.ok) {
    const code = parseVoiceIpcCode(res.code)
    set({ owner: null, phase: 'idle', error: { owner, code, message: describeSpeechError(code) } })
    return
  }
  utteranceId = res.data.utteranceId
}

export function stopSpeech(): void {
  const id = utteranceId
  utteranceId = null
  mainDone = true
  if (id) {
    player?.cancel(id)
    void window.vyotiq.voiceStopSpeaking?.({ utteranceId: id })
  }
  if (state.owner) set({ owner: null, phase: 'idle' })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function snapshot(): SpeechState {
  return state
}

export function useSpeech(owner: string): {
  active: boolean
  phase: SpeechState['phase']
  error: string | null
} {
  const s = useSyncExternalStore(subscribe, snapshot, snapshot)
  return {
    active: s.owner === owner,
    phase: s.owner === owner ? s.phase : 'idle',
    error: s.error?.owner === owner ? s.error.message : null
  }
}

/** Tests only: reset module state, optionally with a fake audio context. */
export function resetSpeechForTests(factory?: () => PlayerAudioContext): void {
  createContext = factory
  unsubscribe?.()
  unsubscribe = null
  void player?.close()
  player = null
  utteranceId = null
  mainDone = false
  state = { owner: null, phase: 'idle', error: null }
}
