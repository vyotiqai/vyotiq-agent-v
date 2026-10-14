import { describe, expect, it, vi } from 'vitest'
import { checkVoiceKey } from '@main/voice/keyService'
import { VoiceError, toVoiceError } from '@main/voice/errors'
import { openFixtureStt, openFixtureTts, FIXTURE_TTS_SAMPLE_RATE } from '@main/voice/providers/fixture'
import type { SttEvent, TtsChunk } from '@main/voice/providers/types'

function respond(status: number): typeof fetch {
  return vi.fn(async () => new Response('{}', { status })) as unknown as typeof fetch
}

describe('checking a voice key before saving it', () => {
  it('accepts a key the vendor accepts, and sends it the vendor’s way', async () => {
    const f = respond(200)
    await expect(checkVoiceKey('deepgram', 'k123', f)).resolves.toBe('verified')
    const [url, init] = (f as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!
    expect(url).toContain('api.deepgram.com')
    expect((init as RequestInit).headers).toEqual({ Authorization: 'Token k123' })
  })

  it('refuses a rejected key with a typed code', async () => {
    await expect(checkVoiceKey('elevenlabs', 'bad', respond(401))).rejects.toMatchObject({ code: 'rejected_key' })
    await expect(checkVoiceKey('cartesia', 'broke', respond(402))).rejects.toMatchObject({ code: 'out_of_credit' })
  })

  it('saves anyway when the vendor can’t be reached or answers oddly', async () => {
    const offline = vi.fn(async () => {
      throw new TypeError('fetch failed')
    }) as unknown as typeof fetch
    await expect(checkVoiceKey('assemblyai', 'k', offline)).resolves.toBe('unchecked')
    await expect(checkVoiceKey('assemblyai', 'k', respond(404))).resolves.toBe('unchecked')
    await expect(checkVoiceKey('assemblyai', 'k', respond(503))).resolves.toBe('unchecked')
  })
})

describe('VoiceError', () => {
  it('classifies network failures as offline and keeps typed errors as they are', () => {
    expect(toVoiceError(new TypeError('fetch failed')).code).toBe('offline')
    expect(toVoiceError(new Error('boom')).code).toBe('engine_failed')
    const typed = new VoiceError('rate_limited', 'slow down')
    expect(toVoiceError(typed)).toBe(typed)
    expect(typed.retryable).toBe(true)
  })
})

describe('fixture providers', () => {
  it('the listener plays a scripted turn', async () => {
    const events: SttEvent[] = []
    const ctrl = new AbortController()
    const stt = await openFixtureStt({
      apiKey: '',
      model: 'x',
      language: '',
      patience: 'normal',
      keyterms: ['runAgent'],
      signal: ctrl.signal,
      emit: (e) => events.push(e)
    })
    stt.pushAudio(new Int16Array(320))
    stt.say('fix the flaky test')
    await stt.close()
    expect(events.map((e) => e.kind)).toEqual(['open', 'speech_start', 'partial', 'end_of_turn', 'closed'])
    expect(events.find((e) => e.kind === 'end_of_turn')).toMatchObject({ text: 'fix the flaky test' })
    expect(stt.received).toHaveLength(1)
    expect(stt.keyterms).toEqual(['runAgent'])
  })

  it('the speaker delivers audio per flushed sentence, and nothing after cancel', async () => {
    const chunks: TtsChunk[] = []
    const ctrl = new AbortController()
    const tts = openFixtureTts({
      apiKey: '',
      model: 'x',
      voiceId: 'v',
      speed: 1,
      contextId: 'c1',
      signal: ctrl.signal,
      onAudio: (c) => chunks.push(c),
      onError: () => {}
    })
    tts.pushText('Done. ')
    tts.flush()
    // Audio arrives before the stream is over: done() waits for end() or cancel().
    await vi.waitFor(() => expect(chunks).toHaveLength(1))
    // Barge-in: audio not yet delivered is dropped, and nothing new is spoken.
    tts.pushText('Undelivered. ')
    tts.flush()
    tts.cancel()
    tts.pushText('Never said')
    tts.end()
    await tts.done()
    expect(tts.spoken).toEqual(['Done.', 'Undelivered.'])
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toMatchObject({ sampleRate: FIXTURE_TTS_SAMPLE_RATE, contextId: 'c1' })
    expect(chunks[0]!.pcm.length).toBe(5 * (FIXTURE_TTS_SAMPLE_RATE / 100))
  })
})
