import { describe, expect, it } from 'vitest'
import {
  appendAssistantWithTools,
  appendToolResult,
  messagesForNextTurn
} from '@shared/chatHistory'
import { contentToText } from '@shared/ipc'
import type { ChatMessage } from '@shared/ipc'

describe('chatHistory', () => {
  it('keeps tool + assistant toolCalls across turns and filters system', () => {
    let msgs: ChatMessage[] = [{ role: 'user', content: 'first' }]
    msgs = appendAssistantWithTools(msgs, '', [
      { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }
    ])
    msgs = appendToolResult(msgs, 'c1', 'read', 'contents')
    msgs = appendAssistantWithTools(msgs, 'done')
    msgs = [...msgs, { role: 'system', content: 'ignore' }, { role: 'user', content: 'second' }]

    const next = messagesForNextTurn(msgs)
    expect(next.some((m) => m.role === 'system')).toBe(false)
    expect(next.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(next.some((m) => m.role === 'tool')).toBe(true)
    expect(next.some((m) => m.role === 'assistant' && m.toolCalls?.length)).toBe(true)
  })

  it('omits empty toolCalls on assistant messages', () => {
    const msgs = appendAssistantWithTools([{ role: 'user', content: 'hi' }], 'ok', [])
    expect(msgs[1]).toEqual({ role: 'assistant', content: 'ok' })
  })

  it('preserves thinking and reasoning state on assistant messages', () => {
    const msgs = appendAssistantWithTools(
      [{ role: 'user', content: 'hi' }],
      'answer',
      [{ id: 'c1', name: 'read', arguments: '{}' }],
      'plan first',
      { kind: 'openai_compat', reasoningContent: 'plan first' }
    )
    expect(msgs[1]).toMatchObject({
      role: 'assistant',
      content: 'answer',
      thinking: 'plan first',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
    })
  })

  it('contentToText flattens multimodal user parts', () => {
    expect(contentToText('plain')).toBe('plain')
    expect(
      contentToText([
        { type: 'text', text: 'see' },
        { type: 'image_url', url: 'data:image/png;base64,aa' }
      ])
    ).toContain('[image]')
  })
})
