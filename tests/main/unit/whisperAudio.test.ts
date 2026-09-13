import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { invokeWhisperAsr, pcmPayloadToFloat32 } from '@main/dictation/whisperAudio'
import {
  DictationUtilityClient,
  resetDictationUtilityClientForTests
} from '@main/dictation/whisperUtilityClient'

const INT16_SAMPLES = [0, 16384, -16384] as const

function int16Bytes(samples: readonly number[] = INT16_SAMPLES): Buffer {
  const arr = new Int16Array(samples)
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength)
}

function int16Base64(samples: readonly number[] = INT16_SAMPLES): string {
  return int16Bytes(samples).toString('base64')
}

/** Same check Transformers.js WhisperFeatureExtractor uses. */
function assertWhisperAudio(audio: unknown): asserts audio is Float32Array {
  if (!(audio instanceof Float32Array || audio instanceof Float64Array)) {
    throw new Error(
      `WhisperFeatureExtractor expects input to be a Float32Array or a Float64Array, but got ${audio?.constructor?.name ?? typeof audio} instead. ` +
        `If using the feature extractor directly, remember to use \`read_audio(url, sampling_rate)\` to obtain the raw audio data of the file/url.`
    )
  }
}

class FakeUtilityChild extends EventEmitter {
  pid = 4242
  killed = false
  messages: unknown[] = []

  postMessage(message: unknown): void {
    this.messages.push(JSON.parse(JSON.stringify(message)))
    const msg = message as { id: number; op: string }
    queueMicrotask(() => {
      this.emit('message', { id: msg.id, ok: true, text: 'hello local' })
    })
  }

  kill(): void {
    this.killed = true
    this.emit('exit', 0)
  }
}

describe('whisper Float32 PCM for Transformers.js', () => {
  it('converts Int16 base64 to Float32Array at 16 kHz scale', () => {
    const audio = pcmPayloadToFloat32(int16Base64())
    expect(audio).toBeInstanceOf(Float32Array)
    expect(audio).not.toBeInstanceOf(Int16Array)
    expect(Buffer.isBuffer(audio)).toBe(false)
    expect(audio.length).toBe(3)
    expect(audio[0]).toBe(0)
    expect(audio[1]).toBeCloseTo(0.5)
    expect(audio[2]).toBeCloseTo(-0.5)
  })

  it('rebuilds Float32Array from postMessage clones (Buffer JSON, Buffer, Int16Array, number[])', () => {
    const bytes = int16Bytes()
    const cloned = JSON.parse(JSON.stringify(bytes)) as { type: string; data: number[] }
    expect(cloned.type).toBe('Buffer')
    expect(cloned.constructor.name).toBe('Object')

    const payloads: unknown[] = [cloned, bytes, new Int16Array(INT16_SAMPLES), [...INT16_SAMPLES]]
    for (const pcm of payloads) {
      const audio = pcmPayloadToFloat32(pcm)
      expect(audio).toBeInstanceOf(Float32Array)
      expect(Object.getPrototypeOf(audio)).not.toBe(Object.prototype)
      expect(audio[1]).toBeCloseTo(0.5)
      expect(audio[2]).toBeCloseTo(-0.5)
    }
  })

  it('passes a real Float32Array into the ASR pipeline, not Object / Buffer / Int16Array', async () => {
    const bytes = int16Bytes()
    const bufferJson = JSON.parse(JSON.stringify(bytes)) as unknown
    const payloads: unknown[] = [
      int16Base64(),
      bufferJson,
      bytes,
      new Int16Array(INT16_SAMPLES),
      [...INT16_SAMPLES]
    ]

    for (const pcm of payloads) {
      const asr = vi.fn(async (audio: unknown) => {
        assertWhisperAudio(audio)
        expect(audio).toBeInstanceOf(Float32Array)
        expect(Buffer.isBuffer(audio)).toBe(false)
        expect(audio instanceof Int16Array).toBe(false)
        expect(Array.isArray(audio)).toBe(false)
        expect(Object.prototype.toString.call(audio)).toBe('[object Float32Array]')
        return { text: 'ok' }
      })
      await expect(invokeWhisperAsr(asr, pcm)).resolves.toBe('ok')
      expect(asr).toHaveBeenCalledTimes(1)
      const passed = asr.mock.calls[0]![0] as object
      expect(passed).toBeInstanceOf(Float32Array)
      expect('raw' in passed).toBe(false)
      expect('sampling_rate' in passed).toBe(false)
    }
  })

  it('rejects the old { raw, sampling_rate } object as PCM input', () => {
    expect(() =>
      pcmPayloadToFloat32({ raw: new Float32Array([0, 0.5]), sampling_rate: 16000 })
    ).toThrow(/pcm16k/)
  })

  it('passes chunk_length_s/stride_length_s so long audio is never truncated at 30s', async () => {
    const asr = vi.fn(async (_audio: unknown, options?: Record<string, unknown>) => {
      expect(options).toMatchObject({ chunk_length_s: 30, stride_length_s: 5 })
      return { text: 'full transcript' }
    })
    const text = await invokeWhisperAsr(asr, int16Base64())
    expect(text).toBe('full transcript')
    expect(asr).toHaveBeenCalledWith(
      expect.any(Float32Array),
      expect.objectContaining({ chunk_length_s: 30, stride_length_s: 5 })
    )
  })

  it('concatenates chunked Whisper output (array of { text })', async () => {
    const asr = vi.fn(async () => [{ text: 'first' }, { text: 'second part' }])
    const text = await invokeWhisperAsr(asr, int16Base64())
    expect(text).toBe('first second part')
  })
})

describe('DictationUtilityClient transcribe wire shape', () => {
  afterEach(() => {
    resetDictationUtilityClientForTests()
  })

  it('posts JSON-safe pcm16k base64 and sampleRate 16000, never a TypedArray/ArrayBuffer', async () => {
    let child: FakeUtilityChild | null = null
    const client = new DictationUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c
      },
      scriptPath: '/virtual/dictationUtility.js',
      timeoutMs: 5000
    })

    const text = await client.transcribe(int16Base64(), 16000)
    expect(text).toBe('hello local')
    const posted = child!.messages.find(
      (m) => (m as { op?: string }).op === 'transcribe'
    ) as { pcm16k?: unknown; sampleRate?: unknown; pcm?: unknown }
    expect(typeof posted.pcm16k).toBe('string')
    expect(posted.pcm16k).toBe(int16Base64())
    expect(posted.sampleRate).toBe(16000)
    expect(posted.pcm).toBeUndefined()
  })

  it('respawns after a failed spawn instead of reusing the rejected promise', async () => {
    let attempts = 0
    const children: FakeUtilityChild[] = []
    const client = new DictationUtilityClient({
      forkImpl: () => {
        attempts++
        const c = new FakeUtilityChild()
        children.push(c)
        if (attempts <= 2) {
          queueMicrotask(() => c.emit('error', new Error('spawn boom')))
        } else {
          queueMicrotask(() => c.emit('spawn'))
        }
        return c
      },
      scriptPath: '/virtual/dictationUtility.js',
      timeoutMs: 5000,
      spawnTimeoutMs: 40
    })

    await expect(client.ensure('/models/x', 'whisper-tiny.en')).rejects.toThrow(/spawn boom/)
    expect(attempts).toBe(2)
    expect(children[0]!.killed).toBe(true)
    expect(children[1]!.killed).toBe(true)

    const text = await client.transcribe(int16Base64(), 16000)
    expect(text).toBe('hello local')
    expect(attempts).toBe(3)
    await client.shutdown()
  })

  it('respawns after the child exits', async () => {
    let attempts = 0
    let child: FakeUtilityChild | null = null
    const client = new DictationUtilityClient({
      forkImpl: () => {
        attempts++
        const c = new FakeUtilityChild()
        queueMicrotask(() => c.emit('spawn'))
        child = c
        return c
      },
      scriptPath: '/virtual/dictationUtility.js',
      timeoutMs: 5000,
      spawnTimeoutMs: 40
    })

    await client.ensure('/models/x', 'whisper-tiny.en')
    expect(attempts).toBe(1)
    child!.emit('exit', 1)
    await new Promise((r) => setImmediate(r))

    const text = await client.transcribe(int16Base64(), 16000)
    expect(text).toBe('hello local')
    expect(attempts).toBe(2)
    await client.shutdown()
  })

  it('kills the child on spawn timeout', async () => {
    const children: FakeUtilityChild[] = []
    const client = new DictationUtilityClient({
      forkImpl: () => {
        const c = new FakeUtilityChild()
        children.push(c)
        return c
      },
      scriptPath: '/virtual/dictationUtility.js',
      timeoutMs: 5000,
      spawnTimeoutMs: 40
    })

    await expect(client.ensure('/models/x', 'whisper-tiny.en')).rejects.toThrow(
      /Dictation worker spawn timeout/
    )
    expect(children.length).toBe(2)
    expect(children.every((c) => c.killed)).toBe(true)
    await client.shutdown()
  })
})
