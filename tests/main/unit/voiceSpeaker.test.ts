import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const keyState = vi.hoisted(() => ({
  available: { voice: {}, chat: { openai: true } } as { voice: Record<string, boolean>; chat: Record<string, boolean> }
}))

vi.mock('@main/voice/keys', () => ({
  voiceKeyAvailability: () => keyState.available,
  requireVoiceSourceKey: (source: { kind: string }) => (source.kind === 'none' ? '' : 'test-key'),
  readVoiceSourceKey: () => 'test-key'
}))

import { speak, spokenTextForAnswer, stopSpeaking, type SpeakAudio } from '@main/voice/speaker'
import { setTtsProviderForTests } from '@main/voice/providers/registry'
import { openFixtureTts, type FixtureTtsStream } from '@main/voice/providers/fixture'
import type { TtsStreamOptions } from '@main/voice/providers/types'
import { DEFAULT_VOICE_SETTINGS } from '@shared/ipc/schemas/voice'

let streams: FixtureTtsStream[] = []
let lastOpts: TtsStreamOptions | null = null

beforeEach(() => {
  streams = []
  keyState.available = { voice: {}, chat: { openai: true } }
  for (const id of ['openai', 'elevenlabs'] as const) {
    setTtsProviderForTests(id, {
      id,
      stream: (opts) => {
        lastOpts = opts
        const s = openFixtureTts(opts)
        streams.push(s)
        return s
      }
    })
  }
})

afterEach(() => {
  stopSpeaking()
  setTtsProviderForTests('openai', null)
  setTtsProviderForTests('elevenlabs', null)
})

function sink() {
  const audio: SpeakAudio[] = []
  const ends: Array<{ id: string; error?: string }> = []
  return {
    audio,
    ends,
    sink: { audio: (c: SpeakAudio) => audio.push(c), end: (id: string, error?: string) => ends.push({ id, error }) }
  }
}

describe('what an answer sounds like', () => {
  it('speaks the <spoken> block, cleaned', () => {
    expect(spokenTextForAnswer('<spoken>I fixed `runAgent`.</spoken>\n\n```ts\nx\n```')).toBe('I fixed run agent.')
  })

  it('falls back to the first sentences when there is no block', () => {
    expect(spokenTextForAnswer('All green. Nothing else.')).toBe('All green. Nothing else.')
  })
})

describe('speak', () => {
  it('uses Automatic resolution, the saved voice and a clamped speed, and streams audio to the sink', async () => {
    const s = sink()
    const started = speak({ text: 'Hello there. How are you?', kind: 'plain' }, s.sink, {
      ...DEFAULT_VOICE_SETTINGS,
      speed: 9,
      tts: { openai: { voiceId: 'nova' } }
    })
    expect(started).toMatchObject({ provider: 'openai', voiceId: 'nova' })
    expect(lastOpts).toMatchObject({ apiKey: 'test-key', voiceId: 'nova', speed: 4, model: 'gpt-4o-mini-tts' })
    await vi.waitFor(() => expect(s.ends).toHaveLength(1))
    expect(streams[0]!.spoken).toEqual(['Hello there.', 'How are you?'])
    expect(s.audio.map((a) => a.seq)).toEqual([0, 1])
    expect(s.audio.every((a) => a.utteranceId === started.utteranceId)).toBe(true)
    expect(s.ends[0]).toEqual({ id: started.utteranceId, error: undefined })
  })

  it('a preview can override provider and voice', () => {
    const s = sink()
    const started = speak({ text: 'Sample.', kind: 'plain', provider: 'elevenlabs', voiceId: 'v9', speed: 1.1 }, s.sink)
    expect(started).toMatchObject({ provider: 'elevenlabs', voiceId: 'v9' })
    expect(lastOpts).toMatchObject({ speed: 1.1, model: 'eleven_flash_v2_5' })
  })

  it('starting a new utterance stops the last one', () => {
    speak({ text: 'First thing to say.', kind: 'plain' }, sink().sink)
    const firstSignal = lastOpts!.signal
    speak({ text: 'Second.', kind: 'plain' }, sink().sink)
    expect(firstSignal.aborted).toBe(true)
  })

  it('stopSpeaking only stops the matching utterance', () => {
    const a = speak({ text: 'Keep going.', kind: 'plain' }, sink().sink)
    stopSpeaking('someone-else')
    expect(lastOpts!.signal.aborted).toBe(false)
    stopSpeaking(a.utteranceId)
    expect(lastOpts!.signal.aborted).toBe(true)
  })

  it('refuses with no_key when no speaking provider has a key, and with nothing to say', () => {
    keyState.available = { voice: {}, chat: {} }
    expect(() => speak({ text: 'x', kind: 'plain' }, sink().sink)).toThrow(expect.objectContaining({ code: 'no_key' }))
    keyState.available = { voice: {}, chat: { openai: true } }
    expect(() => speak({ text: '```\ncode only\n``` ', kind: 'plain' }, sink().sink)).not.toThrow()
    expect(() => speak({ text: '   ', kind: 'plain' }, sink().sink)).toThrow(
      expect.objectContaining({ code: 'engine_failed' })
    )
  })
})
