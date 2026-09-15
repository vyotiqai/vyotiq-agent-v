import { describe, expect, it } from 'vitest'
import { toResponsesInput } from '@main/agent/providers/openaiResponses'
import {
  serializeToolArgs,
  toInteractionsInput
} from '@main/agent/providers/geminiInteractions'
import { estimateMessagesTokensAsync } from '@main/agent/context/estimate'
import { volatileSessionMessage } from '@main/agent/providers/systemZones'

describe('OpenAI Responses input', () => {
  it('sends only trailing tool outputs on continuation', () => {
    const messages = [
      { role: 'user' as const, content: 'read file' },
      {
        role: 'assistant' as const,
        content: '',
        reasoningState: {
          kind: 'openai_responses' as const,
          responseId: 'resp_1',
          outputItems: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }]
        },
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'file contents' }
    ]
    const input = toResponsesInput(
      messages,
      undefined,
      {
        kind: 'openai_responses',
        responseId: 'resp_1',
        outputItems: []
      },
      { systemStable: 'stable', systemVolatile: 'clock=step-2' }
    )
    expect(input).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'file contents' },
      { role: 'user', content: volatileSessionMessage('clock=step-2').content }
    ])
  })

  it('includes a new user follow-up instead of an empty trailing-tool continuation', () => {
    const messages = [
      { role: 'user' as const, content: 'read file' },
      {
        role: 'assistant' as const,
        content: 'done',
        reasoningState: {
          kind: 'openai_responses' as const,
          responseId: 'resp_1',
          outputItems: []
        }
      },
      { role: 'user' as const, content: 'now summarize it' }
    ]
    const input = toResponsesInput(messages, 'system prompt', {
      kind: 'openai_responses',
      responseId: 'resp_1',
      outputItems: []
    })
    expect(input).toEqual([{ role: 'user', content: 'now summarize it' }])
  })

  it('includes tool results plus a newer user turn on continuation', () => {
    const messages = [
      { role: 'user' as const, content: 'read file' },
      {
        role: 'assistant' as const,
        content: '',
        reasoningState: {
          kind: 'openai_responses' as const,
          responseId: 'resp_1',
          outputItems: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }]
        },
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'file contents' },
      { role: 'user' as const, content: 'summarize that' }
    ]
    const input = toResponsesInput(messages, undefined, {
      kind: 'openai_responses',
      responseId: 'resp_1',
      outputItems: []
    })
    expect(input).toEqual([
      { type: 'function_call_output', call_id: 'c1', output: 'file contents' },
      { role: 'user', content: 'summarize that' }
    ])
  })

  it('replays output items for assistant tool turns on first request', () => {
    const messages = [
      { role: 'user' as const, content: 'go' },
      {
        role: 'assistant' as const,
        content: '',
        reasoningState: {
          kind: 'openai_responses' as const,
          outputItems: [{ type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' }]
        },
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      }
    ]
    const input = toResponsesInput(messages, 'system prompt')
    expect(input[0]).toEqual({ role: 'developer', content: 'system prompt' })
    expect(input[1]).toEqual({ role: 'user', content: 'go' })
    expect(input[2]).toEqual({
      type: 'function_call',
      call_id: 'c1',
      name: 'read',
      arguments: '{}'
    })
  })

  it('wires broken tool-call arguments to parseable JSON when replaying history', () => {
    const input = toResponsesInput(
      [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'edit', arguments: '[' }]
        }
      ],
      'system'
    )
    const call = input.find((row) => (row as { type?: string }).type === 'function_call') as {
      arguments: string
    }
    expect(call).toBeTruthy()
    expect(() => JSON.parse(call.arguments)).not.toThrow()
  })
})

describe('Gemini Interactions input', () => {
  it('sends only trailing tool results on continuation, as native function responses', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ]
    const input = toInteractionsInput(messages, 'system', true, {
      systemStable: 'stable',
      systemVolatile: 'clock=step-2'
    })
    expect(input).toEqual([
      {
        type: 'function_response',
        function_response: { id: 'c1', name: 'read', response: { output: 'ok' } }
      },
      { type: 'text', text: volatileSessionMessage('clock=step-2').content }
    ])
  })

  it('includes a new user follow-up instead of an empty trailing-tool continuation', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: 'hello',
        reasoningState: {
          kind: 'gemini_interactions' as const,
          interactionId: 'int_1'
        }
      },
      { role: 'user' as const, content: 'what next?' }
    ]
    const input = toInteractionsInput(messages, 'system', true)
    expect(input).toBe('what next?')
  })

  it('includes tool results plus a newer user turn on continuation', () => {
    const messages = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: '',
        reasoningState: {
          kind: 'gemini_interactions' as const,
          interactionId: 'int_1'
        },
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'ok' },
      { role: 'user' as const, content: 'thanks, continue' }
    ]
    const input = toInteractionsInput(messages, 'system', true)
    expect(input).toEqual([
      {
        type: 'function_response',
        function_response: { id: 'c1', name: 'read', response: { output: 'ok' } }
      },
      { type: 'text', text: 'thanks, continue' }
    ])
  })

  it('replays assistant tool calls as function_call parts before their function_responses', () => {
    const messages = [
      { role: 'user' as const, content: 'read a.ts then b.ts' },
      {
        role: 'assistant' as const,
        content: 'Reading them now.',
        toolCalls: [
          { id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'c2', name: 'read', arguments: '{"path":"b.ts"}' }
        ]
      },
      { role: 'tool' as const, toolCallId: 'c1', toolName: 'read', content: 'a contents' },
      { role: 'tool' as const, toolCallId: 'c2', toolName: 'read', content: 'b contents' }
    ]
    const input = toInteractionsInput(messages, undefined, false)
    expect(input).toEqual([
      { type: 'text', text: 'read a.ts then b.ts' },
      { type: 'text', text: 'Reading them now.' },
      {
        type: 'function_call',
        function_call: { id: 'c1', name: 'read', args: { path: 'a.ts' } }
      },
      {
        type: 'function_call',
        function_call: { id: 'c2', name: 'read', args: { path: 'b.ts' } }
      },
      {
        type: 'function_response',
        function_response: { id: 'c1', name: 'read', response: { output: 'a contents' } }
      },
      {
        type: 'function_response',
        function_response: { id: 'c2', name: 'read', response: { output: 'b contents' } }
      }
    ])
  })

  it('keeps user images as Interactions ImageContent instead of flattening them away', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'what is this' },
          { type: 'image_url' as const, url: 'data:image/png;base64,AAAA' }
        ]
      }
    ]
    const input = toInteractionsInput(messages, undefined, false)
    expect(input).toEqual([
      { type: 'text', text: 'what is this' },
      { type: 'image', data: 'AAAA', mime_type: 'image/png' }
    ])
  })

  it('passes https image URLs as ImageContent uri', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'look' },
          { type: 'image_url' as const, url: 'https://example.com/x.png' }
        ]
      }
    ]
    const input = toInteractionsInput(messages, undefined, false)
    expect(input).toEqual([
      { type: 'text', text: 'look' },
      { type: 'image', uri: 'https://example.com/x.png', mime_type: 'image/png' }
    ])
  })

  it('emits an omission marker for unsupported image URL schemes', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'look' },
          { type: 'image_url' as const, url: 'file:///C:/tmp/x.png' }
        ]
      }
    ]
    const input = toInteractionsInput(messages, undefined, false)
    expect(input).toEqual([
      { type: 'text', text: 'look' },
      {
        type: 'text',
        text: '[image omitted: Gemini Interactions requires a base64 data URL or http(s) image URI]'
      }
    ])
  })

  it('serializes object tool args as JSON', () => {
    expect(serializeToolArgs({ path: '/tmp' })).toBe('{"path":"/tmp"}')
    expect(serializeToolArgs('[object Object]')).toBe('[object Object]')
  })
})

describe('OpenAI Responses multimodal input', () => {
  it('sends images as input_image parts instead of dropping them', () => {
    const messages = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'describe' },
          { type: 'image_url' as const, url: 'data:image/png;base64,AAAA' }
        ]
      }
    ]
    const input = toResponsesInput(messages, undefined)
    expect(input[0]).toEqual({
      role: 'user',
      content: [
        { type: 'input_text', text: 'describe' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' }
      ]
    })
  })
})

describe('token estimation', () => {
  it('includes thinking and reasoning state in message estimates', async () => {
    const messages = [
      {
        role: 'user' as const,
        content: 'hello'
      },
      {
        role: 'assistant' as const,
        content: 'answer',
        thinking: 'long '.repeat(20),
        reasoningState: { kind: 'openai_compat' as const, reasoningContent: 'blob' }
      }
    ]
    const base = await estimateMessagesTokensAsync([{ role: 'user', content: 'hello' }])
    const full = await estimateMessagesTokensAsync(messages)
    expect(full).toBeGreaterThan(base)
  })
})
