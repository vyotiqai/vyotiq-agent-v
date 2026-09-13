import { describe, expect, it } from 'vitest'
import { dedupeToolCalls, ensureToolCallIds } from '@main/agent/dedupeToolCalls'

describe('ensureToolCallIds', () => {
  it('fills empty and whitespace ids with stable unique values', () => {
    const out = ensureToolCallIds(
      [
        { id: '', name: 'web_fetch', arguments: '{}' },
        { id: '  ', name: 'terminal', arguments: '{}' },
        { id: 'keep-me', name: 'read', arguments: '{}' }
      ],
      { step: 3 }
    )
    expect(out[0]!.id).toMatch(/^call_3_0_/)
    expect(out[1]!.id).toMatch(/^call_3_1_/)
    expect(out[2]!.id).toBe('keep-me')
    expect(out[0]!.id).not.toBe(out[1]!.id)
  })

  it('trims non-empty ids', () => {
    const out = ensureToolCallIds([{ id: '  call_x  ', name: 'read', arguments: '{}' }])
    expect(out[0]!.id).toBe('call_x')
  })
})

describe('dedupeToolCalls', () => {
  it('keeps empty-id calls distinct by position', () => {
    const out = dedupeToolCalls([
      { id: '', name: 'read', arguments: '{"path":"a"}' },
      { id: '', name: 'read', arguments: '{"path":"b"}' }
    ])
    expect(out).toHaveLength(2)
  })
})
