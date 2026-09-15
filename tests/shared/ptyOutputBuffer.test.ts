import { describe, expect, it } from 'vitest'
import {
  appendPtyOutputBuffer,
  prunePtyOutputBuffers,
  PTY_OUTPUT_BUFFER_MAX_CHARS
} from '@shared/utils/ptyOutputBuffer'

describe('ptyOutputBuffer', () => {
  it('appends and returns the combined buffer', () => {
    const buffers = new Map<string, string>()
    expect(appendPtyOutputBuffer(buffers, 'a', 'hi')).toBe('hi')
    expect(appendPtyOutputBuffer(buffers, 'a', ' there')).toBe('hi there')
    expect(buffers.get('a')).toBe('hi there')
  })

  it('trims from the front when over the max', () => {
    const buffers = new Map<string, string>()
    appendPtyOutputBuffer(buffers, 'a', 'abcdef', 4)
    expect(buffers.get('a')).toBe('cdef')
    appendPtyOutputBuffer(buffers, 'a', 'gh', 4)
    expect(buffers.get('a')).toBe('efgh')
  })

  it('uses the shared default max', () => {
    const buffers = new Map<string, string>()
    const chunk = 'x'.repeat(PTY_OUTPUT_BUFFER_MAX_CHARS + 50)
    appendPtyOutputBuffer(buffers, 'a', chunk)
    expect(buffers.get('a')?.length).toBe(PTY_OUTPUT_BUFFER_MAX_CHARS)
  })

  it('keeps repeated appends capped, retaining the tail', () => {
    const buffers = new Map<string, string>()
    const half = PTY_OUTPUT_BUFFER_MAX_CHARS / 2
    appendPtyOutputBuffer(buffers, 'a', 'x'.repeat(half))
    appendPtyOutputBuffer(buffers, 'a', 'y'.repeat(half))
    // Third append pushes past the cap: the oldest half (x) must be dropped.
    appendPtyOutputBuffer(buffers, 'a', 'z'.repeat(half))
    const out = buffers.get('a')
    expect(out?.length).toBe(PTY_OUTPUT_BUFFER_MAX_CHARS)
    expect(out).toBe('y'.repeat(half) + 'z'.repeat(half))
  })

  it('prunes buffers for dead sessions', () => {
    const buffers = new Map<string, string>([
      ['live', '1'],
      ['dead', '2']
    ])
    prunePtyOutputBuffers(buffers, ['live'])
    expect([...buffers.keys()]).toEqual(['live'])
  })
})
