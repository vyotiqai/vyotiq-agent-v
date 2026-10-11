import { describe, expect, it, vi } from 'vitest'
import {
  DUCKED_GAIN,
  JITTER_BUFFER_S,
  VoicePlayer,
  int16ToFloat32,
  type PlayerAudioContext
} from '../../../src/renderer/src/features/voice/voicePlayer'

class FakeParam {
  value = 1
  readonly targets: Array<[number, number]> = []
  setTargetAtTime(v: number, at: number): void {
    this.targets.push([v, at])
    this.value = v
  }
}

class FakeSource {
  buffer: { duration: number } | null = null
  onended: (() => void) | null = null
  startedAt = -1
  stoppedAt = -1
  connect(): void {}
  start(at: number): void {
    this.startedAt = at
  }
  stop(at: number): void {
    this.stoppedAt = at
  }
}

function fakeContext() {
  const sources: FakeSource[] = []
  const gain = { gain: new FakeParam(), connect: vi.fn() }
  const ctx = {
    currentTime: 10,
    state: 'running' as AudioContextState,
    destination: {},
    createBuffer: (_ch: number, length: number, rate: number) => {
      const data = new Float32Array(length)
      return { duration: length / rate, getChannelData: () => data }
    },
    createBufferSource: () => {
      const s = new FakeSource()
      sources.push(s)
      return s
    },
    createGain: () => gain,
    createAnalyser: () => ({ fftSize: 0, connect: vi.fn(), getFloatTimeDomainData: (b: Float32Array) => b.fill(0.5) }),
    close: vi.fn(async () => {})
  }
  return { ctx: ctx as unknown as PlayerAudioContext, raw: ctx, sources, gain }
}

const chunk = (samples: number, contextId = 'c1') => ({ pcm: new Int16Array(samples), sampleRate: 24000, contextId })

describe('VoicePlayer', () => {
  it('starts after the jitter buffer and joins chunks without gaps', () => {
    const f = fakeContext()
    const started = vi.fn()
    const p = new VoicePlayer({ createContext: () => f.ctx, onContextStart: started })
    p.enqueue(chunk(2400)) // 0.1 s
    p.enqueue(chunk(4800)) // 0.2 s
    expect(f.sources[0]!.startedAt).toBeCloseTo(10 + JITTER_BUFFER_S)
    expect(f.sources[1]!.startedAt).toBeCloseTo(10 + JITTER_BUFFER_S + 0.1)
    expect(started).toHaveBeenCalledTimes(1)
    expect(started).toHaveBeenCalledWith('c1')
  })

  it('reports idle once everything scheduled has played', () => {
    const f = fakeContext()
    const idle = vi.fn()
    const p = new VoicePlayer({ createContext: () => f.ctx, onIdle: idle })
    p.enqueue(chunk(240))
    p.enqueue(chunk(240))
    f.sources[0]!.onended?.()
    expect(idle).not.toHaveBeenCalled()
    f.sources[1]!.onended?.()
    expect(idle).toHaveBeenCalledTimes(1)
    expect(p.playing).toBe(false)
  })

  it('on barge-in: fades, stops everything and drops late chunks for that reply', () => {
    const f = fakeContext()
    const idle = vi.fn()
    const p = new VoicePlayer({ createContext: () => f.ctx, onIdle: idle })
    p.enqueue(chunk(2400))
    p.enqueue(chunk(2400))
    p.cancel('c1')
    expect(f.sources.every((s) => s.stoppedAt > 0)).toBe(true)
    expect(f.gain.gain.targets[0]).toEqual([0, 10])
    expect(idle).toHaveBeenCalledTimes(1)
    p.enqueue(chunk(2400, 'c1'))
    expect(f.sources).toHaveLength(2)
    p.enqueue(chunk(2400, 'c2'))
    expect(f.sources).toHaveLength(3)
  })

  it('ducks and restores the volume', () => {
    const f = fakeContext()
    const p = new VoicePlayer({ createContext: () => f.ctx })
    p.enqueue(chunk(240))
    p.duck(true)
    expect(f.gain.gain.value).toBe(DUCKED_GAIN)
    p.duck(false)
    expect(f.gain.gain.value).toBe(1)
  })

  it('reports an output level only while playing', () => {
    const f = fakeContext()
    const p = new VoicePlayer({ createContext: () => f.ctx })
    expect(p.level()).toBe(0)
    p.enqueue(chunk(240))
    expect(p.level()).toBeGreaterThan(0.8)
  })

  it('converts Int16 to the -1..1 range', () => {
    expect(Array.from(int16ToFloat32(Int16Array.from([0, 16384, -32768])))).toEqual([0, 0.5, -1])
  })
})
