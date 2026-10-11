import { describe, expect, it } from 'vitest'
import { SpokenStreamParser, extractSpokenBlock, stripSpokenBlock } from '@shared/spokenSummary'

function streamThrough(text: string, chunk: number): { spoken: string; phase: string } {
  const p = new SpokenStreamParser()
  let spoken = ''
  for (let i = 0; i < text.length; i += chunk) spoken += p.push(text.slice(i, i + chunk))
  spoken += p.end()
  return { spoken, phase: p.phase }
}

const ANSWER = '  <spoken>I fixed the race. Tests pass.</spoken>\n\n## Details\n\n```ts\nconst x = 1\n```'

describe('SpokenStreamParser', () => {
  it.each([1, 2, 3, 5, 9, 1000])('yields exactly the block contents at chunk size %i', (size) => {
    expect(streamThrough(ANSWER, size)).toEqual({ spoken: 'I fixed the race. Tests pass.', phase: 'after' })
  })

  it('never speaks a closing tag split across deltas', () => {
    const p = new SpokenStreamParser()
    const parts = ['<spoken>Done', ' now.</sp', 'oken> rest']
    const out = parts.map((d) => p.push(d))
    expect(out).toEqual(['Done', ' now.', ''])
  })

  it('gives up when the answer does not open with the tag', () => {
    expect(streamThrough('Here is the fix: <spoken>no</spoken>', 4)).toEqual({ spoken: '', phase: 'absent' })
    expect(streamThrough('<span>x</span>', 2)).toEqual({ spoken: '', phase: 'absent' })
  })

  it('speaks an unterminated block at the end, minus any partial closing tag', () => {
    expect(streamThrough('<spoken>Cut off mid </spo', 3)).toEqual({ spoken: 'Cut off mid ', phase: 'after' })
  })

  it('treats an empty stream as absent', () => {
    expect(streamThrough('   ', 1)).toEqual({ spoken: '', phase: 'absent' })
  })
})

describe('stripSpokenBlock', () => {
  it('removes a leading block and the whitespace after it', () => {
    expect(stripSpokenBlock(ANSWER)).toMatch(/^## Details/)
  })

  it('hides a block that is still streaming, and a partial opening tag', () => {
    expect(stripSpokenBlock('<spoken>half a sum')).toBe('')
    expect(stripSpokenBlock('<spo')).toBe('')
  })

  it('leaves answers without a leading block alone', () => {
    expect(stripSpokenBlock('Plain answer <spoken>x</spoken>')).toBe('Plain answer <spoken>x</spoken>')
    expect(stripSpokenBlock('<span>html</span>')).toBe('<span>html</span>')
  })

  it('extracts a complete block only', () => {
    expect(extractSpokenBlock(ANSWER)).toBe('I fixed the race. Tests pass.')
    expect(extractSpokenBlock('<spoken>open')).toBeNull()
  })
})
