import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/ipc'
import { pageOverlap } from '@renderer/lib/hooks/createChatStreamController'

const call = (id: string): ChatMessage => ({ role: 'assistant', content: '', toolCalls: [{ id, name: 'read', arguments: '{}' }] })
const result = (id: string, content = 'ok'): ChatMessage => ({ role: 'tool', toolCallId: id, toolName: 'read', content })

describe('pageOverlap (load earlier)', () => {
  it('keeps every earlier row that only looks like one in the loaded tail', () => {
    // Tool-only assistant rows (content '') and repeated short results used to
    // be dropped as "already loaded" whenever the tail held a lookalike.
    const page = [call('c1'), result('c1'), call('c2'), result('c2')]
    const tail = [call('c9'), result('c9')]
    expect(pageOverlap(page, tail)).toBe(0)
  })

  it('drops exactly the rows a stale cursor repeated at the seam', () => {
    const page = [call('c1'), result('c1'), call('c2'), result('c2')]
    const tail = [call('c2'), result('c2'), call('c3')]
    expect(pageOverlap(page, tail)).toBe(2)
  })

  it('finds no overlap when the page ends where the tail begins', () => {
    expect(pageOverlap([{ role: 'user', content: 'a' }], [{ role: 'user', content: 'b' }])).toBe(0)
  })
})
