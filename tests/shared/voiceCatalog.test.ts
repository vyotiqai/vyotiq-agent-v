import { describe, expect, it } from 'vitest'
import {
  STT_CATALOG,
  STT_PROVIDER_IDS,
  TTS_CATALOG,
  TTS_PROVIDER_IDS,
  clampSpeed,
  isRetryableVoiceError,
  parseVoiceIpcCode,
  resolveModel,
  resolveSttProvider,
  resolveTtsProvider,
  voiceErrorFromStatus,
  voiceIpcCode,
  type VoiceKeyAvailability
} from '@shared/voice'
import { DEFAULT_VOICE_SETTINGS, VoiceSettingsSchema } from '@shared/ipc/schemas/voice'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc/schemas/settings'

const none: VoiceKeyAvailability = { voice: {}, chat: {} }
const openaiOnly: VoiceKeyAvailability = { voice: {}, chat: { openai: true } }

describe('voice provider catalog', () => {
  it('has exactly one entry per provider id, each with a recommended model', () => {
    expect(STT_CATALOG.map((e) => e.id).sort()).toEqual([...STT_PROVIDER_IDS].sort())
    expect(TTS_CATALOG.map((e) => e.id).sort()).toEqual([...TTS_PROVIDER_IDS].sort())
    for (const e of [...STT_CATALOG, ...TTS_CATALOG]) {
      expect(e.models.length).toBeGreaterThan(0)
      expect(e.models.filter((m) => m.recommended)).toHaveLength(1)
      expect(e.privacy).toMatch(/goes to|stays on/)
    }
  })

  it('gives every TTS provider a sane speed range that includes 1×', () => {
    for (const e of TTS_CATALOG) {
      const [min, max] = e.caps.speed
      expect(min).toBeLessThanOrEqual(1)
      expect(max).toBeGreaterThanOrEqual(1)
    }
  })
})

describe('choosing a provider (§9.5)', () => {
  it('auto picks the first provider in order that has a key', () => {
    expect(resolveSttProvider('auto', { voice: { assemblyai: true }, chat: { openai: true } })).toEqual({
      ok: true,
      id: 'assemblyai'
    })
    expect(resolveTtsProvider('auto', { voice: { cartesia: true, elevenlabs: true }, chat: {} })).toEqual({
      ok: true,
      id: 'elevenlabs'
    })
  })

  it('works on an OpenAI key alone, for both directions (D-13)', () => {
    expect(resolveSttProvider('auto', openaiOnly)).toEqual({ ok: true, id: 'openai' })
    expect(resolveTtsProvider('auto', openaiOnly)).toEqual({ ok: true, id: 'openai' })
  })

  it('honours an explicit pick, and says so when it had to fall back', () => {
    const keys: VoiceKeyAvailability = { voice: { deepgram: true }, chat: { openai: true } }
    expect(resolveSttProvider('openai', keys)).toEqual({ ok: true, id: 'openai' })
    expect(resolveTtsProvider('elevenlabs', keys)).toEqual({ ok: true, id: 'openai', fellBackFrom: 'elevenlabs' })
  })

  it('never picks the local listener automatically, but honours it when chosen', () => {
    expect(resolveSttProvider('auto', none)).toEqual({ ok: false, reason: 'no_key' })
    expect(resolveSttProvider('local', none)).toEqual({ ok: true, id: 'local' })
  })

  it('reports no_key when nothing is usable', () => {
    expect(resolveTtsProvider('auto', none)).toEqual({ ok: false, reason: 'no_key' })
  })

  it('falls back to the recommended model when a stored pick is no longer listed', () => {
    const models = STT_CATALOG.find((e) => e.id === 'deepgram')!.models
    expect(resolveModel(models, 'flux-general-multi')).toBe('flux-general-multi')
    expect(resolveModel(models, 'nova-1')).toBe('flux-general-en')
    expect(resolveModel(models, undefined)).toBe('flux-general-en')
  })

  it('clamps speed into the provider range', () => {
    expect(clampSpeed(3, [0.7, 1.2])).toBe(1.2)
    expect(clampSpeed(0.1, [0.7, 1.2])).toBe(0.7)
    expect(clampSpeed(Number.NaN, [0.7, 1.2])).toBe(1)
  })
})

describe('voice errors', () => {
  it('round-trips through the IPC code and rejects foreign codes', () => {
    expect(parseVoiceIpcCode(voiceIpcCode('out_of_credit'))).toBe('out_of_credit')
    expect(parseVoiceIpcCode('dictation:no_key')).toBeNull()
    expect(parseVoiceIpcCode('voice:made_up')).toBeNull()
    expect(parseVoiceIpcCode(undefined)).toBeNull()
  })

  it('maps HTTP statuses the same way for every adapter', () => {
    expect(voiceErrorFromStatus(401)).toBe('rejected_key')
    expect(voiceErrorFromStatus(402)).toBe('out_of_credit')
    expect(voiceErrorFromStatus(429)).toBe('rate_limited')
    expect(voiceErrorFromStatus(503)).toBe('provider_down')
    expect(voiceErrorFromStatus(400)).toBe('engine_failed')
  })

  it('only marks transient failures as retryable', () => {
    expect(isRetryableVoiceError('offline')).toBe(true)
    expect(isRetryableVoiceError('rejected_key')).toBe(false)
    expect(isRetryableVoiceError('out_of_credit')).toBe(false)
  })
})

describe('voice settings', () => {
  it('defaults match the schema defaults', () => {
    expect(VoiceSettingsSchema.parse({})).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('is part of Settings and defaults when missing from an older file', () => {
    const { voice: _dropped, ...older } = DEFAULT_SETTINGS
    const parsed = SettingsSchema.parse(older)
    expect(parsed.voice).toEqual(DEFAULT_VOICE_SETTINGS)
  })

  it('drops unknown provider ids in the per-provider records instead of failing', () => {
    const parsed = VoiceSettingsSchema.safeParse({ tts: { elevenlabs: { voiceId: 'abc' } } })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.tts.elevenlabs?.voiceId).toBe('abc')
  })
})
