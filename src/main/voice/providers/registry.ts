/**
 * Provider id → adapter. The voice session and the speaker ask here and
 * never import a vendor file (docs/voice-mode.md §4, §9.6). Under
 * `VYOTIQ_E2E_FIXTURE=1` every provider is the scripted fixture, so end-to-end
 * tests never need keys or a network.
 */
import type { SttProviderId, TtsProviderId } from '../../../shared/voice'
import { fixtureTurnsFromEnv, openFixtureStt, openFixtureTts } from './fixture'
import { assemblyAi } from './stt/assemblyai'
import { deepgramFlux } from './stt/deepgramFlux'
import { elevenLabsScribe } from './stt/elevenlabsScribe'
import { makeLocalStt } from './stt/local'
import { openAiRealtime } from './stt/openaiRealtime'
import { makeCartesiaTts } from './tts/cartesia'
import { makeElevenLabsTts } from './tts/elevenlabs'
import { OPENAI_VOICES, makeOpenAiCompatibleTts } from './tts/openaiSpeech'
import type { SttProvider, TtsProvider } from './types'

const fixtureTts = (id: TtsProviderId): TtsProvider => ({
  id,
  listVoices: async () => [...OPENAI_VOICES],
  stream: (opts) => openFixtureTts(opts)
})

let overrides: Partial<Record<TtsProviderId, TtsProvider>> = {}

export function isVoiceFixtureMode(): boolean {
  return process.env.VYOTIQ_E2E_FIXTURE === '1'
}

export function ttsProvider(id: TtsProviderId): TtsProvider {
  const override = overrides[id]
  if (override) return override
  if (isVoiceFixtureMode()) return fixtureTts(id)
  switch (id) {
    case 'elevenlabs':
      return makeElevenLabsTts()
    case 'cartesia':
      return makeCartesiaTts()
    case 'openai':
    case 'openrouter':
      return makeOpenAiCompatibleTts(id)
  }
}

export function setTtsProviderForTests(id: TtsProviderId, provider: TtsProvider | null): void {
  if (provider) overrides = { ...overrides, [id]: provider }
  else {
    const next = { ...overrides }
    delete next[id]
    overrides = next
  }
}

// ── Speech to text ──────────────────────────────────────────────────────────

let sttOverrides: Partial<Record<SttProviderId, SttProvider>> = {}

const fixtureStt = (id: SttProviderId): SttProvider => ({ id, open: (opts) => openFixtureStt(opts, fixtureTurnsFromEnv()) })

export function sttProvider(id: SttProviderId): SttProvider {
  const override = sttOverrides[id]
  if (override) return override
  if (isVoiceFixtureMode()) return fixtureStt(id)
  switch (id) {
    case 'deepgram':
      return deepgramFlux
    case 'assemblyai':
      return assemblyAi
    case 'elevenlabs':
      return elevenLabsScribe
    case 'openai':
      return openAiRealtime
    case 'local':
      return makeLocalStt()
  }
}

export function setSttProviderForTests(id: SttProviderId, provider: SttProvider | null): void {
  if (provider) sttOverrides = { ...sttOverrides, [id]: provider }
  else {
    const next = { ...sttOverrides }
    delete next[id]
    sttOverrides = next
  }
}
