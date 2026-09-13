import { afterEach, describe, expect, it, vi } from 'vitest'
import { opencodeProvider } from '@main/agent/providers/opencode'
import type { ModelInfo, ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'

function sseBody(frames: string[]): Response {
  return new Response(frames.join(''), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

// Each frame must carry its own SSE delimiters (event/data lines end with \n, events with \n\n).
const CHAT_FRAMES = [
  'data: {"choices":[{"delta":{"reasoning_content":"I will think first.","content":""}}]}\n\n',
  'data: {"choices":[{"delta":{"content":"Hello!"}}]}\n\n',
  'data: [DONE]\n\n'
]

const MESSAGES_FRAMES = [
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"Let me reason step by step."}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":1}\n\n',
  'event: content_block_start\n',
  'data: {"type":"content_block_start","index":2,"content_block":{"type":"text"}}\n\n',
  'event: content_block_delta\n',
  'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Hello!"}}\n\n',
  'event: content_block_stop\n',
  'data: {"type":"content_block_stop","index":2}\n\n',
  'event: message_delta\n',
  'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":10,"output_tokens":5}}\n\n',
  'event: message_stop\n',
  'data: {"type":"message_stop"}\n\n'
]

const RESPONSES_FRAMES = [
  'data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think carefully."}\n\n',
  'data: {"type":"response.output_text.delta","delta":"Hi there."}\n\n',
  'data: {"type":"response.completed"}\n\n'
]

function modelInfoFor(api: ModelInfo['thinkingApi'], efforts: ModelInfo['supportedThinkingEfforts']): ModelInfo {
  return {
    id: 'x',
    displayName: 'x',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportsTools: true,
    supportsVision: false,
    supportsThinking: true,
    thinkingApi: api,
    thinkingCanDisable: true,
    thinkingMode: 'effort',
    supportedThinkingEfforts: efforts,
    contextWindow: 128_000
  }
}

function reqFor(model: string, api: ModelInfo['thinkingApi'], efforts: ModelInfo['supportedThinkingEfforts']): ProviderChatRequest {
  return {
    model,
    messages: [{ role: 'user', content: 'hi' }],
    tools: [],
    signal: new AbortController().signal,
    apiKey: 'test-key',
    thinking: { enabled: true, effort: 'medium', display: 'summarized' },
    modelInfo: modelInfoFor(api, efforts)
  }
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

function thinkingText(chunks: StreamChunk[]): string {
  return chunks
    .filter((c): c is Extract<StreamChunk, { type: 'thinking_delta' }> => c.type === 'thinking_delta')
    .map((c) => c.text)
    .join('')
}

describe('opencode thinking streams across all three transports', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('chat/completions route emits reasoning_content as thinking_delta (deepseek-v4-pro)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/chat/completions')
        return sseBody(CHAT_FRAMES)
      })
    )
    const chunks = await collect(opencodeProvider.streamChat(reqFor('deepseek-v4-pro', 'chat_completions', ['low', 'medium', 'high'])))
    expect(thinkingText(chunks)).toContain('I will think first.')
  })

  it('messages route emits thinking_delta (qwen3.8-max)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/messages')
        return sseBody(MESSAGES_FRAMES)
      })
    )
    const chunks = await collect(opencodeProvider.streamChat(reqFor('qwen3.8-max', 'messages', ['low', 'medium', 'high', 'xhigh', 'max'])))
    expect(thinkingText(chunks)).toContain('Let me reason step by step.')
  })

  it('responses route emits reasoning summary as thinking_delta (gpt-5.6-luna)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        expect(url).toContain('/responses')
        return sseBody(RESPONSES_FRAMES)
      })
    )
    const chunks = await collect(opencodeProvider.streamChat(reqFor('gpt-5.6-luna', 'responses', ['minimal', 'low', 'medium', 'high', 'xhigh'])))
    expect(thinkingText(chunks)).toContain('Let me think carefully.')
  })

  it('auto-enables thinking even when req.thinking is omitted (deepseek-v4-pro)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => sseBody(CHAT_FRAMES))
    )
    const req = reqFor('deepseek-v4-pro', 'chat_completions', ['low', 'medium', 'high'])
    delete (req as { thinking?: unknown }).thinking
    const chunks = await collect(opencodeProvider.streamChat(req))
    expect(thinkingText(chunks)).toContain('I will think first.')
  })
})
