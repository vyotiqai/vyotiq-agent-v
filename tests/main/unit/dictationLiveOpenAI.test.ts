import { afterEach, describe, expect, it, vi } from 'vitest'
import type { DictationLiveEvent } from '@shared/ipc'
import {
  OPENAI_LIVE_MODEL,
  OPENAI_LIVE_URL,
  Upsampler16To24,
  appendLiveAudio,
  closeLiveTake,
  commitLive,
  openLiveTake,
  resetLiveTakesForTests,
  setOpenLiveSocketForTests
} from '@main/dictation/liveOpenAI'

type Sent = { type: string; [k: string]: unknown }

function fakeSocket() {
  const sent: Sent[] = []
  const socket = {
    readyState: 0,
    send: vi.fn((data: string) => sent.push(JSON.parse(data) as Sent)),
    close: vi.fn(),
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    onclose: null as ((ev: { code?: number; reason?: string }) => void) | null
  }
  const opened: Array<{ url: string; headers: Record<string, string> }> = []
  setOpenLiveSocketForTests((url, headers) => {
    opened.push({ url, headers })
    return socket as never
  })
  return {
    socket,
    sent,
    opened,
    open: () => socket.onopen?.({}),
    server: (msg: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(msg) })
  }
}

function start(keywords?: string[]) {
  const events: DictationLiveEvent[] = []
  openLiveTake({ takeId: 't1', apiKey: 'sk-test', language: 'en', keywords, emit: (e) => events.push(e) })
  return events
}

afterEach(() => {
  resetLiveTakesForTests()
})

describe('OpenAI live transcription session', () => {
  it('connects with the key in a header and configures a transcription session once open', () => {
    const f = fakeSocket()
    start(['takeController'])
    expect(f.opened).toEqual([{ url: OPENAI_LIVE_URL, headers: { Authorization: 'Bearer sk-test' } }])
    expect(f.sent).toEqual([])
    f.open()
    expect(f.sent[0]).toEqual({
      type: 'session.update',
      session: {
        type: 'transcription',
        audio: {
          input: {
            format: { type: 'audio/pcm', rate: 24000 },
            transcription: { model: OPENAI_LIVE_MODEL, delay: 'low', languages: ['en'], keywords: ['takeController'] },
            turn_detection: null
          }
        }
      }
    })
  })

  it('keeps audio and commits in order while the socket opens, and sends 24 kHz audio', () => {
    const f = fakeSocket()
    start()
    appendLiveAudio('t1', new Int16Array(1600))
    commitLive('t1')
    appendLiveAudio('t1', new Int16Array(1600))
    f.open()
    expect(f.sent.map((m) => m.type)).toEqual([
      'session.update',
      'input_audio_buffer.append',
      'input_audio_buffer.commit',
      'input_audio_buffer.append'
    ])
    const bytes = Buffer.from(f.sent[1]!.audio as string, 'base64').byteLength
    // 1600 samples at 16 kHz is 100 ms: about 2400 samples at 24 kHz (the last one waits for the next chunk).
    expect(Math.abs(bytes / 2 - 2400)).toBeLessThanOrEqual(2)
  })

  it('maps items to phrases by commit order, holding words that could belong to a phrase just cut', () => {
    const f = fakeSocket()
    const events = start()
    f.open()
    // Words for the phrase being spoken, no commit pending: phrase 0.
    f.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'a', delta: 'Hello' })
    commitLive('t1')
    // A commit is waiting for confirmation: words for an unknown item are held.
    f.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: 'Next' })
    f.server({ type: 'input_audio_buffer.committed', item_id: 'a', previous_item_id: null })
    f.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Hello there.' })
    // Now nothing is pending, so the held item is the phrase being spoken: phrase 1.
    f.server({ type: 'conversation.item.input_audio_transcription.delta', item_id: 'b', delta: ' words' })
    expect(events.filter((e) => e.kind === 'words')).toEqual([
      { takeId: 't1', kind: 'words', ordinal: 0, text: 'Hello', final: false },
      { takeId: 't1', kind: 'words', ordinal: 0, text: 'Hello there.', final: true },
      { takeId: 't1', kind: 'words', ordinal: 1, text: 'Next words', final: false }
    ])
  })

  it('a transcript that beats its commit confirmation still lands', () => {
    const f = fakeSocket()
    const events = start()
    f.open()
    commitLive('t1')
    f.server({ type: 'conversation.item.input_audio_transcription.completed', item_id: 'a', transcript: 'Quick.' })
    f.server({ type: 'input_audio_buffer.committed', item_id: 'a' })
    expect(events.at(-1)).toEqual({ takeId: 't1', kind: 'words', ordinal: 0, text: 'Quick.', final: true })
  })

  it('an error ends the session and says why; an empty commit does not', () => {
    const f = fakeSocket()
    const events = start()
    f.open()
    f.server({ type: 'error', error: { code: 'input_audio_buffer_commit_empty', message: 'buffer too small' } })
    expect(events.some((e) => e.kind === 'error')).toBe(false)
    f.server({ type: 'error', error: { code: 'invalid_api_key', message: 'Incorrect API key' } })
    expect(events.at(-1)).toEqual({ takeId: 't1', kind: 'error', message: 'Incorrect API key' })
    expect(f.socket.close).toHaveBeenCalled()
    expect(appendLiveAudio('t1', new Int16Array(10))).toBe(false)
  })

  it('a socket that closes on its own is an error; one the take closed is not', () => {
    const f = fakeSocket()
    const events = start()
    f.open()
    f.socket.onclose?.({ code: 1006 })
    expect(events.at(-1)?.kind).toBe('error')
    const g = fakeSocket()
    const quiet = start()
    g.open()
    closeLiveTake('t1')
    g.socket.onclose?.({ code: 1000 })
    expect(quiet.some((e) => e.kind === 'error')).toBe(false)
  })
})

describe('Upsampler16To24', () => {
  it('makes three samples of two, the same in chunks as all at once', () => {
    const input = Int16Array.from({ length: 999 }, (_, i) => Math.round(Math.sin(i / 7) * 10000))
    const whole = new Upsampler16To24().push(input)
    const chunked = new Upsampler16To24()
    const parts = [chunked.push(input.subarray(0, 100)), chunked.push(input.subarray(100, 101)), chunked.push(input.subarray(101))]
    const joined = Int16Array.from(parts.flatMap((p) => [...p]))
    expect([...joined]).toEqual([...whole])
    expect(whole.length).toBe(Math.floor((998 * 3) / 2) + 1)
    // Every other output lands on an input sample exactly.
    expect(whole[0]).toBe(input[0])
    expect(whole[3]).toBe(input[2])
  })
})
