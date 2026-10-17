import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keyState = vi.hoisted(() => ({ key: 'sk-test-123456' as string | null }))

vi.mock('@main/voice/keys', () => ({
  readVoiceSourceKey: () => keyState.key,
  requireVoiceSourceKey: () => keyState.key ?? '',
  voiceKeyAvailability: () => ({ voice: { elevenlabs: true }, chat: { openai: true, openrouter: true } })
}))

import {
  cachedModelVoices,
  FAILED_RETRY_MS,
  formatUsd,
  listVoiceModels,
  openRouterCredit,
  openRouterPrice,
  setModelCatalogFetchForTests
} from '@main/voice/modelCatalog'
import { listVoices } from '@main/voice/speaker'
import { chooseModel, pickVoice, sttEntry, ttsEntry } from '@shared/voice'

/** OpenRouter's public list, shaped as it answered on 2026-10-14. */
const OPENROUTER_SPEECH = {
  data: [
    {
      id: 'elevenlabs/eleven-flash-v2.5',
      name: 'ElevenLabs: Eleven Flash v2.5',
      pricing: { prompt: '0.00002', completion: '0' },
      supported_voices: ['george', 'sarah', 'adam']
    },
    { id: 'google/gemini-3.8-flash-tts', name: 'Google: Gemini 3.8 Flash TTS', pricing: { prompt: '0.0000005', completion: '0.000009' }, supported_voices: ['Zephyr', 'Puck'] },
    { id: 'fish-audio/s2.1-pro-free:free', name: 'Fish Audio: S2.1 Pro (free)', pricing: { prompt: '0', completion: '0' }, supported_voices: [] }
  ]
}
const OPENROUTER_STT = {
  data: [
    { id: 'whisper-fast', name: 'Whisper Fast', pricing: { prompt: '0.00000333', completion: '0' } },
    { id: 'openai/gpt-transcribe', name: 'OpenAI: GPT Transcribe', pricing: { prompt: '0.000075', completion: '0' } },
    { id: 'microsoft/mai-transcribe-2', name: 'MAI-Transcribe 2', pricing: { prompt: '0.1', completion: '0' } }
  ]
}

let calls: Array<{ url: string; headers: Record<string, string> }> = []
let respond: (url: string) => Response

beforeEach(() => {
  keyState.key = 'sk-test-123456'
  calls = []
  respond = (url) =>
    url.includes('output_modalities=speech')
      ? Response.json(OPENROUTER_SPEECH)
      : url.includes('output_modalities=transcription')
        ? Response.json(OPENROUTER_STT)
        : new Response('not found', { status: 404 })
  setModelCatalogFetchForTests(
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> })
      return respond(url)
    }) as unknown as typeof fetch
  )
})

afterEach(() => setModelCatalogFetchForTests(null))

describe('prices', () => {
  it('reads OpenRouter speech as per character and transcription as per second', () => {
    expect(openRouterPrice('tts', { prompt: '0.00002', completion: '0' })).toBe('$0.02 / 1k characters')
    expect(openRouterPrice('tts', { prompt: '0.00000062', completion: '0' })).toBe('$0.00062 / 1k characters')
    expect(openRouterPrice('stt', { prompt: '0.000075', completion: '0' })).toBe('$0.0045 / min')
  })

  it('shows no price when the unit is unclear, rather than a wrong one', () => {
    // Token-priced (Gemini) and per-second figures that can't be per second ($6/min).
    expect(openRouterPrice('tts', { prompt: '0.0000005', completion: '0.000009' })).toBeUndefined()
    expect(openRouterPrice('stt', { prompt: '0.1', completion: '0' })).toBeUndefined()
    expect(openRouterPrice('tts', { prompt: '0', completion: '0' })).toBe('Free')
  })

  it('formats dollars at a readable precision', () => {
    expect(formatUsd(1.5)).toBe('$1.50')
    expect(formatUsd(0.02)).toBe('$0.02')
    expect(formatUsd(0.0045)).toBe('$0.0045')
  })
})

describe('listVoiceModels', () => {
  it('fetches OpenRouter speech models without a key, recommended first, with voices per model', async () => {
    keyState.key = null
    const list = await listVoiceModels('tts', 'openrouter')
    expect(calls[0]!.url).toBe('https://openrouter.ai/api/v1/models?output_modalities=speech')
    expect(calls[0]!.headers).toEqual({})
    expect(list.source).toBe('api')
    expect(list.models.map((m) => m.id)).toEqual(['elevenlabs/eleven-flash-v2.5', 'google/gemini-3.8-flash-tts', 'fish-audio/s2.1-pro-free:free'])
    expect(list.models[0]).toMatchObject({ recommended: true, price: '$0.02 / 1k characters' })
    expect(list.models[1]!.price).toBeUndefined()
    expect(cachedModelVoices('openrouter', 'google/gemini-3.8-flash-tts')).toEqual(['Zephyr', 'Puck'])
    expect(cachedModelVoices('openrouter', 'not/listed')).toBeNull()
  })

  it('fetches OpenRouter transcription models for listening', async () => {
    const list = await listVoiceModels('stt', 'openrouter')
    expect(calls[0]!.url).toContain('output_modalities=transcription')
    expect(list.models[0]).toMatchObject({ id: 'openai/gpt-transcribe', recommended: true, price: '$0.0045 / min' })
  })

  it('caches for a day, and refresh fetches again', async () => {
    await listVoiceModels('tts', 'openrouter')
    await listVoiceModels('tts', 'openrouter')
    expect(calls).toHaveLength(1)
    await listVoiceModels('tts', 'openrouter', true)
    expect(calls).toHaveLength(2)
  })

  it('a failed fetch returns the curated models with the reason', async () => {
    respond = () => new Response('{"error":{"message":"Service unavailable"}}', { status: 503 })
    const list = await listVoiceModels('tts', 'openrouter')
    expect(list).toMatchObject({ source: 'curated', error: 'provider_down' })
    expect(list.detail).toContain('OpenRouter model list (503)')
    expect(list.models.map((m) => m.id)).toEqual(['elevenlabs/eleven-flash-v2.5'])
  })

  it('a fetch that just failed isn’t asked again until a minute passes, or Refresh (2026-10-16 audit 3, A14)', async () => {
    respond = () => new Response('', { status: 503 })
    const first = await listVoiceModels('tts', 'openrouter')
    const second = await listVoiceModels('tts', 'openrouter')
    expect(calls).toHaveLength(1)
    // The same answer, reason included.
    expect(second).toEqual(first)
    await listVoiceModels('tts', 'openrouter', true)
    expect(calls).toHaveLength(2)
    vi.useFakeTimers({ now: Date.now() + FAILED_RETRY_MS + 1 })
    try {
      await listVoiceModels('tts', 'openrouter')
    } finally {
      vi.useRealTimers()
    }
    expect(calls).toHaveLength(3)
  })

  it('a failed refresh keeps serving the last list, and says so', async () => {
    await listVoiceModels('tts', 'openrouter')
    respond = () => new Response('', { status: 502 })
    const list = await listVoiceModels('tts', 'openrouter', true)
    expect(list.source).toBe('api')
    expect(list.models).toHaveLength(3)
    expect(list.error).toBe('provider_down')
  })

  it('OpenAI: lists speech or transcription models with your key', async () => {
    respond = () =>
      Response.json({ data: [{ id: 'gpt-4o' }, { id: 'tts-1' }, { id: 'gpt-4o-mini-tts' }, { id: 'gpt-4o-transcribe' }, { id: 'whisper-1' }, { id: 'gpt-live-transcribe' }] })
    const speak = await listVoiceModels('tts', 'openai')
    expect(calls[0]).toEqual({ url: 'https://api.openai.com/v1/models', headers: { Authorization: 'Bearer sk-test-123456' } })
    expect(speak.models.map((m) => m.id)).toEqual(['gpt-4o-mini-tts', 'tts-1'])
    const listen = await listVoiceModels('stt', 'openai')
    expect(listen.models.map((m) => m.id)).toEqual(['gpt-live-transcribe', 'gpt-4o-transcribe', 'whisper-1'])
  })

  it('OpenAI without a key: the curated models, no request', async () => {
    keyState.key = null
    const list = await listVoiceModels('tts', 'openai')
    expect(calls).toHaveLength(0)
    expect(list).toEqual({ source: 'curated', models: [{ id: 'gpt-4o-mini-tts', label: 'GPT-4o mini TTS', recommended: true }] })
  })

  it('ElevenLabs: its speaking models only', async () => {
    respond = () =>
      Response.json([
        { model_id: 'eleven_flash_v2_5', name: 'Eleven Flash v2.5', can_do_text_to_speech: true },
        { model_id: 'eleven_english_sts_v2', name: 'Speech to speech', can_do_text_to_speech: false }
      ])
    const list = await listVoiceModels('tts', 'elevenlabs')
    expect(calls[0]!.headers).toEqual({ 'xi-api-key': 'sk-test-123456' })
    expect(list.models).toEqual([{ id: 'eleven_flash_v2_5', label: 'Eleven Flash v2.5', recommended: true }])
  })

  it('a curated provider is never fetched', async () => {
    const list = await listVoiceModels('stt', 'deepgram')
    expect(calls).toHaveLength(0)
    expect(list.source).toBe('curated')
  })
})

describe('OpenRouter credit (A-08)', () => {
  const keyAnswers = (data: Record<string, unknown>, status = 200) => {
    respond = (url) => (url.endsWith('/api/v1/key') ? Response.json({ data }, { status }) : new Response('', { status: 404 }))
  }

  it('asks /api/v1/key with the key; a paid account with no key limit is ok', async () => {
    keyAnswers({ is_free_tier: false, limit: null, limit_remaining: null, usage: 50.5 })
    expect(await openRouterCredit()).toEqual({ status: 'ok' })
    expect(calls[0]).toEqual({ url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: 'Bearer sk-test-123456' } })
  })

  it('warns for an account that never bought credit, or a key limit under $0.50', async () => {
    keyAnswers({ is_free_tier: true, limit_remaining: null })
    expect(await openRouterCredit()).toEqual({ status: 'low', reason: 'never_paid' })
    keyAnswers({ is_free_tier: false, limit_remaining: 0.12 })
    expect(await openRouterCredit()).toEqual({ status: 'low', reason: 'key_limit', keyRemaining: 0.12 })
    keyAnswers({ is_free_tier: false, limit_remaining: 3 })
    expect(await openRouterCredit()).toEqual({ status: 'ok', keyRemaining: 3 })
  })

  it('no key or no answer is unknown, never an error', async () => {
    keyAnswers({}, 500)
    expect(await openRouterCredit()).toEqual({ status: 'unknown' })
    keyState.key = null
    calls = []
    expect(await openRouterCredit()).toEqual({ status: 'unknown' })
    expect(calls).toHaveLength(0)
  })
})

describe('choosing a model and a voice', () => {
  it('honours any model a listing provider named; curated providers keep to their list', () => {
    expect(chooseModel(ttsEntry('openrouter'), 'hexgrad/kokoro-82m')).toBe('hexgrad/kokoro-82m')
    expect(chooseModel(ttsEntry('openrouter'), undefined)).toBe('elevenlabs/eleven-flash-v2.5')
    expect(chooseModel(sttEntry('deepgram'), 'nova-3')).toBe('flux-general-en')
  })

  it('never sends a voice the model refuses (A-06)', () => {
    expect(pickVoice(['george', 'sarah'], 'alloy', 'sarah')).toBe('sarah')
    expect(pickVoice(['Zephyr', 'Puck'], 'alloy', 'sarah')).toBe('Zephyr')
    expect(pickVoice(['george', 'sarah'], 'george', 'sarah')).toBe('george')
    // Unknown voices (no list): the pick stands.
    expect(pickVoice(null, 'alloy', 'sarah')).toBe('alloy')
  })

  it('lists the chosen OpenRouter model’s own voices', async () => {
    const voices = await listVoices('openrouter', false, 'google/gemini-3.8-flash-tts')
    expect(voices).toEqual([
      { id: 'Zephyr', label: 'Zephyr' },
      { id: 'Puck', label: 'Puck' }
    ])
    const def = await listVoices('openrouter')
    expect(def.map((v) => v.label)).toEqual(['George', 'Sarah', 'Adam'])
  })
})
