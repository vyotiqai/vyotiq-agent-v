import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  customProvider,
  ModelListUnsupportedError
} from '@main/agent/providers/openai'
import { listProviderModels } from '@main/agent/providers'
import {
  setPublicFetchForTests
} from '@main/agent/tools/webFetch'
import { resetSoftWarnCooldownsForTests } from '@main/agent/providers/log'

vi.mock('@shared/logger', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn()
  }
}))

afterEach(() => {
  setPublicFetchForTests(null)
  resetSoftWarnCooldownsForTests()
})

const CUSTOM_BASE = 'http://127.0.0.1:8080/v1'

/** Live Cloudflare Workers AI compat payload: GET not supported (code 7001). */
const CF_405_BODY =
  '{"result":null,"success":false,"errors":[{"code":7001,"message":"GET not supported for requested URI."}],"messages":[]}'

function respondWith(status: number, body = status === 405 ? CF_405_BODY : 'Method Not Allowed'): void {
  setPublicFetchForTests(async (url) => {
    if (url.pathname.endsWith('/models')) {
      return new Response(body, { status })
    }
    return new Response('not found', { status: 404 })
  })
}

describe('OpenAI-compat hosts without a model-list route', () => {
  it('reports HTTP 405 on GET /models as an unsupported model list, not a connection failure', async () => {
    respondWith(405)

    await expect(
      customProvider.listModels({ baseUrl: CUSTOM_BASE })
    ).rejects.toMatchObject({
      name: 'ModelListUnsupportedError',
      status: 405
    })
    const { logger } = (await import('@shared/logger')) as {
      logger: { warn: ReturnType<typeof vi.fn> }
    }
    // Expected catalog state — never logged as a provider failure.
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('treats HTTP 501 the same way', async () => {
    respondWith(501)

    await expect(
      customProvider.listModels({ baseUrl: CUSTOM_BASE })
    ).rejects.toBeInstanceOf(ModelListUnsupportedError)
  })

  it('keeps the actionable base-URL error for HTTP 404', async () => {
    respondWith(404)

    await expect(
      customProvider.listModels({ baseUrl: CUSTOM_BASE })
    ).rejects.toThrow(/Cannot reach custom OpenAI-compatible host.*HTTP 404/is)
  })

  it('listProviderModels degrades to seeds with a host-reachable warning on 405', async () => {
    respondWith(405)

    const res = await listProviderModels({
      provider: 'custom',
      baseUrl: CUSTOM_BASE,
      forceRefresh: true
    })

    expect(res.warning).toMatch(/does not serve a model list \(HTTP 405\)/)
    expect(res.warning).toMatch(/host is reachable/)
    expect(res.warning).toMatch(/Type a model ID/)
    // Must match the renderer seed-fallback marker so placeholder rows stay
    // out of the live list and manual model entry shows in the picker.
    expect(res.warning).toMatch(/not live models/)
    expect(res.models.length).toBeGreaterThan(0)
  })

  it('still loads a live catalog when GET /models works', async () => {
    setPublicFetchForTests(async (url) => {
      if (url.pathname.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'qwen2.5' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }
      return new Response('not found', { status: 404 })
    })

    const models = await customProvider.listModels({ baseUrl: CUSTOM_BASE })
    expect(models.some((m) => m.id === 'qwen2.5')).toBe(true)
  })
})
