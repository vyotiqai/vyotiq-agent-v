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

  it('prunes buffers for dead sessions', () => {
    const buffers = new Map<string, string>([
      ['live', '1'],
      ['dead', '2']
    ])
    prunePtyOutputBuffers(buffers, ['live'])
    expect([...buffers.keys()]).toEqual(['live'])
  })
})
