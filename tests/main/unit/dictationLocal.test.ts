import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  DICTATION_MOONSHINE_REQUIRED_FILES,
  DICTATION_WHISPER_REQUIRED_FILES,
  DICTATION_WHISPER_OPTIONAL_FILES
} from '@main/dictation/catalog'

const getSettingsMock = vi.hoisted(() => vi.fn())
const setSettingsMock = vi.hoisted(() => vi.fn())

vi.mock('@main/settings/settings', () => ({
  getSettings: getSettingsMock,
  setSettings: setSettingsMock
}))

import {
  DICTATION_IDLE_UNLOAD_MS,
  deleteDictationModelCache,
  installDictationModel,
  prepareLocalDictation,
  resetDictationLocalStateForTests,
  selectDictationDownloadFiles,
  setDictationWhisperBackendForTests,
  transcribeLocalDictation,
  unloadDictationModel
} from '@main/dictation/local'
import {
  getDictationRuntimeStatus,
  onDictationRuntimeStatus,
  resetDictationRuntimeStatusForTests
} from '@main/dictation/modelStatus'
import { setDictationModelsRootOverrideForTests } from '@main/dictation/modelPaths'
import { dictationCatalogEntry } from '@shared/dictation'

function fakeFetch(): typeof fetch {
  return (async () =>
    new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 200,
      headers: { 'content-length': '4' }
    })) as typeof fetch
}

function writeRequiredFiles(modelDir: string): void {
  mkdirSync(join(modelDir, 'onnx'), { recursive: true })
  for (const relative of [...DICTATION_WHISPER_REQUIRED_FILES, ...DICTATION_WHISPER_OPTIONAL_FILES]) {
    const dest = join(modelDir, relative)
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, Buffer.from([1, 2, 3, 4]))
  }
}

describe('local dictation Whisper cache', () => {
  let modelsRoot: string

  beforeEach(() => {
    modelsRoot = mkdtempSync(join(tmpdir(), 'vyotiq-dictation-models-'))
    setDictationModelsRootOverrideForTests(modelsRoot)
    resetDictationRuntimeStatusForTests()
    resetDictationLocalStateForTests()
    getSettingsMock.mockReturnValue({
      ...DEFAULT_SETTINGS,
      dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'local', localModelId: '' }
    })
    setSettingsMock.mockImplementation((partial: { dictation?: { localModelId?: string } }) => {
      const prev = getSettingsMock()
      getSettingsMock.mockReturnValue({
        ...prev,
        dictation: { ...prev.dictation, ...partial.dictation }
      })
      return getSettingsMock()
    })
  })

  afterEach(() => {
    resetDictationLocalStateForTests()
    resetDictationRuntimeStatusForTests()
    setDictationModelsRootOverrideForTests(null)
    rmSync(modelsRoot, { recursive: true, force: true })
  })

  it('rejects transcription when no local cache is installed', async () => {
    await expect(
      transcribeLocalDictation({
        data: Buffer.from('webm').toString('base64'),
        mime: 'audio/webm',
        pcm16k: Buffer.from([0, 0, 1, 0]).toString('base64')
      })
    ).rejects.toMatchObject({ code: 'model_missing' })
  })

  it('transcribes with a mocked pipeline when cache is present', async () => {
    const modelId = 'whisper-tiny.en' as const
    const modelDir = join(modelsRoot, modelId)
    writeRequiredFiles(modelDir)
    const transcribe = vi.fn(async () => 'hello local')
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe,
      dispose: vi.fn(async () => undefined)
    })
    getSettingsMock.mockReturnValue({
      ...DEFAULT_SETTINGS,
      dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'local', localModelId: modelId }
    })

    const pcm = new Int16Array([0, 16384, -16384])
    const result = await transcribeLocalDictation({
      data: Buffer.from('webm').toString('base64'),
      mime: 'audio/webm',
      pcm16k: Buffer.from(pcm.buffer).toString('base64')
    })
    expect(result).toEqual({ text: 'hello local' })
    expect(transcribe).toHaveBeenCalledTimes(1)
    expect(transcribe).toHaveBeenCalledWith(Buffer.from(pcm.buffer).toString('base64'), 16000, undefined, modelId)
  })

  it('re-ensures the worker session when the utility restarted between utterances', async () => {
    const modelId = 'whisper-tiny.en' as const
    writeRequiredFiles(join(modelsRoot, modelId))
    getSettingsMock.mockReturnValue({
      ...DEFAULT_SETTINGS,
      dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'local', localModelId: modelId }
    })

    // First backend: normal load + transcribe (sets the loadedModelId cache).
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => 'first'),
      dispose: vi.fn(async () => undefined)
    })
    await transcribeLocalDictation({
      data: Buffer.from('webm').toString('base64'),
      mime: 'audio/webm',
      pcm16k: Buffer.from([0, 0, 1, 0]).toString('base64')
    })

    // The utility process dies and respawns (abort teardown / crash): a fresh
    // backend with no session. The stale loadedModelId cache must not skip the
    // ensure handshake, or transcribe hits "call ensure first".
    let ensured = false
    const secondEnsure = vi.fn(async () => {
      ensured = true
    })
    const secondTranscribe = vi.fn(async () => {
      if (!ensured) throw new Error('Whisper session not loaded — call ensure first')
      return 'second'
    })
    setDictationWhisperBackendForTests({
      ensure: secondEnsure,
      transcribe: secondTranscribe,
      dispose: vi.fn(async () => undefined)
    })

    const res = await transcribeLocalDictation({
      data: Buffer.from('webm').toString('base64'),
      mime: 'audio/webm',
      pcm16k: Buffer.from([0, 0, 1, 0]).toString('base64')
    })
    expect(secondEnsure).toHaveBeenCalledTimes(1)
    expect(secondTranscribe).toHaveBeenCalledTimes(1)
    expect(res).toEqual({ text: 'second' })
  })

  describe('live drafts', () => {
    const pcm16k = Buffer.from(new Int16Array([0, 100, -100]).buffer).toString('base64')

    function useSmall(): void {
      getSettingsMock.mockReturnValue({
        ...DEFAULT_SETTINGS,
        dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'local', localModelId: 'whisper-small.en' }
      })
    }

    it('drafts on Whisper Tiny when it is installed next to the chosen model, and says so', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-tiny.en'))
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      const ensure = vi.fn(async () => undefined)
      const transcribe = vi.fn(async (_pcm: string, _rate: number, _signal?: AbortSignal, modelId?: string) =>
        modelId === 'whisper-tiny.en' ? 'draft words' : 'final words'
      )
      setDictationWhisperBackendForTests({ ensure, transcribe, dispose: vi.fn(async () => undefined) })

      await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k, draft: true })).resolves.toEqual({
        text: 'draft words',
        provisional: true
      })
      await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k })).resolves.toEqual({ text: 'final words' })
      expect(transcribe.mock.calls.map((c) => c[3])).toEqual(['whisper-tiny.en', 'whisper-small.en'])
      // Loading the drafter never shows in Voice settings as the chosen model loading.
      expect(getDictationRuntimeStatus().loadedModelId).toBe('whisper-small.en')
    })

    it('drafts on the chosen model when it is the only one, and those words can stand', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      const transcribe = vi.fn(async (_pcm: string, _rate: number, _signal?: AbortSignal, _modelId?: string) => 'same model')
      setDictationWhisperBackendForTests({
        ensure: vi.fn(async () => undefined),
        transcribe,
        dispose: vi.fn(async () => undefined)
      })
      await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k, draft: true })).resolves.toEqual({
        text: 'same model'
      })
      expect(transcribe.mock.calls[0]![3]).toBe('whisper-small.en')
    })

    it('an empty answer is text, not a failure, when the take allows it', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      setDictationWhisperBackendForTests({
        ensure: vi.fn(async () => undefined),
        transcribe: vi.fn(async () => '[BLANK_AUDIO]'),
        dispose: vi.fn(async () => undefined)
      })
      await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k, allowEmpty: true })).resolves.toEqual({
        text: ''
      })
    })

    it('publishes status when a model loads, not on every request', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      setDictationWhisperBackendForTests({
        ensure: vi.fn(async () => undefined),
        transcribe: vi.fn(async () => 'words'),
        dispose: vi.fn(async () => undefined)
      })
      const published = vi.fn()
      const off = onDictationRuntimeStatus(published)
      try {
        await transcribeLocalDictation({ mime: 'audio/wav', pcm16k })
        const afterLoad = published.mock.calls.length
        expect(afterLoad).toBeGreaterThan(0)
        for (let i = 0; i < 5; i++) await transcribeLocalDictation({ mime: 'audio/wav', pcm16k, draft: true })
        expect(published.mock.calls.length).toBe(afterLoad)
      } finally {
        off()
      }
    })

    it('prepare loads the chosen model and the drafter before the first words', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-tiny.en'))
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      const ensure = vi.fn(async () => undefined)
      setDictationWhisperBackendForTests({ ensure, transcribe: vi.fn(async () => ''), dispose: vi.fn(async () => undefined) })
      await prepareLocalDictation()
      expect(ensure.mock.calls.map((c) => (c as unknown[])[1])).toEqual(['whisper-small.en', 'whisper-tiny.en'])
      expect(getDictationRuntimeStatus().installed.filter((m) => m.loaded).map((m) => m.id).sort()).toEqual([
        'whisper-small.en',
        'whisper-tiny.en'
      ])
    })

    it('times each model on this PC for Voice settings', async () => {
      writeRequiredFiles(join(modelsRoot, 'whisper-tiny.en'))
      writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
      useSmall()
      let clock = 1_000
      const now = vi.spyOn(Date, 'now').mockImplementation(() => clock)
      try {
        setDictationWhisperBackendForTests({
          ensure: vi.fn(async () => undefined),
          transcribe: vi.fn(async () => {
            clock += 2000
            return 'words'
          }),
          dispose: vi.fn(async () => undefined)
        })
        await transcribeLocalDictation({ mime: 'audio/wav', pcm16k })
        const byId = (): Record<string, number | null | undefined> =>
          Object.fromEntries(getDictationRuntimeStatus().installed.map((m) => [m.id, m.callMs]))
        expect(byId()).toEqual({ 'whisper-small.en': 2000, 'whisper-tiny.en': null })
        await transcribeLocalDictation({ mime: 'audio/wav', pcm16k })
        expect(byId()['whisper-small.en']).toBe(2000)
      } finally {
        now.mockRestore()
      }
    })

    it('gives the memory back after a quiet spell, and a take pushes that back', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
      try {
        writeRequiredFiles(join(modelsRoot, 'whisper-tiny.en'))
        writeRequiredFiles(join(modelsRoot, 'whisper-small.en'))
        useSmall()
        const dispose = vi.fn(async () => undefined)
        setDictationWhisperBackendForTests({ ensure: vi.fn(async () => undefined), transcribe: vi.fn(async () => 'w'), dispose })
        await prepareLocalDictation()
        await vi.advanceTimersByTimeAsync(DICTATION_IDLE_UNLOAD_MS - 1000)
        await transcribeLocalDictation({ mime: 'audio/wav', pcm16k })
        await vi.advanceTimersByTimeAsync(DICTATION_IDLE_UNLOAD_MS - 1000)
        expect(dispose).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(2000)
        expect(dispose).toHaveBeenCalled()
        expect(getDictationRuntimeStatus().installed.some((m) => m.loaded)).toBe(false)
        expect(getDictationRuntimeStatus().loadedModelId).toBeNull()
      } finally {
        vi.useRealTimers()
      }
    })
  })

  it('publishes error phase when Whisper load fails after files are on disk', async () => {
    const modelId = 'whisper-tiny.en' as const
    writeRequiredFiles(join(modelsRoot, modelId))
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => {
        throw new Error('ONNX load failed')
      }),
      transcribe: vi.fn(async () => 'x'),
      dispose: vi.fn(async () => undefined)
    })
    getSettingsMock.mockReturnValue({
      ...DEFAULT_SETTINGS,
      dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'local', localModelId: modelId }
    })

    await expect(
      transcribeLocalDictation({
        data: Buffer.from('webm').toString('base64'),
        mime: 'audio/webm',
        pcm16k: Buffer.from([0, 0, 1, 0]).toString('base64')
      })
    ).rejects.toThrow(/ONNX load failed/)

    const status = getDictationRuntimeStatus()
    expect(status.phase).toBe('error')
    expect(status.error).toBe('ONNX load failed')
    expect(status.activeModelId).toBe(modelId)
    expect(status.message).toBe(`Failed: ${modelId}`)
    expect(status.installed.some((m) => m.id === modelId)).toBe(true)
  })

  it('install writes files then loads the pipeline', async () => {
    const ensure = vi.fn(async () => undefined)
    setDictationWhisperBackendForTests({
      ensure,
      transcribe: vi.fn(async () => 'x'),
      dispose: vi.fn(async () => undefined)
    })
    const status = await installDictationModel('whisper-tiny.en', { fetchImpl: fakeFetch() })
    const modelDir = join(modelsRoot, 'whisper-tiny.en')
    for (const relative of DICTATION_WHISPER_REQUIRED_FILES) {
      expect(existsSync(join(modelDir, relative))).toBe(true)
    }
    expect(ensure).toHaveBeenCalledWith(modelDir, 'whisper-tiny.en')
    expect(status.installed.some((m) => m.id === 'whisper-tiny.en' && m.loaded)).toBe(true)
    expect(setSettingsMock).toHaveBeenCalledWith({
      dictation: {
        ...DEFAULT_SETTINGS.dictation,
        engine: 'local',
        localModelId: 'whisper-tiny.en'
      }
    })
  })

  it('installs Moonshine with its own files — a full-precision encoder — and drafts its live words on Tiny', async () => {
    const ensure = vi.fn(async () => undefined)
    const transcribe = vi.fn(async (_pcm: string, _rate: number, _signal?: AbortSignal, modelId?: string) => `from ${modelId}`)
    setDictationWhisperBackendForTests({ ensure, transcribe, dispose: vi.fn(async () => undefined) })
    const urls: string[] = []
    const fetchImpl = (async (url: string | URL) => {
      urls.push(String(url))
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'content-length': '4' } })
    }) as typeof fetch
    await installDictationModel('moonshine-base', { fetchImpl })
    const modelDir = join(modelsRoot, 'moonshine-base')
    for (const relative of DICTATION_MOONSHINE_REQUIRED_FILES) expect(existsSync(join(modelDir, relative))).toBe(true)
    expect(urls.every((u) => u.includes('onnx-community/moonshine-base-ONNX'))).toBe(true)
    expect(urls.some((u) => u.endsWith('onnx/encoder_model.onnx'))).toBe(true)
    expect(urls.some((u) => u.includes('encoder_model_quantized'))).toBe(false)

    writeRequiredFiles(join(modelsRoot, 'whisper-tiny.en'))
    const pcm16k = Buffer.from(new Int16Array([0, 100, -100]).buffer).toString('base64')
    await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k })).resolves.toEqual({ text: 'from moonshine-base' })
    await expect(transcribeLocalDictation({ mime: 'audio/wav', pcm16k, draft: true })).resolves.toEqual({
      text: 'from whisper-tiny.en',
      provisional: true
    })
  })

  it('install records localModelId without changing the dictation engine', async () => {
    getSettingsMock.mockReturnValue({
      ...DEFAULT_SETTINGS,
      dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'openai', localModelId: '' }
    })
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => 'x'),
      dispose: vi.fn(async () => undefined)
    })
    await installDictationModel('whisper-tiny.en', { fetchImpl: fakeFetch() })
    expect(setSettingsMock).toHaveBeenCalledWith({
      dictation: {
        ...DEFAULT_SETTINGS.dictation,
        engine: 'openai',
        localModelId: 'whisper-tiny.en'
      }
    })
    expect(getSettingsMock().dictation.engine).toBe('openai')
    expect(getSettingsMock().dictation.localModelId).toBe('whisper-tiny.en')
  })

  it('unload keeps files on disk', async () => {
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => 'x'),
      dispose: vi.fn(async () => undefined)
    })
    await installDictationModel('whisper-tiny.en', { fetchImpl: fakeFetch() })
    const modelDir = join(modelsRoot, 'whisper-tiny.en')
    const dispose = vi.fn(async () => undefined)
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => 'x'),
      dispose
    })
    const status = await unloadDictationModel()
    expect(dispose).toHaveBeenCalled()
    expect(existsSync(join(modelDir, 'config.json'))).toBe(true)
    expect(status.installed.some((m) => m.id === 'whisper-tiny.en' && !m.loaded)).toBe(true)
  })

  it('delete cache removes the model directory', async () => {
    setDictationWhisperBackendForTests({
      ensure: vi.fn(async () => undefined),
      transcribe: vi.fn(async () => 'x'),
      dispose: vi.fn(async () => undefined)
    })
    await installDictationModel('whisper-tiny.en', { fetchImpl: fakeFetch() })
    const modelDir = join(modelsRoot, 'whisper-tiny.en')
    expect(existsSync(modelDir)).toBe(true)
    await deleteDictationModelCache('whisper-tiny.en')
    expect(existsSync(modelDir)).toBe(false)
    expect(setSettingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        dictation: expect.objectContaining({ localModelId: '' })
      })
    )
  })

  it('does not call Hugging Face from the curated file list helper', () => {
    const entry = dictationCatalogEntry('whisper-tiny.en')
    expect(entry.hubRepo).toBe('onnx-community/whisper-tiny.en')
  })

  it('keeps curated q8 files and drops timestamped / full-precision Hub extras', () => {
    const hub = dictationCatalogEntry('whisper-tiny.en').hubRepo
    const files = selectDictationDownloadFiles(hub, [
      'config.json',
      'onnx/encoder_model.onnx',
      'onnx/encoder_model_quantized.onnx',
      'onnx/decoder_model_merged_quantized_timestamped.onnx',
      'generation_config.json',
      'onnx/decoder_with_past_model_quantized.onnx'
    ])
    const paths = files.map((f) => f.relativePath)
    expect(paths).toContain('onnx/encoder_model_quantized.onnx')
    expect(paths).toContain('onnx/decoder_model_merged_quantized.onnx')
    expect(paths).not.toContain('onnx/encoder_model.onnx')
    expect(paths).not.toContain('onnx/decoder_model_merged_quantized_timestamped.onnx')
    expect(paths).toContain('onnx/decoder_with_past_model_quantized.onnx')
    expect(files.find((f) => f.relativePath === 'onnx/decoder_with_past_model_quantized.onnx')?.optional).toBe(
      true
    )
  })
})
