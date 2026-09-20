import { describe, expect, it } from 'vitest'
import {
  RUN_VOICE_PHRASES,
  RUN_VOICE_ROTATE_MS,
  runVoicePhrase,
  runVoiceTick,
  type VoicePhase
} from '@renderer/features/chat/utils/runVoice'

const PHASES = Object.keys(RUN_VOICE_PHRASES) as VoicePhase[]

describe('RUN_VOICE_PHRASES', () => {
  it('leads every pool with the plain word', () => {
    expect(RUN_VOICE_PHRASES.working[0]).toBe('Working')
    expect(RUN_VOICE_PHRASES.thinking[0]).toBe('Thinking')
    expect(RUN_VOICE_PHRASES.planning[0]).toBe('Planning')
    expect(RUN_VOICE_PHRASES.writing[0]).toBe('Writing')
  })

  it('keeps every phrase short enough to survive the truncating timeline row', () => {
    for (const phase of PHASES) {
      for (const phrase of RUN_VOICE_PHRASES[phase]) {
        expect(phrase.trim()).toBe(phrase)
        expect(phrase.length).toBeLessThanOrEqual(24)
        expect(phrase.split(' ').length).toBeLessThanOrEqual(4)
        // Sentence-cased like every other timeline verb ("Reading", "Grepping").
        expect(phrase[0]).toBe(phrase[0]!.toUpperCase())
      }
    }
  })

  it('gives every pool room to rotate without repeating itself', () => {
    for (const phase of PHASES) {
      const pool = RUN_VOICE_PHRASES[phase]
      expect(pool.length).toBeGreaterThanOrEqual(2)
      expect(new Set(pool).size).toBe(pool.length)
    }
  })
})

describe('runVoicePhrase', () => {
  it('is stable for the same tick, so re-renders never reshuffle the word', () => {
    for (const phase of PHASES) {
      const first = runVoicePhrase(phase, 3)
      for (let i = 0; i < 20; i += 1) expect(runVoicePhrase(phase, 3)).toBe(first)
    }
  })

  it('opens on the plain word so a one-beat phase reads literally', () => {
    for (const phase of PHASES) {
      expect(runVoicePhrase(phase, 0)).toBe(RUN_VOICE_PHRASES[phase][0])
      expect(runVoicePhrase(phase)).toBe(RUN_VOICE_PHRASES[phase][0])
    }
  })

  it('walks the whole pool before any phrase comes round again', () => {
    for (const phase of PHASES) {
      const pool = RUN_VOICE_PHRASES[phase]
      const seen = pool.map((_, tick) => runVoicePhrase(phase, tick))
      expect(seen).toEqual([...pool])
      expect(runVoicePhrase(phase, pool.length)).toBe(pool[0])
    }
  })

  it('never shows the same phrase two ticks running', () => {
    for (const phase of PHASES) {
      for (let tick = 0; tick < 40; tick += 1) {
        expect(runVoicePhrase(phase, tick)).not.toBe(runVoicePhrase(phase, tick + 1))
      }
    }
  })

  it('treats a nonsense tick as the start of the rotation', () => {
    expect(runVoicePhrase('working', -5)).toBe('Working')
    expect(runVoicePhrase('working', Number.NaN)).toBe('Working')
    expect(runVoicePhrase('working', Number.POSITIVE_INFINITY)).toBe('Working')
  })
})

describe('runVoiceTick', () => {
  it('holds a phrase for the full rotation window', () => {
    expect(runVoiceTick(0)).toBe(0)
    expect(runVoiceTick(RUN_VOICE_ROTATE_MS - 1)).toBe(0)
    expect(runVoiceTick(RUN_VOICE_ROTATE_MS)).toBe(1)
    expect(runVoiceTick(RUN_VOICE_ROTATE_MS * 3 + 10)).toBe(3)
  })

  it('reads a missing or impossible duration as the start', () => {
    expect(runVoiceTick(null)).toBe(0)
    expect(runVoiceTick(undefined)).toBe(0)
    expect(runVoiceTick(-1_000)).toBe(0)
    expect(runVoiceTick(Number.NaN)).toBe(0)
  })
})
