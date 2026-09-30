import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server } from 'http'
import {
  buildConverseBody,
  listBedrockModels,
  parseBedrockSecret,
  streamBedrockConverse,
  toConverseMessages,
  type BedrockAuth
} from '@main/agent/providers/bedrock'
import { encodeEventStreamMessage } from '@main/agent/providers/aws/eventStream'
import { signAwsRequest } from '@main/agent/providers/aws/sigv4'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import type { ChatMessage } from '@shared/ipc'
import { bedrockRegionFromBaseUrl } from '@shared/domain/cloudProviders'

type Seen = { method: string; url: string; headers: IncomingMessage['headers']; body: string }
let server: Server
let base = ''
const seen: Seen[] = []
/** What the next converse-stream call answers: frames, or an HTTP error. */
let reply: { frames?: Uint8Array[]; status?: number; body?: string }[] = []

const event = (type: string, payload: unknown) =>
  encodeEventStreamMessage(
    { ':message-type': 'event', ':event-type': type, ':content-type': 'application/json' },
    JSON.stringify(payload)
  )

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, headers: req.headers, body })
      if (req.url?.startsWith('/foundation-models')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            modelSummaries: [
              { modelId: 'anthropic.claude-sonnet-5-5', providerName: 'Anthropic', modelName: 'Claude Sonnet 5.5', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: true, inferenceTypesSupported: ['INFERENCE_PROFILE'] },
              { modelId: 'amazon.nova-pro-v1:0', providerName: 'Amazon', modelName: 'Nova Pro', inputModalities: ['TEXT', 'IMAGE'], outputModalities: ['TEXT'], responseStreamingSupported: true, inferenceTypesSupported: ['ON_DEMAND'] },
              { modelId: 'amazon.titan-embed-text-v2:0', providerName: 'Amazon', modelName: 'Titan Embed', inputModalities: ['TEXT'], outputModalities: ['EMBEDDING'], inferenceTypesSupported: ['ON_DEMAND'] },
              { modelId: 'amazon.titan-text-express-v1', providerName: 'Amazon', modelName: 'Titan Text', inputModalities: ['TEXT'], outputModalities: ['TEXT'], responseStreamingSupported: true, inferenceTypesSupported: ['ON_DEMAND'] }
            ]
          })
        )
        return
      }
      if (req.url?.startsWith('/inference-profiles')) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            inferenceProfileSummaries: [
              { inferenceProfileId: 'global.anthropic.claude-sonnet-5-5', inferenceProfileName: 'Global Claude Sonnet 5.5', status: 'ACTIVE', models: [{ modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-5-5' }] }
            ]
          })
        )
        return
      }
      const next = reply.shift() ?? { frames: [] }
      if (next.status) {
        res.writeHead(next.status, { 'content-type': 'application/json', 'x-amzn-errortype': 'ValidationException' })
        res.end(next.body ?? '{}')
        return
      }
      res.writeHead(200, { 'content-type': 'application/vnd.amazon.eventstream' })
      // Split frames across writes so the decoder sees real chunk boundaries.
      const all = Buffer.concat((next.frames ?? []).map((f) => Buffer.from(f)))
      for (let i = 0; i < all.length; i += 37) res.write(all.subarray(i, i + 37))
      res.end()
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => server.close())
beforeEach(() => {
  seen.length = 0
  reply = []
})

const KEYS: BedrockAuth = {
  kind: 'sigv4',
  credentials: { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', sessionToken: 'SESSION' }
}

function req(over: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: 'global.anthropic.claude-sonnet-5-5',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
    systemStable: 'You are careful.',
    systemVolatile: 'clock: 12:00',
    signal: new AbortController().signal,
    ...over
  }
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('Bedrock secret and region', () => {
  it('reads an API key or an access key pair, and says what is wrong', () => {
    expect(parseBedrockSecret('ABSKabc123')).toEqual({ kind: 'apiKey', token: 'ABSKabc123' })
    expect(parseBedrockSecret('{"accessKeyId":"AK","secretAccessKey":"S"}')).toEqual({
      kind: 'sigv4',
      credentials: { accessKeyId: 'AK', secretAccessKey: 'S' }
    })
    expect(parseBedrockSecret('{"accessKeyId":"AK"}')).toEqual({ error: expect.stringMatching(/secret/) })
    expect(parseBedrockSecret('')).toEqual({ error: expect.stringMatching(/not set up/) })
    expect(bedrockRegionFromBaseUrl('https://bedrock-runtime.eu-central-1.amazonaws.com')).toBe('eu-central-1')
    expect(bedrockRegionFromBaseUrl('https://evil.example.com')).toBe('us-east-1')
  })
})

describe('Converse request', () => {
  it('maps history, replays reasoning before tool calls, and places cache points for Claude', () => {
    const history: ChatMessage[] = [
      { role: 'user', content: 'read a.ts' },
      {
        role: 'assistant',
        content: 'Reading.',
        toolCalls: [{ id: 'tu_1', name: 'read', arguments: '{"path":"a.ts"}' }],
        reasoningState: { kind: 'bedrock_converse', blocks: [{ reasoningContent: { reasoningText: { text: 'plan', signature: 'sig-1' } } }] }
      },
      { role: 'tool', toolCallId: 'tu_1', toolName: 'read', content: 'export {}' }
    ]
    const body = buildConverseBody(req({ messages: history }))
    expect(body.system).toEqual([{ text: 'You are careful.' }, { cachePoint: { type: 'default' } }])
    const messages = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user'])
    expect(messages[1]!.content).toEqual([
      { reasoningContent: { reasoningText: { text: 'plan', signature: 'sig-1' } } },
      { text: 'Reading.' },
      { toolUse: { toolUseId: 'tu_1', name: 'read', input: { path: 'a.ts' } } }
    ])
    expect(messages[2]!.content[0]).toEqual({ toolResult: { toolUseId: 'tu_1', content: [{ text: 'export {}' }] } })
    // The volatile zone rides the last user turn, after the cached history.
    expect(JSON.stringify(messages[2]!.content[1])).toContain('clock: 12:00')
    const toolConfig = body.toolConfig as { tools: unknown[] }
    expect(toolConfig.tools[toolConfig.tools.length - 1]).toEqual({ cachePoint: { type: 'default' } })
    // Non-Claude, non-Nova models get no cache points.
    expect(JSON.stringify(buildConverseBody(req({ model: 'meta.llama4-scout-17b-instruct-v1:0' })))).not.toContain('cachePoint')
  })

  it('writes tool calls as text when the request declares no tools (compaction)', () => {
    const { messages } = toConverseMessages(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: '', toolCalls: [{ id: 't', name: 'read', arguments: '{"path":"x"}' }] },
        { role: 'tool', toolCallId: 't', toolName: 'read', content: 'X' }
      ],
      { asText: true }
    )
    expect(JSON.stringify(messages)).not.toMatch(/toolUse|toolResult/)
    expect(messages[1]!.content).toEqual([{ text: '[called read] {"path":"x"}' }])
    expect(messages[2]!.content).toEqual([{ text: '[read result]\nX' }])
  })

  it('sends Claude thinking through additionalModelRequestFields without a temperature', () => {
    const body = buildConverseBody(
      req({ model: 'us.anthropic.claude-sonnet-4-5-20250929-v1:0', temperature: 0.3, thinking: { enabled: true, effort: 'high' } })
    )
    expect(body.additionalModelRequestFields).toMatchObject({ thinking: { type: 'enabled' } })
    expect((body.inferenceConfig as Record<string, unknown>).temperature).toBeUndefined()
    expect((body.inferenceConfig as Record<string, unknown>).maxTokens).toBeGreaterThan(0)
  })
})

describe('ConverseStream against a local mock', () => {
  it('streams text, a tool call and signed reasoning, with usage and a stop reason', async () => {
    reply.push({
      frames: [
        event('messageStart', { role: 'assistant', p: 'abcd' }),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'Think ' } } }),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { text: 'more.' } } }),
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'SIG' } } }),
        event('contentBlockStop', { contentBlockIndex: 0 }),
        event('contentBlockDelta', { contentBlockIndex: 1, delta: { text: 'Let me read.' } }),
        event('contentBlockStop', { contentBlockIndex: 1 }),
        event('contentBlockStart', { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu_9', name: 'read' } } }),
        event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } }),
        event('contentBlockDelta', { contentBlockIndex: 2, delta: { toolUse: { input: '"a.ts"}' } } }),
        event('contentBlockStop', { contentBlockIndex: 2 }),
        event('messageStop', { stopReason: 'tool_use' }),
        event('metadata', { usage: { inputTokens: 12, outputTokens: 34, totalTokens: 46, cacheReadInputTokens: 1000, cacheWriteInputTokens: 50 }, metrics: { latencyMs: 9 } })
      ]
    })
    const chunks = await collect(streamBedrockConverse(req(), { baseUrl: base, region: 'us-west-2', auth: KEYS }))

    expect(chunks.filter((c) => c.type === 'thinking_delta').map((c) => c.text).join('')).toBe('Think more.')
    expect(chunks.find((c) => c.type === 'thinking_done')?.text).toBe('Think more.')
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('Let me read.')
    expect(chunks.find((c) => c.type === 'tool_call')?.toolCall).toEqual({ id: 'tu_9', name: 'read', arguments: '{"path":"a.ts"}' })
    const done = chunks.at(-1)!
    expect(done).toMatchObject({
      type: 'done',
      stopReason: 'tool_calls',
      usage: { inputTokens: 12, outputTokens: 34, cachedInputTokens: 1000, cacheCreationInputTokens: 50, inputTokensIncludesCache: false },
      reasoningState: { kind: 'bedrock_converse', blocks: [{ reasoningContent: { reasoningText: { text: 'Think more.', signature: 'SIG' } } }] }
    })

    // The request: the model id escaped in the path, and a SigV4 signature that
    // re-computes from the headers the server received.
    const call = seen[0]!
    expect(call.url).toBe(`/model/${encodeURIComponent('global.anthropic.claude-sonnet-5-5')}/converse-stream`)
    expect(call.headers['x-amz-security-token']).toBe('SESSION')
    const signedNames = /SignedHeaders=([^,]+)/.exec(String(call.headers.authorization))![1]!.split(';')
    const resigned = signAwsRequest({
      method: 'POST',
      url: `${base}${call.url}`,
      headers: Object.fromEntries(
        signedNames.filter((n) => !['host', 'x-amz-date', 'x-amz-security-token'].includes(n)).map((n) => [n, String(call.headers[n])])
      ),
      body: call.body,
      region: 'us-west-2',
      service: 'bedrock',
      credentials: (KEYS as Extract<BedrockAuth, { kind: 'sigv4' }>).credentials,
      now: new Date(String(call.headers['x-amz-date']).replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, '$1-$2-$3T$4:$5:$6Z'))
    })
    expect(call.headers.authorization).toBe(resigned.authorization)
  })

  it('sends a Bedrock API key as a bearer token', async () => {
    reply.push({ frames: [event('messageStop', { stopReason: 'end_turn' })] })
    await collect(streamBedrockConverse(req(), { baseUrl: base, region: 'us-west-2', auth: { kind: 'apiKey', token: 'ABSKkey' } }))
    expect(seen[0]!.headers.authorization).toBe('Bearer ABSKkey')
  })

  it('drops cache points once when a model refuses them', async () => {
    reply.push({ status: 400, body: '{"message":"This model doesn\'t support the cachePoint field."}' })
    reply.push({ frames: [event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'ok' } }), event('messageStop', { stopReason: 'end_turn' })] })
    const chunks = await collect(streamBedrockConverse(req(), { baseUrl: base, region: 'us-west-2', auth: KEYS }))
    expect(seen).toHaveLength(2)
    expect(seen[0]!.body).toContain('cachePoint')
    expect(seen[1]!.body).not.toContain('cachePoint')
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' })
  })

  it('reports an in-stream throttling exception as a retriable HTTP 429', async () => {
    reply.push({
      frames: [
        event('contentBlockDelta', { contentBlockIndex: 0, delta: { text: 'par' } }),
        encodeEventStreamMessage(
          { ':message-type': 'exception', ':exception-type': 'throttlingException', ':content-type': 'application/json' },
          '{"message":"Too many requests, please wait before trying again."}'
        )
      ]
    })
    const chunks = await collect(streamBedrockConverse(req(), { baseUrl: base, region: 'us-west-2', auth: KEYS }))
    expect(chunks.at(-1)).toEqual({
      type: 'error',
      error: 'Bedrock throttlingException: Too many requests, please wait before trying again.',
      errorCode: 'PROVIDER_HTTP',
      httpStatus: 429
    })
  })

  it('lists inference profiles first, then on-demand text models', async () => {
    const models = await listBedrockModels('us-west-2', KEYS, undefined, base)
    expect(models.map((m) => m.id)).toEqual([
      'global.anthropic.claude-sonnet-5-5',
      'amazon.nova-pro-v1:0',
      'amazon.titan-text-express-v1'
    ])
    expect(models[0]).toMatchObject({ displayName: 'Global Claude Sonnet 5.5', supportsVision: true, supportsTools: true })
    expect(models[2]!.supportsTools).toBe(false)
    expect(seen.every((s) => String(s.headers.authorization).startsWith('AWS4-HMAC-SHA256 '))).toBe(true)
  })
})
