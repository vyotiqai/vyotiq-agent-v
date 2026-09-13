import { describe, expect, it } from 'vitest'
import {
  extractAskQuestionDecisions,
  loopHintForRetainedDecisions
} from '@main/agent/context/retainedDecisions'
import { trimToolResults } from '@main/agent/context/toolTrim'
import type { ChatMessage } from '@shared/ipc'

describe('retained decisions + durable trim', () => {
  it('extracts User answered lines from ask_question tool results', () => {
    const msgs: ChatMessage[] = [
      {
        role: 'tool',
        toolCallId: '1',
        toolName: 'ask_question',
        content: 'User answered: Productionize (lint/type-check node, specialized agents)'
      },
      { role: 'tool', toolCallId: '2', toolName: 'read', content: 'file' }
    ]
    expect(extractAskQuestionDecisions(msgs)).toEqual([
      'Productionize (lint/type-check node, specialized agents)'
    ])
    expect(loopHintForRetainedDecisions(extractAskQuestionDecisions(msgs))).toContain(
      'Productionize'
    )
  })

  it('clears old read bodies (re-fetchable) but never stubs ask_question', () => {
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: '1', toolName: 'read', content: 'BODY' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '2', name: 'ask_question', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: '2',
        toolName: 'ask_question',
        content: 'User answered: Ship it'
      },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: '3', name: 'terminal', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: '3', toolName: 'terminal', content: 'T2' }
    ]
    const trimmed = trimToolResults(msgs, 1)
    expect(trimmed.find((m) => m.toolName === 'read')?.content).toBe('[cleared]')
    expect(trimmed.find((m) => m.toolName === 'ask_question')?.content).toBe(
      'User answered: Ship it'
    )
    expect(trimmed.find((m) => m.toolName === 'terminal')?.content).toBe('T2')
  })
})
