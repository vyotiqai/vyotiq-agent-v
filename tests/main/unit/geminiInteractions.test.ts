import { describe, expect, it } from 'vitest'
import { toInteractionsInput } from '@main/agent/providers/geminiInteractions'

describe('Gemini Interactions tool-arg wiring', () => {
  it('wraps a bare ask_question array for replay', () => {
    const messages = [
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [
          {
            id: 'q1',
            name: 'ask_question',
            arguments: '[{"id":"q1","prompt":"Pick one","type":"multiple_choice","options":[{"id":"a","label":"A"}]}]'
          }
        ]
      }
    ]
    const input = toInteractionsInput(messages, undefined, false)
    const call = input.find(
      (part) => part.type === 'function_call' && (part.function_call as { name?: string })?.name === 'ask_question'
    )
    expect(call).toBeTruthy()
    const args = (call!.function_call as { args?: Record<string, unknown> }).args
    expect(args).toEqual({
      questions: [{ id: 'q1', prompt: 'Pick one', type: 'multiple_choice', options: [{ id: 'a', label: 'A' }] }]
    })
  })
})
