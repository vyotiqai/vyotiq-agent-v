import { describe, expect, it, vi } from 'vitest'
import { invokeAsr } from '@main/dictation/whisperAudio'
import { dictationModelIsMultilingual, DICTATION_LOCAL_CATALOG } from '@shared/dictation'

/** The multilingual local model takes the Language setting; the English-only ones never see it. */
describe('multilingual dictation', () => {
  const pcm = Buffer.from(new Int16Array(1600).buffer).toString('base64')

  it('marks only the multilingual model', () => {
    expect(dictationModelIsMultilingual('whisper-small')).toBe(true)
    expect(dictationModelIsMultilingual('whisper-small.en')).toBe(false)
    expect(DICTATION_LOCAL_CATALOG.find((m) => m.id === 'whisper-small')?.hubRepo).toBe('onnx-community/whisper-small')
  })

  it('passes a language and the transcribe task only when asked', async () => {
    const asr = vi.fn(async (_audio: Float32Array, _opts?: Record<string, unknown>) => ({ text: ' नमस्ते ' }))
    expect(await invokeAsr(asr, pcm, 'whisper', { language: 'hi' })).toBe('नमस्ते')
    expect(asr.mock.calls[0]![1]).toMatchObject({ language: 'hi', task: 'transcribe' })
    await invokeAsr(asr, pcm, 'whisper')
    expect(asr.mock.calls[1]![1]).not.toHaveProperty('language')
  })
})
