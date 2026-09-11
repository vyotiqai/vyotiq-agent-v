import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getSecretMock = vi.hoisted(() => vi.fn())
const getSettingsMock = vi.hoisted(() => vi.fn())
const fetchWithRetryMock = vi.hoisted(() => vi.fn())

vi.mock('@main/settings/secrets', () => ({
  getSecret: getSecretMock
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: getSettingsMock,
  setSettings: vi.fn()
}))

vi.mock('@main/agent/providers/fetchWithRetry', () => ({
  fetchWithRetry: fetchWithRetryMock
}))

import {
  DICTATION_FIXTURE_TEXT,
  isDictationFixtureEnabled,
  OPENROUTER_REFERER,
  OPENROUTER_TITLE,
  OPENROUTER_TRANSCRIBE_MODEL,
  OPENROUTER_TRANSCRIBE_URL,
  transcribeDictation
} from '@main/dictation/transcribe'
import { resetDictationLocalStateForTests } from '@main/dictation/local'
import { resetDictationRuntimeStatusForTests } from '@main/dictation/modelStatus'
import { DEFAULT_SETTINGS, MAX_DICTATION_BYTES, type DictationEngine } from '@shared/ipc'

function settingsWithEngine(
  engine: DictationEngine,
  localModelId = '',
  dictationOverride: Record<string, unknown> = {}
) {
  return {
    ...DEFAULT_SETTINGS,
    dictation: {
      ...DEFAULT_SETTINGS.dictation,
      engine,
      localModelId,
      ...dictationOverride
    }
  }
}

describe('transcribeDictation', () => {
  const prevFixture = process.env.VYOTIQ_E2E_FIXTURE
  const prevVitest = process.env.VITEST

  beforeEach(() => {
    getSecretMock.mockReset()
    getSettingsMock.mockReset()
    fetchWithRetryMock.mockReset()
    process.env.VITEST = 'true'
    delete process.env.VYOTIQ_E2E_FIXTURE
    getSettingsMock.mockReturnValue(settingsWithEngine('openai'))
  })

  afterEach(() => {
    resetDictationLocalStateForTests()
    resetDictationRuntimeStatusForTests()
    if (prevFixture === undefined) delete process.env.VYOTIQ_E2E_FIXTURE
    else process.env.VYOTIQ_E2E_FIXTURE = prevFixture
    if (prevVitest === undefined) delete process.env.VITEST
    else process.env.VITEST = prevVitest
  })

  it('rejects oversized audio before calling the network', async () => {
    getSecretMock.mockReturnValue('sk-test')
    const data = Buffer.alloc(MAX_DICTATION_BYTES + 1).toString('base64')
    await expect(transcribeDictation({ data, mime: 'audio/webm' })).rejects.toThrow(/exceeds/)
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('errors when OpenAI key is missing', async () => {
    getSecretMock.mockReturnValue(null)
    await expect(
      transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' })
    ).rejects.toThrow(/OpenAI API key/i)
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('posts FormData to /audio/transcriptions with gpt-transcribe', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ text: ' hello world ' })
    })
    const result = await transcribeDictation({
      data: Buffer.from('fake-audio').toString('base64'),
      mime: 'audio/webm'
    })
    expect(result).toEqual({ text: 'hello world' })
    expect(fetchWithRetryMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchWithRetryMock.mock.calls[0]!
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
    expect(init.body).toBeInstanceOf(FormData)
    const form = init.body as FormData
    expect(form.get('model')).toBe('gpt-transcribe')
    expect(form.get('file')).toBeTruthy()
  })

  it('posts OpenRouter transcriptions with pinned model and Referer/X-Title', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('openrouter'))
    getSecretMock.mockImplementation((provider: string) =>
      provider === 'openrouter' ? 'or-key' : null
    )
    fetchWithRetryMock.mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ text: 'from openrouter' })
    })
    const result = await transcribeDictation({
      data: Buffer.from('fake-audio').toString('base64'),
      mime: 'audio/webm'
    })
    expect(result).toEqual({ text: 'from openrouter' })
    const [url, init] = fetchWithRetryMock.mock.calls[0]!
    expect(url).toBe(OPENROUTER_TRANSCRIBE_URL)
    expect(init.headers.Authorization).toBe('Bearer or-key')
    expect(init.headers['HTTP-Referer']).toBe(OPENROUTER_REFERER)
    expect(init.headers['X-Title']).toBe(OPENROUTER_TITLE)
    const form = init.body as FormData
    expect(form.get('model')).toBe(OPENROUTER_TRANSCRIBE_MODEL)
  })

  it('errors when OpenRouter key is missing', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('openrouter'))
    getSecretMock.mockReturnValue(null)
    await expect(
      transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' })
    ).rejects.toThrow(/OpenRouter API key/i)
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('isDictationFixtureEnabled stays off under Vitest', () => {
    process.env.VYOTIQ_E2E_FIXTURE = '1'
    process.env.VITEST = 'true'
    expect(isDictationFixtureEnabled()).toBe(false)
  })

  it('returns fixture text when e2e fixture is on outside Vitest', async () => {
    process.env.VITEST = 'false'
    process.env.VYOTIQ_E2E_FIXTURE = '1'
    const result = await transcribeDictation({
      data: Buffer.from('x').toString('base64'),
      mime: 'audio/webm'
    })
    expect(result).toEqual({ text: DICTATION_FIXTURE_TEXT })
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('local engine rejects missing PCM without calling the cloud', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('local'))
    await expect(
      transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' })
    ).rejects.toThrow(/16 kHz PCM/i)
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('local engine rejects when no Whisper cache is installed', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('local', 'whisper-tiny.en'))
    const pcm = Buffer.from([0, 0, 1, 0]).toString('base64')
    await expect(
      transcribeDictation({
        data: Buffer.from('hi').toString('base64'),
        mime: 'audio/webm',
        pcm16k: pcm
      })
    ).rejects.toThrow(/Settings → Voice/)
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })
})
