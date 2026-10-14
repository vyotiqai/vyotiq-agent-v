import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ANTHROPIC_MESSAGES_URL,
  anthropicProvider,
  buildAnthropicBody,
  streamAnthropicMessages
} from '@main/agent/providers/anthropic'
import { anthropicThinkingFields } from '@main/agent/providers/thinkingPolicy'
import { baseModelInfo } from '@main/agent/providers/normalize'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import type { ChatMessage } from '@shared/ipc'
import { parseProviderReasoningState } from '@shared/reasoning'

function sseBody(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

const baseReq = (partial: Partial<ProviderChatRequest> = {}): ProviderChatRequest => ({
  model: 'claude-sonnet-5',
  messages: [{ role: 'user', content: 'hi' }],
  tools: [],
  signal: new AbortController().signal,
  apiKey: 'test-key',
  ...partial
})

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

const signedThinkingStream = (thinking: string): string[] => [
  'data: {"type":"message_start","message":{"usage":{"input_tokens":10,"output_tokens":1}}}\n\n',
  'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}\n\n',
  ...(thinking
    ? [
        `data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":${JSON.stringify(thinking)}}}\n\n`
      ]
    : []),
  'data: {"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"SIG_abc"}}\n\n',
  'data: {"type":"content_block_stop","index":0}\n\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_1","name":"read","input":{}}}\n\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\"a\\"}"}}\n\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
  'data: {"type":"message_stop"}\n\n'
]

function continuation(reasoningState: unknown): ChatMessage[] {
  return [
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'toolu_1', name: 'read', arguments: '{"path":"a"}' }],
      reasoningState
    } as ChatMessage,
    { role: 'tool', toolCallId: 'toolu_1', toolName: 'read', content: 'x' }
  ]
}

function assistantBlocks(body: Record<string, unknown>): Array<Record<string, unknown>> {
  const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
  return msgs.find((m) => m.role === 'assistant')!.content
}

describe('anthropic thinking signatures', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('captures signature_delta and replays the block with it unchanged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseBody(signedThinkingStream('Plan.'))))
    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    const done = chunks.find((c) => c.type === 'done')!
    expect(done.reasoningState).toEqual({
      kind: 'anthropic',
      blocks: [{ type: 'thinking', thinking: 'Plan.', signature: 'SIG_abc' }]
    })
    // The persisted shape survives schema parsing (hydrate / resume).
    expect(parseProviderReasoningState(done.reasoningState)).toEqual(done.reasoningState)

    const body = buildAnthropicBody(baseReq({ messages: continuation(done.reasoningState) }), {
      omitUnsignedThinking: true
    })
    expect(assistantBlocks(body)[0]).toEqual({
      type: 'thinking',
      thinking: 'Plan.',
      signature: 'SIG_abc'
    })
  })

  it('keeps a signed block with empty text (display omitted) and replays it', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseBody(signedThinkingStream(''))))
    const chunks = await collect(anthropicProvider.streamChat(baseReq()))
    // No visible reasoning, so no thinking_done — but the block is kept.
    expect(chunks.some((c) => c.type === 'thinking_done')).toBe(false)
    const done = chunks.find((c) => c.type === 'done')!
    expect(done.reasoningState).toEqual({
      kind: 'anthropic',
      blocks: [{ type: 'thinking', thinking: '', signature: 'SIG_abc' }]
    })
    const body = buildAnthropicBody(baseReq({ messages: continuation(done.reasoningState) }), {
      omitUnsignedThinking: true
    })
    expect(assistantBlocks(body)[0]).toEqual({ type: 'thinking', thinking: '', signature: 'SIG_abc' })
  })

  it('first-party Anthropic omits unsigned blocks; other hosts keep the bare text', async () => {
    const unsigned = { kind: 'anthropic', blocks: [{ type: 'thinking', thinking: 'old reasoning' }] }
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)))
        return sseBody(['data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n'])
      })
    )
    await collect(anthropicProvider.streamChat(baseReq({ messages: continuation(unsigned) })))
    await collect(
      streamAnthropicMessages(
        baseReq({ model: 'minimax-m3', messages: continuation(unsigned) }),
        'https://opencode.ai/zen/go/v1/messages'
      )
    )
    expect(ANTHROPIC_MESSAGES_URL).toBe('https://api.anthropic.com/v1/messages')
    expect(assistantBlocks(bodies[0]!).map((b) => b.type)).toEqual(['tool_use'])
    expect(assistantBlocks(bodies[1]!)[0]).toEqual({ type: 'thinking', thinking: 'old reasoning' })
  })
})

describe('anthropic thinking off on always-thinking models', () => {
  it('omits thinking and sends low effort where `disabled` is rejected', () => {
    for (const model of ['claude-fable-5', 'claude-fable-5-1', 'claude-mythos-5-1', 'claude-opus-5-5']) {
      expect(anthropicThinkingFields(baseReq({ model, thinking: { enabled: false } }))).toEqual({
        output_config: { effort: 'low' }
      })
    }
  })

  it('still sends `disabled` where it is accepted', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8']) {
      expect(anthropicThinkingFields(baseReq({ model, thinking: { enabled: false } }))).toEqual({
        thinking: { type: 'disabled' }
      })
    }
  })

  it('marks the always-thinking models as unable to disable in the catalog', () => {
    expect(baseModelInfo('claude-fable-5-1', {}, 'anthropic').thinkingCanDisable).toBe(false)
    expect(baseModelInfo('claude-opus-5-5', {}, 'anthropic').thinkingCanDisable).toBe(false)
    expect(baseModelInfo('claude-opus-5', {}, 'anthropic').thinkingCanDisable).toBe(true)
  })

  it('keeps a structured-output format when thinking fields add effort', () => {
    const body = buildAnthropicBody(
      baseReq({
        model: 'claude-fable-5',
        thinking: { enabled: false },
        responseFormat: { type: 'json_schema', name: 'x', schema: { type: 'object' } }
      })
    )
    expect(body.thinking).toBeUndefined()
    expect(body.output_config).toEqual({
      format: { type: 'json_schema', schema: { type: 'object' } },
      effort: 'low'
    })
  })
})
