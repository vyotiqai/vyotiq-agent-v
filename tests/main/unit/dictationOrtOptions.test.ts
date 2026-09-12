import { describe, expect, it } from 'vitest'
import {
  buildOrtSessionOptions,
  resolveOrtIntraOpThreads
} from '@main/dictation/ortSessionOptions'

describe('dictation ortSessionOptions', () => {
  it('in-process intra-op stays at 1 even when env asks for more', () => {
    expect(resolveOrtIntraOpThreads(undefined)).toBe(1)
    expect(resolveOrtIntraOpThreads('')).toBe(1)
    expect(resolveOrtIntraOpThreads('0')).toBe(1)
    expect(resolveOrtIntraOpThreads('2')).toBe(1)
    expect(resolveOrtIntraOpThreads('8')).toBe(1)
    expect(resolveOrtIntraOpThreads('1.9', 'in-process')).toBe(1)
  })

  it('utility intra-op defaults to 4 and clamps env to 1–8', () => {
    expect(resolveOrtIntraOpThreads(undefined, 'utility', 8)).toBe(4)
    expect(resolveOrtIntraOpThreads(undefined, 'utility', 2)).toBe(4)
    expect(resolveOrtIntraOpThreads('3', 'utility', 16)).toBe(3)
    expect(resolveOrtIntraOpThreads('8', 'utility', 16)).toBe(8)
    expect(resolveOrtIntraOpThreads('99', 'utility', 16)).toBe(8)
    expect(resolveOrtIntraOpThreads('0', 'utility', 8)).toBe(4)
  })

  it('builds sequential session options with spinning and mem-pattern disabled', () => {
    const opts = buildOrtSessionOptions('2', 'utility')
    expect(opts.intraOpNumThreads).toBe(2)
    expect(opts.interOpNumThreads).toBe(1)
    expect(opts.executionMode).toBe('sequential')
    expect(opts.enableCpuMemArena).toBe(false)
    expect(opts.enableMemPattern).toBe(false)
    expect(opts['session.intra_op.allow_spinning']).toBe('0')
    expect(buildOrtSessionOptions('8').intraOpNumThreads).toBe(1)
  })
})
