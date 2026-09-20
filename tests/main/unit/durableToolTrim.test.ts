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

  describe('trim slack keeps the cached prefix stable', () => {
    const readResult = (n: number): ChatMessage => ({
      role: 'tool',
      toolCallId: `t${n}`,
      toolName: 'read',
      content: `body ${n}`
    })

    it('is a no-op while within keepLast + slack, so history stays byte-identical', () => {
      // 10 results, keep 6 with slack 6 => ceiling 12, nothing stubbed yet.
      const msgs = Array.from({ length: 10 }, (_, i) => readResult(i))
      const trimmed = trimToolResults(msgs, 6, 6)
      expect(trimmed).toBe(msgs)
    })

    it('trims down to keepLast once the ceiling is crossed', () => {
      const msgs = Array.from({ length: 13 }, (_, i) => readResult(i))
      const trimmed = trimToolResults(msgs, 6, 6)
      const full = trimmed.filter((m) => m.content !== '[cleared]')
      expect(full).toHaveLength(6)
      // The newest six survive intact.
      expect(full.map((m) => m.content)).toEqual([
        'body 7',
        'body 8',
        'body 9',
        'body 10',
        'body 11',
        'body 12'
      ])
    })

    it('stays exact with no slack, so the pre-compaction wire trim is unchanged', () => {
      const msgs = Array.from({ length: 10 }, (_, i) => readResult(i))
      const trimmed = trimToolResults(msgs, 6)
      expect(trimmed.filter((m) => m.content !== '[cleared]')).toHaveLength(6)
    })

    it('does not re-trim repeatedly once already at the floor', () => {
      const msgs = Array.from({ length: 13 }, (_, i) => readResult(i))
      const once = trimToolResults(msgs, 6, 6)
      // Already-stubbed results no longer count as un-stubbed, so a second
      // pass with no new results must not rewrite anything.
      expect(trimToolResults(once, 6, 6)).toBe(once)
    })
  })
})
