import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { createServer, type IncomingMessage, type Server } from 'http'
import { listVertexModels, streamVertex } from '@main/agent/providers/vertex'
import { buildGeminiBody } from '@main/agent/providers/gemini'
import { resetGoogleAuthForTests, type GoogleServiceAccount } from '@main/agent/providers/google/googleAuth'
import type { ProviderChatRequest, StreamChunk } from '@main/agent/providers/types'
import { __setModelsDevRegistryForTests } from '@shared/domain/modelsDevRegistry'
import { vertexBaseUrl } from '@shared/domain/cloudProviders'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SA: GoogleServiceAccount = {
  type: 'service_account',
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
}

type Seen = { url: string; headers: IncomingMessage['headers']; body: string }
let server: Server
let origin = ''
const seen: Seen[] = []
let tokens = 0
let rejectNextWith401 = false

const sse = (events: unknown[]) => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      if (req.url === '/token') {
        tokens += 1
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ access_token: `ya29.t${tokens}`, expires_in: 3600 }))
        return
      }
      seen.push({ url: req.url!, headers: req.headers, body })
      if (rejectNextWith401) {
        rejectNextWith401 = false
        res.writeHead(401, { 'content-type': 'application/json' })
        res.end('{"error":{"code":401,"message":"Request had invalid authentication credentials."}}')
        return
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      if (req.url!.includes('/publishers/anthropic/')) {
        res.end(
          sse([
            { type: 'message_start', message: { usage: { input_tokens: 5, output_tokens: 0 } } },
            { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello from Claude' } },
            { type: 'content_block_stop', index: 0 },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
            { type: 'message_stop' }
          ])
        )
        return
      }
      res.end(
        sse([
          {
            candidates: [
              {
                content: {
                  role: 'model',
                  parts: [
                    { text: 'Reading it.' },
                    { functionCall: { name: 'read', args: { path: 'a.ts' } }, thoughtSignature: 'SIG-abc' }
                  ]
                },
                finishReason: 'STOP'
              }
            ],
            usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 }
          }
        ])
      )
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  origin = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`
})

afterAll(() => {
  server.close()
  __setModelsDevRegistryForTests(null)
})
beforeEach(() => {
  seen.length = 0
  tokens = 0
  resetGoogleAuthForTests()
})

const endpoint = () => ({
  baseUrl: `${origin}/v1/projects/proj/locations/global`,
  credentials: SA,
  tokenOptions: { tokenUrl: `${origin}/token` }
})

function req(over: Partial<ProviderChatRequest> = {}): ProviderChatRequest {
  return {
    model: 'gemini-3.6-flash',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
    system: 'Be brief.',
    signal: new AbortController().signal,
    ...over
  }
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const c of gen) out.push(c)
  return out
}

describe('Vertex AI', () => {
  it('builds the host for global, multi-region and regional locations', () => {
    expect(vertexBaseUrl('proj', 'global')).toBe('https://aiplatform.googleapis.com/v1/projects/proj/locations/global')
    expect(vertexBaseUrl('proj', 'eu')).toBe('https://aiplatform.eu.rep.googleapis.com/v1/projects/proj/locations/eu')
    expect(vertexBaseUrl('proj', 'us-east5')).toBe('https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5')
  })

  it('streams Gemini with a bearer token, and keeps the call signature for the next step', async () => {
    const chunks = await collect(streamVertex(req({ thinking: { enabled: true, effort: 'low' } }), endpoint()))
    expect(seen[0]!.url).toBe('/v1/projects/proj/locations/global/publishers/google/models/gemini-3.6-flash:streamGenerateContent?alt=sse')
    expect(seen[0]!.headers.authorization).toBe('Bearer ya29.t1')
    expect(JSON.parse(seen[0]!.body).generationConfig.thinkingConfig).toEqual({ thinkingLevel: 'low' })
    const call = chunks.find((c) => c.type === 'tool_call')!.toolCall!
    expect(call).toMatchObject({ name: 'read', arguments: '{"path":"a.ts"}' })
    const done = chunks.at(-1)!
    expect(done).toMatchObject({ type: 'done', reasoningState: { kind: 'gemini_parts', signatures: { [call.id]: 'SIG-abc' } } })

    // Replayed next step: the signature rides the function call part back.
    const body = buildGeminiBody(
      req({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'Reading it.', toolCalls: [call], reasoningState: done.reasoningState },
          { role: 'tool', toolCallId: call.id, toolName: 'read', content: 'x' }
        ]
      })
    )
    const model = (body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>).find((c) => c.role === 'model')!
    expect(model.parts.find((p) => p.functionCall)).toMatchObject({ thoughtSignature: 'SIG-abc' })
  })

  it('streams Claude through rawPredict in the Messages shape, model in the URL', async () => {
    const chunks = await collect(streamVertex(req({ model: 'claude-sonnet-5-5' }), endpoint()))
    expect(seen[0]!.url).toBe('/v1/projects/proj/locations/global/publishers/anthropic/models/claude-sonnet-5-5:streamRawPredict')
    const body = JSON.parse(seen[0]!.body)
    expect(body.anthropic_version).toBe('vertex-2023-10-16')
    expect(body.model).toBeUndefined()
    expect(seen[0]!.headers.authorization).toBe('Bearer ya29.t1')
    expect(seen[0]!.headers['x-api-key']).toBeUndefined()
    expect(seen[0]!.headers['anthropic-version']).toBeUndefined()
    expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('Hello from Claude')
    expect(chunks.at(-1)).toMatchObject({ type: 'done', stopReason: 'stop' })
  })

  it('mints a fresh token after Google rejects one', async () => {
    rejectNextWith401 = true
    const first = await collect(streamVertex(req(), endpoint()))
    expect(first.at(-1)).toMatchObject({ type: 'error', httpStatus: 401 })
    await collect(streamVertex(req(), endpoint()))
    expect(seen.map((s) => s.headers.authorization)).toEqual(['Bearer ya29.t1', 'Bearer ya29.t2'])
  })

  it('refuses models from other publishers instead of guessing a route', async () => {
    const chunks = await collect(streamVertex(req({ model: 'meta/llama-3.3-70b-instruct-maas' }), endpoint()))
    expect(chunks).toEqual([{ type: 'error', error: expect.stringMatching(/other publishers/) }])
    expect(seen).toHaveLength(0)
  })

  it('lists Gemini and Claude chat models from the registry after a real sign-in', async () => {
    __setModelsDevRegistryForTests({
      'google-vertex': {
        models: {
          'claude-sonnet-5-5@default': { id: 'claude-sonnet-5-5@default', name: 'Claude Sonnet 5.5', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_000_000, output: 64_000 } },
          'gemini-2.5-pro': { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', tool_call: true, modalities: { input: ['text', 'image'], output: ['text'] }, limit: { context: 1_048_576 } },
          'gemini-2.5-flash-tts': { id: 'gemini-2.5-flash-tts', name: 'TTS', modalities: { input: ['text'], output: ['audio'] }, limit: { context: 8000 } },
          'meta/llama-3.3-70b-instruct-maas': { id: 'meta/llama-3.3-70b-instruct-maas', name: 'Llama', limit: { context: 128000 } }
        }
      }
    })
    const models = await listVertexModels(SA, undefined, { tokenUrl: `${origin}/token` })
    expect(tokens).toBe(1)
    expect(models.map((m) => m.id)).toEqual(['claude-sonnet-5-5', 'gemini-2.5-pro'])
    expect(models[0]).toMatchObject({ contextWindow: 1_000_000, supportsVision: true, supportsTools: true })
  })
})
