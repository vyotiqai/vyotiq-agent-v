import { describe, expect, it } from 'vitest'
import { compactMessages } from '@main/agent/context/compact'
import {
  assertCircuitClosed,
  circuitKeyProvider,
  inspectCircuit,
  recordCircuitFailure
} from '@main/agent/circuitBreaker'
import type {
  LlmProvider,
  ProviderChatRequest,
  StreamChunk,
  ToolDefinition
} from '@main/agent/providers/types'
import type { ChatMessage } from '@shared/ipc'

function mockProvider(chunks: StreamChunk[]): LlmProvider {
  return {
    id: 'openai',
    async *streamChat() {
      for (const chunk of chunks) yield chunk
    },
    listModels: async () => []
  }
}

function mockProviderPerCall(handlers: Array<() => StreamChunk[]>): LlmProvider {
  let call = 0
  return {
    id: 'openai',
    async *streamChat() {
      const chunks = handlers[Math.min(call, handlers.length - 1)]()
      call++
      for (const chunk of chunks) yield chunk
    },
    listModels: async () => []
  }
}

function capturingProvider(handlers: Array<() => StreamChunk[]>): {
  provider: LlmProvider
  requests: ProviderChatRequest[]
} {
  const requests: ProviderChatRequest[] = []
  let call = 0
  return {
    requests,
    provider: {
      id: 'openai',
      async *streamChat(req) {
        requests.push(req)
        const chunks = handlers[Math.min(call, handlers.length - 1)]()
        call++
        for (const chunk of chunks) yield chunk
      },
      listModels: async () => []
    }
  }
}

const parentToolDefs: ToolDefinition[] = [
  { name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'write', description: 'Write a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'shell', description: 'Run a command', parameters: { type: 'object', properties: { command: { type: 'string' } } } }
]

const history: ChatMessage[] = [
  { role: 'user', content: 'Fix the search tool' },
  { role: 'assistant', content: 'I updated search.ts' }
]

const structuredJson = JSON.stringify({
  sessionIntent: 'Fix search',
  filesTouched: ['src/search.ts'],
  keyDecisions: ['Use gitignore matcher'],
  constraints: [],
  openBlockers: [],
  nextSteps: ['Add tests']
})

describe('compactMessages', () => {
  it('returns null when aborted before work', async () => {
    const controller = new AbortController()
    controller.abort()
    const result = await compactMessages({
      provider: mockProvider([]),
      model: 'gpt-4o',
      signal: controller.signal,
      messages: history
    })
    expect(result).toBeNull()
  })

  it('returns null for empty history', async () => {
    const result = await compactMessages({
      provider: mockProvider([]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: []
    })
    expect(result).toBeNull()
  })

  it('disables thinking on compaction provider calls', async () => {
    const seen: Array<{ enabled?: boolean } | undefined> = []
    const provider: LlmProvider = {
      id: 'ollama',
      async *streamChat(req) {
        seen.push(req.thinking)
        yield { type: 'text', text: structuredJson }
      },
      listModels: async () => []
    }
    const result = await compactMessages({
      provider,
      model: 'glm-5.2',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).not.toBeNull()
    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every((t) => t?.enabled === false)).toBe(true)
  })

  it('uses structured output when the provider returns valid JSON', async () => {
    const result = await compactMessages({
      provider: mockProvider([{ type: 'text', text: structuredJson }]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).not.toBeNull()
    expect(result?.summary).toMatch(/Fix search/i)
    expect(result?.summary).toMatch(/search\.ts/i)
    expect(result?.tokenEstimate).toBeGreaterThan(0)
    expect(result?.createdAt).toBeTruthy()
  })

  it('falls back to freeform when structured output fails', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'schema rejected' }],
        () => [
          { type: 'text', text: '## Session Intent\nShip feature\n\n## Next Steps\n- deploy' }
        ]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result?.summary).toMatch(/Ship feature/i)
  })

  it('uses freeform path when structured output is disabled', async () => {
    const result = await compactMessages({
      provider: mockProvider([
        { type: 'text', text: '## Session Intent\nManual summary\n\n## Next Steps\n- done' }
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: false
    })
    expect(result?.summary).toMatch(/Manual summary/i)
  })

  it('returns null when both structured and freeform produce no summary', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'structured failed' }],
        () => [{ type: 'error', error: 'freeform failed' }]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).toBeNull()
  })

  it('returns null when aborted after structured compaction fails', async () => {
    const controller = new AbortController()
    let freeformCalls = 0

    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => {
          controller.abort()
          return [{ type: 'error', error: 'structured failed' }]
        },
        () => {
          freeformCalls++
          return [{ type: 'text', text: 'freeform unwanted' }]
        }
      ]),
      model: 'gpt-4o',
      signal: controller.signal,
      messages: history,
      supportsStructuredOutput: true
    })

    expect(result).toBeNull()
    expect(freeformCalls).toBe(0)
  })

  it('does not accept partial structured text after abort mid-stream', async () => {
    const controller = new AbortController()
    const provider: LlmProvider = {
      id: 'openai',
      async *streamChat(req) {
        yield { type: 'text', text: '{"sessionIntent":"PARTIAL_ABORT_MARKER"' }
        controller.abort()
        // collectStructuredResponse returns ok:false with rawText on abort
        if (req.signal.aborted) return
        yield { type: 'text', text: ',"filesTouched":[]}' }
      },
      listModels: async () => []
    }
    const result = await compactMessages({
      provider,
      model: 'gpt-4o',
      signal: controller.signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result).toBeNull()
  })

  it('retains prior summary across successive folds', async () => {
    const result = await compactMessages({
      provider: mockProvider([{ type: 'text', text: structuredJson }]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true,
      priorSummary: '## Session Intent\nEarlier fact ALPHA_UNIQUE'
    })
    expect(result?.summary).toMatch(/ALPHA_UNIQUE/)
    expect(result?.summary).toMatch(/Fix search/i)
    expect(result?.summary).toContain('---')
  })

  it('does not count a hard structured stream error as circuit success', async () => {
    const key = circuitKeyProvider('openai')
    recordCircuitFailure(key)

    const result = await compactMessages({
      provider: mockProvider([{ type: 'error', error: 'invalid_request' }]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    // Hard structured errors are never retried and never counted as circuit
    // success.
    expect(result).toBeNull()
    // The breaker never opens (cap removed) — failure counts stay
    // diagnostics-only and can never block a later compaction.
    expect(inspectCircuit(key).state).toBe('closed')
    expect(() => assertCircuitClosed(key)).not.toThrow()
  })

  it('retries a retriable structured stream error instead of falling back to freeform', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'fetch failed: other side closed' }],
        () => [{ type: 'text', text: structuredJson }],
        () => [{ type: 'text', text: '## Session Intent\nSHOULD_NOT_USE_FREEFORM' }]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true
    })
    expect(result?.summary).toMatch(/## Session Intent/)
    expect(result?.summary).toMatch(/Fix search/i)
    expect(result?.summary).not.toMatch(/SHOULD_NOT_USE_FREEFORM/)
  })

  it('retries a retriable freeform stream error then returns the summary', async () => {
    const result = await compactMessages({
      provider: mockProviderPerCall([
        () => [{ type: 'error', error: 'read ECONNRESET' }],
        () => [
          { type: 'text', text: '## Session Intent\nRecovered after reset\n\n## Next Steps\n- continue' }
        ]
      ]),
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: false
    })
    expect(result?.summary).toMatch(/Recovered after reset/i)
  })

  it('message-shape path uses dedicated summarizer instructions without parent harness or tools', async () => {
    const parentStable = 'PARENT_STABLE_HARNESS_UNIQUE'
    const { provider, requests } = capturingProvider([
      () => [
        {
          type: 'text',
          text: '## Session Intent\nForked summary\n\n## Next Steps\n- continue'
        }
      ]
    ])
    const result = await compactMessages({
      provider,
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true,
      forkPrefix: { systemStable: parentStable, toolDefs: parentToolDefs },
      promptCacheKey: 'run-fork-1'
    })
    expect(result?.summary).toMatch(/Forked summary/i)
    expect(requests).toHaveLength(1)
    const req = requests[0]!
    expect(req.tools).toEqual([])
    expect(req.systemStable).toBeUndefined()
    expect(req.system).toMatch(/internal session summarizer/i)
    expect(req.system).toMatch(/untrusted source material/i)
    expect(req.system).not.toContain(parentStable)
    expect(req.systemVolatile).toBeUndefined()
    expect(req.toolChoice).toBe('none')
    expect(req.thinking).toEqual({ enabled: false })
    expect(req.promptCacheKey).toBe('run-fork-1')
    expect(req.messages.slice(0, -1)).toEqual(history)
    const last = req.messages[req.messages.length - 1]!
    expect(last.role).toBe('user')
    expect(String(last.content)).toMatch(/Summarize the preceding session history/)
    expect(String(last.content)).not.toMatch(/^user: Fix the search tool/)
  })

  it('falls back to structured tools=[] when the message-shape summary is empty', async () => {
    const { provider, requests } = capturingProvider([
      () => [{ type: 'error', error: 'fork produced nothing' }],
      () => [{ type: 'text', text: structuredJson }]
    ])
    const result = await compactMessages({
      provider,
      model: 'gpt-4o',
      signal: new AbortController().signal,
      messages: history,
      supportsStructuredOutput: true,
      forkPrefix: { systemStable: 'PARENT_STABLE_HARNESS_UNIQUE', toolDefs: parentToolDefs }
    })
    expect(result?.summary).toMatch(/Fix search/i)
    expect(requests.length).toBeGreaterThanOrEqual(2)
    expect(requests[0]?.tools).toEqual([])
    expect(requests[0]?.toolChoice).toBe('none')
    expect(requests[0]?.system).not.toContain('PARENT_STABLE_HARNESS_UNIQUE')
    const fallback = requests[1]!
    expect(fallback.tools).toEqual([])
    expect(fallback.toolChoice).toBe('none')
    expect(fallback.systemStable).toBeUndefined()
    expect(fallback.system).not.toBe('PARENT_STABLE_HARNESS_UNIQUE')
    expect(fallback.messages).toHaveLength(1)
    expect(fallback.messages[0]?.role).toBe('user')
    expect(String(fallback.messages[0]?.content)).toContain('user: Fix the search tool')
  })

  it('bails the fork ladder on a hard HTTP failure instead of storming fallbacks', async () => {
    // Shape from the 2026-09-02 storm: modal 404 "unknown inference model"
    // previously walked fork → structured → freeform → flattened retry.
    const { provider, requests } = capturingProvider([
      () => [
        {
          type: 'error',
          error: 'HTTP 404: {"error":"unknown inference model"}',
          errorCode: 'PROVIDER_HTTP',
          httpStatus: 404
        }
      ]
    ])
    await expect(
      compactMessages({
        provider,
        model: 'gpt-4o',
        signal: new AbortController().signal,
        messages: history,
        supportsStructuredOutput: true,
        forkPrefix: { systemStable: 'PARENT_STABLE_HARNESS_UNIQUE', toolDefs: parentToolDefs }
      })
    ).rejects.toThrow(/unknown inference model/)
    expect(requests).toHaveLength(1)
  })

  it('surfaces a hard HTTP failure from the structured path without freeform fallback', async () => {
    const { provider, requests } = capturingProvider([
      () => [
        {
          type: 'error',
          error: 'HTTP 401: {"error":"invalid proxy auth credentials"}',
          errorCode: 'PROVIDER_HTTP',
          httpStatus: 401
        }
      ]
    ])
    await expect(
      compactMessages({
        provider,
        model: 'gpt-4o',
        signal: new AbortController().signal,
        messages: history,
        supportsStructuredOutput: true
      })
    ).rejects.toThrow(/invalid proxy auth credentials/)
    expect(requests).toHaveLength(1)
  })
})
