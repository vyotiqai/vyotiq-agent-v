import { beforeEach, describe, expect, it } from 'vitest'
import {
  resetErrorLogRateLimiter,
  shouldLogErrorSignature
} from '@renderer/logging/errorLogRateLimiter'

describe('shouldLogErrorSignature', () => {
  beforeEach(() => {
    resetErrorLogRateLimiter()
  })

  it('logs the first occurrence and suppresses same-signature repeats inside the window', () => {
    expect(shouldLogErrorSignature('REACT_185\u0000Maximum update depth exceeded', 1_000)).toEqual({
      log: true,
      suppressed: 0
    })
    expect(shouldLogErrorSignature('REACT_185\u0000Maximum update depth exceeded', 2_000)).toEqual({
      log: false,
      suppressed: 0
    })
    expect(shouldLogErrorSignature('REACT_185\u0000Maximum update depth exceeded', 5_900)).toEqual({
      log: false,
      suppressed: 0
    })
  })

  it('logs again after the window elapses and reports the suppressed count', () => {
    const signature = 'RENDERER_CRASH\u0000boom'
    expect(shouldLogErrorSignature(signature, 1_000).log).toBe(true)
    for (let i = 0; i < 7; i++) {
      expect(shouldLogErrorSignature(signature, 1_100 + i).log).toBe(false)
    }
    expect(shouldLogErrorSignature(signature, 6_001)).toEqual({ log: true, suppressed: 7 })
  })

  it('tracks signatures independently', () => {
    expect(shouldLogErrorSignature('a', 1_000).log).toBe(true)
    expect(shouldLogErrorSignature('b', 1_100).log).toBe(true)
    expect(shouldLogErrorSignature('a', 2_000).log).toBe(false)
    expect(shouldLogErrorSignature('b', 2_100).log).toBe(false)
  })
})
