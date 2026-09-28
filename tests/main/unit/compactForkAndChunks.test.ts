import { describe, expect, it } from 'vitest'
import {
  CompactionHardFailureError,
  compactMessages,
  isContextLengthFailure,
  shouldUseForkCompaction
} from '@main/agent/context/compact'
import { estimateMessagesTokensAsync } from '@main/agent/context/estimate'
import type { LlmProvider, ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import type { ChatMessage, ModelInfo } from '@shared/ipc'

const model: ModelInfo = {
  id: 'test',
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false,
  contextWindow: 40_000
}

function words(seed: number, n: number): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) out.push(`tok${(seed * 131 + i * 17) % 4999}`)
  return out.join(' ')
}

function capturing(handler: (req: ProviderChatRequest, call: number) => StreamChunk[]): {
  provider: LlmProvider
  requests: ProviderChatRequest[]
} {
  const requests: ProviderChatRequest[] = []
  return {
    requests,
    provider: {
      id: 'openai',
      async *streamChat(req) {
        requests.push(req)
        for (const chunk of handler(req, requests.length - 1)) yield chunk
      },
      listModels: async () => []
    }
  }
}

const summaryText = (): StreamChunk[] => [{ type: 'text', text: '## Session Intent\nsummary' }]
const isFork = (req: ProviderChatRequest): boolean => req.messages.length > 1

describe('chunked compaction sizes each chunk against its rolling prefix', () => {
  it('sends every folded message even when the prior summary fills most of the cap', async () => {
    const { provider, requests } = capturing(() => summaryText())
    // contextWindow 16_000 -> charCap 16_000 chars. The prior eats 14_000 of it.
    const messages: ChatMessage[] = []
    for (let i = 0; i < 12; i++) {
      messages.push({ role: 'assistant', content: `STEP_${i}_START `.padEnd(1_200, 'x') })
    }
    messages.push({ role: 'assistant', content: 'LAST_MESSAGE_IN_FOLD' })
    await compactMessages({
      provider,
      model: 'm',
      signal: new AbortController().signal,
      messages,
      contextWindow: 16_000,
      supportsStructuredOutput: false,
      allowMessageFork: false,
      priorSummary: 'P'.repeat(14_000)
    })
    const sent = requests.map((r) => String(r.messages[0]!.content)).join('\n')
    for (let i = 0; i < 12; i++) expect(sent).toContain(`STEP_${i}_START`)
    expect(sent).toContain('LAST_MESSAGE_IN_FOLD')
    // Every request stays within the summarizer's char cap.
    for (const req of requests) expect(String(req.messages[0]!.content).length).toBeLessThanOrEqual(16_000)
  })

  it('splits one oversized message across chunks instead of cutting its tail', async () => {
    const { provider, requests } = capturing(() => summaryText())
    const big = `HEAD ${'y'.repeat(30_000)} TAIL_OF_BIG_MESSAGE`
    await compactMessages({
      provider,
      model: 'm',
      signal: new AbortController().signal,
      messages: [{ role: 'tool', toolCallId: 't', toolName: 'read', content: big }],
      contextWindow: 16_000,
      supportsStructuredOutput: false,
      allowMessageFork: false
    })
    const sent = requests.map((r) => String(r.messages[0]!.content)).join('\n')
    expect(sent).toContain('HEAD ')
    expect(sent).toContain('TAIL_OF_BIG_MESSAGE')
  })
})

describe('fork pre-check measures the whole fork request', () => {
  async function nearWindowHistory(W: number): Promise<ChatMessage[]> {
    const messages: ChatMessage[] = []
    let i = 0
    while ((await estimateMessagesTokensAsync([...messages], model)) < W * 0.85) {
      messages.push({ role: i % 2 ? 'assistant' : 'user', content: words(i, 400) })
      i++
    }
    return messages
  }

  it('counts the prior summary it sends, so an over-window fork goes chunked', async () => {
    const W = 40_000
    const messages = await nearWindowHistory(W)
    const prior = words(99_999, 7_000).slice(0, W - 100)
    // History alone fits…
    expect(await shouldUseForkCompaction(messages, W, model)).toBe(true)
    // …history plus the prior it carries does not.
    expect(await shouldUseForkCompaction(messages, W, model, [prior])).toBe(false)

    const { provider, requests } = capturing(() => summaryText())
    const record = await compactMessages({
      provider,
      model: 'm',
      signal: new AbortController().signal,
      messages,
      contextWindow: W,
      modelInfo: model,
      priorSummary: prior,
      allowMessageFork: true,
      supportsStructuredOutput: false
    })
    expect(record).not.toBeNull()
    expect(requests.some(isFork)).toBe(false)
  })

  it('falls back to the chunked path when the fork is refused as too long', async () => {
    const { provider, requests } = capturing((req) =>
      isFork(req)
        ? [
            {
              type: 'error',
              error: 'HTTP 400: {"error":{"code":"context_length_exceeded"}}',
              errorCode: 'PROVIDER_HTTP',
              httpStatus: 400
            }
          ]
        : summaryText()
    )
    const record = await compactMessages({
      provider,
      model: 'm',
      signal: new AbortController().signal,
      messages: [
        { role: 'user', content: 'Fix the search tool' },
        { role: 'assistant', content: 'I updated search.ts' }
      ],
      supportsStructuredOutput: false,
      allowMessageFork: true
    })
    expect(record?.summary).toContain('summary')
    expect(requests.filter(isFork)).toHaveLength(1)
    expect(requests.filter((r) => !isFork(r)).length).toBeGreaterThan(0)
  })

  it('classifies size refusals only', () => {
    expect(isContextLengthFailure(new CompactionHardFailureError('Payload Too Large', 413))).toBe(true)
    expect(
      isContextLengthFailure(new CompactionHardFailureError('prompt is too long: 210000 tokens > 200000 maximum', 400))
    ).toBe(true)
    expect(isContextLengthFailure(new CompactionHardFailureError('invalid tool schema', 400))).toBe(false)
    expect(isContextLengthFailure(new CompactionHardFailureError('unknown inference model', 404))).toBe(false)
    expect(isContextLengthFailure(new CompactionHardFailureError('invalid api key', 401))).toBe(false)
  })
})
