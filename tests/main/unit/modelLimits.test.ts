import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'http'
import type { AddressInfo } from 'net'
import type { ModelInfo } from '@shared/ipc'
import { applyModelLimitOverrides, modelLimitKey } from '@shared/domain/modelLimits'
import { ollamaLoadedContext, withLocalServerLimits } from '@main/agent/providers/localServerLimits'
import { requestMaxOutputTokens } from '@main/agent/providers/requestLimits'

const model = (id: string, contextWindow?: number): ModelInfo => ({
  id,
  ...(contextWindow ? { contextWindow } : {}),
  inputModalities: ['text'],
  outputModalities: ['text'],
  supportsTools: true,
  supportsVision: false
})

describe('model limit overrides', () => {
  it('replaces the guess with what the person set, and marks it', () => {
    const [qwen, other] = applyModelLimitOverrides('custom:lmstudio', [model('qwen', 128_000), model('other')], {
      [modelLimitKey('custom:lmstudio', 'qwen')]: { contextWindow: 32_768, maxOutputTokens: 4096 }
    })
    expect(qwen).toMatchObject({ contextWindow: 32_768, maxOutputTokens: 4096, limitsSource: 'user' })
    expect(other?.limitsSource).toBeUndefined()
    // A max output set by hand is sent as is, even to a local server.
    expect(requestMaxOutputTokens('custom', qwen!)).toBe(4096)
  })
})

describe('local server limits', () => {
  let server: Server
  let base: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      res.setHeader('content-type', 'application/json')
      if (req.url === '/props') {
        res.end(JSON.stringify({ default_generation_settings: { n_ctx: 8192 } }))
      } else if (req.url === '/api/v0/models') {
        res.end(JSON.stringify({ data: [{ id: 'lm-model', max_context_length: 131072, loaded_context_length: 16384 }] }))
      } else if (req.url === '/api/ps') {
        res.end(JSON.stringify({ models: [{ name: 'qwen2.5:latest', context_length: 4096 }] }))
      } else {
        res.statusCode = 404
        res.end('{}')
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })

  afterAll(() => {
    server.close()
  })

  it('reads llama.cpp n_ctx and LM Studio loaded windows from a server on this machine', async () => {
    const [lm, other] = await withLocalServerLimits(`${base}/v1`, [model('lm-model'), model('any')])
    expect(lm).toMatchObject({ contextWindow: 16384, limitsSource: 'server' })
    expect(other).toMatchObject({ contextWindow: 8192, limitsSource: 'server' })
  })

  it('never probes a remote host', async () => {
    const models = [model('m', 128_000)]
    expect(await withLocalServerLimits('https://api.example.com/v1', models)).toBe(models)
  })

  it("reads Ollama's loaded context for the model, with or without the :latest tag", async () => {
    expect(await ollamaLoadedContext(base, 'qwen2.5')).toBe(4096)
    expect(await ollamaLoadedContext(base, 'qwen2.5:latest')).toBe(4096)
    expect(await ollamaLoadedContext(base, 'llama3')).toBeUndefined()
  })
})
