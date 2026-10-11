/**
 * Provider id → adapter. The voice session and the speaker ask here and
 * never import a vendor file (docs/voice-mode.md §4, §9.6). Under
 * `VYOTIQ_E2E_FIXTURE=1` every provider is the scripted fixture, so end-to-end
 * tests never need keys or a network.
 */
import type { TtsProviderId } from '../../../shared/voice'
import { openFixtureTts } from './fixture'
import { makeCartesiaTts } from './tts/cartesia'
import { makeElevenLabsTts } from './tts/elevenlabs'
import { OPENAI_VOICES, makeOpenAiCompatibleTts } from './tts/openaiSpeech'
import type { TtsProvider } from './types'

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
