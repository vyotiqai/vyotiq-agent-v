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
  pcm16kToWav,
  OPENROUTER_REFERER,
  OPENROUTER_TITLE,
  OPENROUTER_TRANSCRIBE_MODEL,
  OPENROUTER_TRANSCRIBE_URL,
  transcribeDictation
} from '@main/dictation/transcribe'
import { resetDictationLocalStateForTests } from '@main/dictation/local'
import { resetDictationRuntimeStatusForTests } from '@main/dictation/modelStatus'
import { DEFAULT_SETTINGS, MAX_DICTATION_BYTES, type DictationEngine, type DictationErrorCode } from '@shared/ipc'
import { DictationError } from '@main/dictation/errors'

/** The failure as the take sees it: its code, not its wording. */
async function failure(p: Promise<unknown>): Promise<{ code: DictationErrorCode; message: string }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(DictationError)
    const e = err as DictationError
    return { code: e.code, message: e.message }
  }
  throw new Error('expected a DictationError')
}

function okResponse(text: string) {
  return { ok: true, status: 200, text: async () => JSON.stringify({ text }) }
}

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
    expect((await failure(transcribeDictation({ data, mime: 'audio/webm' }))).code).toBe('too_long')
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('errors when OpenAI key is missing', async () => {
    getSecretMock.mockReturnValue(null)
    const f = await failure(transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' }))
    expect(f.code).toBe('no_key')
    expect(f.message).toMatch(/OpenAI key/)
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
    const f = await failure(transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' }))
    expect(f.code).toBe('no_key')
    expect(f.message).toMatch(/OpenRouter key/)
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
    const f = await failure(transcribeDictation({ data: Buffer.from('hi').toString('base64'), mime: 'audio/webm' }))
    expect(f.code).toBe('engine_failed')
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('local engine rejects when no Whisper cache is installed', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('local', 'whisper-tiny.en'))
    const pcm = Buffer.from([0, 0, 1, 0]).toString('base64')
    const f = await failure(transcribeDictation({ mime: 'audio/wav', pcm16k: pcm }))
    expect(f.code).toBe('model_missing')
    expect(fetchWithRetryMock).not.toHaveBeenCalled()
  })

  it('sends a take segment to the cloud as a 16 kHz mono WAV', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue(okResponse('segment words'))
    const pcm = Buffer.from(new Int16Array([0, 1000, -1000, 32767]).buffer)
    const result = await transcribeDictation({ mime: 'audio/wav', pcm16k: pcm.toString('base64') })
    expect(result).toEqual({ text: 'segment words' })
    const form = fetchWithRetryMock.mock.calls[0]![1].body as FormData
    const file = form.get('file') as File
    expect(file.type).toBe('audio/wav')
    expect(file.name).toBe('dictation.wav')
    const bytes = Buffer.from(await file.arrayBuffer())
    expect(bytes.subarray(0, 4).toString('ascii')).toBe('RIFF')
    expect(bytes.subarray(8, 12).toString('ascii')).toBe('WAVE')
    expect(bytes.readUInt32LE(24)).toBe(16000)
    expect(bytes.readUInt16LE(22)).toBe(1)
    expect(bytes.readUInt32LE(40)).toBe(pcm.byteLength)
    expect(bytes.subarray(44).equals(pcm)).toBe(true)
  })

  it('pcm16kToWav writes a 44-byte header in front of the samples', () => {
    const wav = pcm16kToWav(Buffer.alloc(320))
    expect(wav.byteLength).toBe(364)
    expect(wav.readUInt32LE(4)).toBe(36 + 320)
    expect(wav.readUInt16LE(34)).toBe(16)
  })

  it('passes the language hint through', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue(okResponse('hola'))
    await transcribeDictation({ mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64'), language: 'es' })
    const form = fetchWithRetryMock.mock.calls[0]![1].body as FormData
    expect(form.get('language')).toBe('es')
  })

  it('sends the words before a segment as the prompt, and none when there are none', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue(okResponse('then run the tests'))
    await transcribeDictation({
      mime: 'audio/wav',
      pcm16k: Buffer.alloc(4).toString('base64'),
      prompt: 'Open the settings page.'
    })
    await transcribeDictation({ mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64') })
    expect((fetchWithRetryMock.mock.calls[0]![1].body as FormData).get('prompt')).toBe('Open the settings page.')
    expect((fetchWithRetryMock.mock.calls[1]![1].body as FormData).get('prompt')).toBeNull()
  })

  it('sends workspace names as keywords to OpenAI, and neither prompt nor keywords to OpenRouter', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue(okResponse('open take controller'))
    const req = { mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64'), prompt: 'Before.' }
    await transcribeDictation(req, undefined, { keywords: ['takeController', 'VoiceSection'] })
    await transcribeDictation({ ...req, engine: 'openrouter' }, undefined, { keywords: ['takeController'] })
    const openai = fetchWithRetryMock.mock.calls[0]![1].body as FormData
    expect(openai.getAll('keywords[]')).toEqual(['takeController', 'VoiceSection'])
    expect(openai.get('prompt')).toBe('Before.')
    // OpenRouter accepts a prompt and ignores it; sending one would only look like it helps.
    const openrouter = fetchWithRetryMock.mock.calls[1]![1].body as FormData
    expect(openrouter.get('prompt')).toBeNull()
    expect(openrouter.getAll('keywords[]')).toEqual([])
  })

  it('uses the request engine over the one in settings (a failed take tried elsewhere)', async () => {
    getSettingsMock.mockReturnValue(settingsWithEngine('local'))
    getSecretMock.mockImplementation((provider: string) => (provider === 'openrouter' ? 'or-key' : null))
    fetchWithRetryMock.mockResolvedValue(okResponse('from override'))
    const result = await transcribeDictation({
      mime: 'audio/wav',
      pcm16k: Buffer.alloc(4).toString('base64'),
      engine: 'openrouter'
    })
    expect(result.text).toBe('from override')
    expect(fetchWithRetryMock.mock.calls[0]![0]).toBe(OPENROUTER_TRANSCRIBE_URL)
  })

  it.each([
    [401, 'rejected_key'],
    [403, 'rejected_key'],
    [429, 'rate_limited'],
    [413, 'too_long'],
    [500, 'engine_failed']
  ] as const)('maps HTTP %i to %s', async (status, code) => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue({
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { message: 'Provider says no' } })
    })
    const f = await failure(transcribeDictation({ mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64') }))
    expect(f.code).toBe(code)
    if (code === 'engine_failed') expect(f.message).toContain('Provider says no')
  })

  it('reports a network failure as offline', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockRejectedValue(new TypeError('fetch failed'))
    const f = await failure(transcribeDictation({ mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64') }))
    expect(f.code).toBe('offline')
  })

  it('lets an abort through as an abort, not a failure', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    await expect(
      transcribeDictation({ mime: 'audio/wav', pcm16k: Buffer.alloc(4).toString('base64') })
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('answers silence with empty text when the segment allows it, and fails when it does not', async () => {
    getSecretMock.mockReturnValue('sk-test')
    fetchWithRetryMock.mockResolvedValue(okResponse('   '))
    const pcm16k = Buffer.alloc(4).toString('base64')
    await expect(transcribeDictation({ mime: 'audio/wav', pcm16k, allowEmpty: true })).resolves.toEqual({ text: '' })
    expect((await failure(transcribeDictation({ mime: 'audio/wav', pcm16k }))).code).toBe('engine_failed')
  })
})
