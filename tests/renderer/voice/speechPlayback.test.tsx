/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReadAloudButton } from '@renderer/features/voice/ReadAloudButton'
import { resetSpeechForTests, setSpeechOutput, speakText, stopSpeech, whenSpeechDone } from '@renderer/features/voice/speechPlayback'
import type { PlayerAudioContext } from '@renderer/features/voice/voicePlayer'
import type { VoiceAudioOut, VoiceSpeakEnd } from '@shared/ipc/schemas/voice'

const toasts = vi.hoisted(() => [] as string[])
vi.mock('@renderer/lib/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/ui')>()
  return { ...actual, pushToast: (msg: string) => toasts.push(msg) }
})

type Source = { onended: (() => void) | null; stop: () => void }
let sources: Source[] = []

function fakeContext(): PlayerAudioContext {
  const param = { value: 1, setTargetAtTime: vi.fn() }
  return {
    currentTime: 0,
    state: 'running',
    destination: {},
    createBuffer: (_c: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length)
    }),
    createBufferSource: () => {
      const s = { buffer: null, onended: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn() }
      sources.push(s)
      return s
    },
    createGain: () => ({ gain: param, connect: vi.fn() }),
    createAnalyser: () => ({ fftSize: 0, connect: vi.fn(), getFloatTimeDomainData: vi.fn() }),
    close: vi.fn(async () => {})
  } as unknown as PlayerAudioContext
}

let audioHandler: ((c: VoiceAudioOut) => void) | null = null
let endHandler: ((e: VoiceSpeakEnd) => void) | null = null
let voiceSpeak: ReturnType<typeof vi.fn>
let voiceStopSpeaking: ReturnType<typeof vi.fn>

beforeEach(() => {
  sources = []
  toasts.length = 0
  resetSpeechForTests(fakeContext)
  voiceSpeak = vi.fn(async () => ({ ok: true, data: { utteranceId: 'u1', provider: 'openai', voiceId: 'alloy' } }))
  voiceStopSpeaking = vi.fn(async () => ({ ok: true, data: true }))
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    voiceSpeak,
    voiceStopSpeaking,
    onVoiceAudioOut: (h: (c: VoiceAudioOut) => void) => {
      audioHandler = h
      return () => {}
    },
    onVoiceSpeakEnd: (h: (e: VoiceSpeakEnd) => void) => {
      endHandler = h
      return () => {}
    }
  }
})

afterEach(() => {
  cleanup()
  resetSpeechForTests()
})

const chunk = (utteranceId: string): VoiceAudioOut => ({ utteranceId, seq: 0, sampleRate: 24000, pcm: new Int16Array(240) })

describe('Read aloud', () => {
  it('speaks the answer, shows it is playing, and returns to idle when the audio has played', async () => {
    render(<ReadAloudButton text="<spoken>Done.</spoken> Details." owner="answer:1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(voiceSpeak).toHaveBeenCalledWith({ text: '<spoken>Done.</spoken> Details.', kind: 'answer' }))
    act(() => audioHandler!(chunk('u1')))
    expect(screen.getByRole('button', { name: 'Stop reading aloud' }).getAttribute('data-read-aloud')).toBe('playing')
    act(() => endHandler!({ utteranceId: 'u1' }))
    // Main is done, but the audio is still playing.
    expect(screen.getByRole('button', { name: 'Stop reading aloud' })).toBeTruthy()
    act(() => sources[0]!.onended?.())
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy()
  })

  it('stops on a second press', async () => {
    render(<ReadAloudButton text="Hi." owner="answer:1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(voiceSpeak).toHaveBeenCalled())
    act(() => audioHandler!(chunk('u1')))
    fireEvent.click(screen.getByRole('button', { name: 'Stop reading aloud' }))
    expect(voiceStopSpeaking).toHaveBeenCalledWith({ utteranceId: 'u1' })
    expect(screen.getByRole('button', { name: 'Read aloud' })).toBeTruthy()
  })

  it('words a missing key as a toast, without provider text', async () => {
    voiceSpeak.mockResolvedValueOnce({ ok: false, error: 'No text-to-speech provider has a key', code: 'voice:no_key' })
    render(<ReadAloudButton text="Hi." owner="answer:1" />)
    fireEvent.click(screen.getByRole('button', { name: 'Read aloud' }))
    await waitFor(() => expect(toasts).toEqual(['Add a key for a speaking provider in Settings → Voice to hear it.']))
  })

  it('ignores audio from an utterance that is no longer current', async () => {
    await act(() => speakText('preview', { text: 'a', kind: 'plain' }))
    act(() => stopSpeech())
    act(() => audioHandler!(chunk('u1')))
    expect(sources).toHaveLength(0)
  })

  it('a second button takes over from the first', async () => {
    render(
      <>
        <ReadAloudButton text="One." owner="answer:1" />
        <ReadAloudButton text="Two." owner="answer:2" />
      </>
    )
    const [first, second] = screen.getAllByRole('button', { name: 'Read aloud' })
    fireEvent.click(first!)
    await waitFor(() => expect(voiceSpeak).toHaveBeenCalledTimes(1))
    voiceSpeak.mockResolvedValueOnce({ ok: true, data: { utteranceId: 'u2', provider: 'openai', voiceId: 'alloy' } })
    fireEvent.click(second!)
    await waitFor(() => expect(voiceSpeak).toHaveBeenCalledTimes(2))
    expect(voiceStopSpeaking).toHaveBeenCalledWith({ utteranceId: 'u1' })
    expect(screen.getAllByRole('button', { name: 'Read aloud' })).toHaveLength(1)
  })
})

describe('where speech plays (voice mode’s samples, audit I11)', () => {
  it('plays on the chosen output, including what is playing; whenSpeechDone resolves when it ends', async () => {
    const sinks: string[] = []
    resetSpeechForTests(() => ({ ...fakeContext(), setSinkId: async (id: string) => void sinks.push(id) }) as unknown as PlayerAudioContext)
    setSpeechOutput('headset')
    await speakText('voice-sample', { text: 'Hi.', kind: 'plain' })
    const done = whenSpeechDone('voice-sample')
    act(() => audioHandler!(chunk('u1')))
    expect(sinks).toEqual(['headset'])
    setSpeechOutput('')
    expect(sinks).toEqual(['headset', ''])
    act(() => endHandler!({ utteranceId: 'u1' }))
    act(() => sources.forEach((src) => src.onended?.()))
    await expect(done).resolves.toBeUndefined()
  })
})
