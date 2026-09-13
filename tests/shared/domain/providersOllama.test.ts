import { describe, expect, it } from 'vitest'
import {
  CUSTOM_OPENAI_DEFAULT,
  hostSanityError,
  isOllamaCloudHost,
  normalizeCustomOpenAiBaseUrl,
  ollamaNativeHost,
  ollamaOpenAiBaseUrl,
  providerNeedsKey,
  resolveEffectiveOllamaHost,
  resolveOllamaListBaseUrl,
  resolveProviderChatBaseUrl,
  resolveProviderListBaseUrl,
  seedModelsFor,
  validateCustomOpenAiBaseUrl,
  validateOllamaBaseUrl
} from '@shared/domain/providers'

describe('ollama host helpers', () => {
  it('strips trailing /v1 so OpenAI base is never doubled', () => {
    expect(ollamaNativeHost('https://ollama.com/v1')).toBe('https://ollama.com')
    expect(ollamaNativeHost('https://ollama.com/v1/')).toBe('https://ollama.com')
    expect(ollamaNativeHost('http://127.0.0.1:11434/v1')).toBe('http://127.0.0.1:11434')
    expect(ollamaOpenAiBaseUrl('https://ollama.com/v1')).toBe('https://ollama.com/v1')
    expect(resolveOllamaListBaseUrl('https://ollama.com/v1')).toBe('https://ollama.com')
  })

  it('detects Ollama Cloud hosts', () => {
    expect(isOllamaCloudHost('https://ollama.com')).toBe(true)
    expect(isOllamaCloudHost('https://ollama.com/v1')).toBe(true)
    expect(isOllamaCloudHost('https://api.ollama.com')).toBe(true)
    expect(isOllamaCloudHost('http://127.0.0.1:11434')).toBe(false)
    expect(isOllamaCloudHost('http://localhost:11434')).toBe(false)
  })

  it('requires a key only for Ollama Cloud', () => {
    expect(providerNeedsKey('openai')).toBe(true)
    expect(providerNeedsKey('ollama')).toBe(false)
    expect(providerNeedsKey('ollama', 'http://127.0.0.1:11434')).toBe(false)
    expect(providerNeedsKey('ollama', 'https://ollama.com')).toBe(true)
  })

  it('routes local hosts to Cloud when an API key is set', () => {
    expect(resolveEffectiveOllamaHost('http://127.0.0.1:11434', 'sk-test')).toBe(
      'https://ollama.com'
    )
    expect(resolveEffectiveOllamaHost('http://localhost:11434', 'sk-test')).toBe(
      'https://ollama.com'
    )
    expect(resolveEffectiveOllamaHost('http://127.0.0.1:11434', null)).toBe(
      'http://127.0.0.1:11434'
    )
    expect(resolveEffectiveOllamaHost('https://ollama.com', 'sk-test')).toBe('https://ollama.com')
    expect(resolveEffectiveOllamaHost('http://192.168.1.10:11434', 'sk-test')).toBe(
      'http://192.168.1.10:11434'
    )
  })

  it('seeds GPT-OSS with a real window and cannot-disable thinking', () => {
    const gptOss = seedModelsFor('ollama').find((m) => m.id === 'gpt-oss:120b')
    expect(gptOss?.contextWindow).toBe(131_072)
    expect(gptOss?.thinkingCanDisable).toBe(false)
    expect(gptOss?.supportedThinkingEfforts).toEqual(['low', 'medium', 'high'])
  })
})

describe('custom OpenAI-compatible host helpers', () => {
  it('normalizes custom base URLs to an OpenAI /v1 mount without doubling', () => {
    expect(normalizeCustomOpenAiBaseUrl('http://127.0.0.1:8080')).toBe(
      'http://127.0.0.1:8080/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.fireworks.ai/inference/v1')).toBe(
      'https://api.fireworks.ai/inference/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.fireworks.ai/inference/v1/')).toBe(
      'https://api.fireworks.ai/inference/v1'
    )
    // Vendor suffix after /v1 (DeepInfra OpenAI-compat mount).
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai/')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    // Repair corrupted saves from older “must end with /v1” normalizer.
    expect(normalizeCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai/v1')).toBe(
      'https://api.deepinfra.com/v1/openai'
    )
    expect(normalizeCustomOpenAiBaseUrl('https://api.groq.com/openai/v1')).toBe(
      'https://api.groq.com/openai/v1'
    )
  })

  it('defaults scheme-less inputs to https for public hosts and http for loopback', () => {
    // Modal endpoint hostname pasted bare — must not become http:// (the old
    // default), which breaks TLS-only cloud endpoints.
    expect(normalizeCustomOpenAiBaseUrl('my-endpoint.us-west.modal.direct')).toBe(
      'https://my-endpoint.us-west.modal.direct/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('my-endpoint.us-west.modal.direct/v1')).toBe(
      'https://my-endpoint.us-west.modal.direct/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('192.168.1.10:8080')).toBe(
      'http://192.168.1.10:8080/v1'
    )
    expect(normalizeCustomOpenAiBaseUrl('localhost:8080')).toBe(
      'http://localhost:8080/v1'
    )
  })

  it('requires a key for remote custom hosts but not local or private LAN ones', () => {
    expect(providerNeedsKey('custom', 'http://127.0.0.1:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://localhost:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://192.168.1.10:8000/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://10.0.0.5:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'http://172.16.4.2:8080/v1')).toBe(false)
    expect(providerNeedsKey('custom', 'https://api.fireworks.ai/inference/v1')).toBe(true)
    expect(providerNeedsKey('custom', 'https://api.deepinfra.com/v1/openai')).toBe(true)
  })

  it('resolves chat and list base URLs for custom', () => {
    expect(
      resolveProviderChatBaseUrl('custom', {
        customOpenAiBaseUrl: 'http://127.0.0.1:9000'
      })
    ).toBe('http://127.0.0.1:9000/v1')
    expect(
      resolveProviderListBaseUrl('custom', undefined, {
        customOpenAiBaseUrl: 'https://api.together.xyz'
      })
    ).toBe('https://api.together.xyz/v1')
    expect(
      resolveProviderChatBaseUrl('custom', {
        customOpenAiBaseUrl: 'https://api.deepinfra.com/v1/openai'
      })
    ).toBe('https://api.deepinfra.com/v1/openai')
    expect(
      resolveProviderListBaseUrl('custom', undefined, {
        customOpenAiBaseUrl: 'https://api.deepinfra.com/v1/openai/v1'
      })
    ).toBe('https://api.deepinfra.com/v1/openai')
  })
})

describe('base URL paste validation (2026-09 settings audit)', () => {
  it('extracts the real endpoint from duplicated-scheme and prose pastes', () => {
    // Duplicated scheme: the real host is the last scheme occurrence.
    expect(
      validateCustomOpenAiBaseUrl(
        'https://https://api.cloudflare.com/client/v4/accounts/a35f'
      )
    ).toEqual({
      ok: true,
      url: 'https://api.cloudflare.com/client/v4/accounts/a35f/v1'
    })
    expect(
      validateCustomOpenAiBaseUrl('https https://api.groq.com/openai/v1')
    ).toEqual({ ok: true, url: 'https://api.groq.com/openai/v1' })
    expect(
      validateCustomOpenAiBaseUrl('Endpoint: https://api.deepinfra.com/v1/openai.')
    ).toEqual({ ok: true, url: 'https://api.deepinfra.com/v1/openai' })
  })

  it('rejects garbled hosts instead of silently saving or defaulting them', () => {
    // The exact corrupted value from the 2026-09 screenshot: unparseable, so
    // the validator must error — never persist it and never fall back to the
    // local default (that produced the ECONNREFUSED 127.0.0.1:8080 error).
    const garbled = validateCustomOpenAiBaseUrl(
      'https://xn--%20https-yp6e//api.cloudflare.com/client/v4/accounts/a35f'
    )
    expect(garbled.ok).toBe(false)
    if (!garbled.ok) {
      // Throws at URL-parse time, so the user is told it is not a valid URL.
      expect(garbled.error).toContain('not a valid http(s) URL')
    }
    // Single-slash duplicated scheme parses with host "https" — still rejected.
    expect(
      validateCustomOpenAiBaseUrl('https://https//api.cloudflare.com/client/x').ok
    ).toBe(false)
    expect(validateCustomOpenAiBaseUrl('').ok).toBe(false)
    // Scheme-less bare words are prose, not endpoints (long-standing Ollama
    // field rule, now shared by both providers).
    expect(validateCustomOpenAiBaseUrl('not-a-url').ok).toBe(false)
    expect(validateOllamaBaseUrl('not-a-url').ok).toBe(false)
  })

  it('keeps legitimate base URLs working', () => {
    expect(validateCustomOpenAiBaseUrl('http://127.0.0.1:8080')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:8080/v1'
    })
    expect(
      validateCustomOpenAiBaseUrl('https://api.deepinfra.com/v1/openai')
    ).toEqual({ ok: true, url: 'https://api.deepinfra.com/v1/openai' })
    expect(validateCustomOpenAiBaseUrl('my-endpoint.us-west.modal.direct')).toEqual({
      ok: true,
      url: 'https://my-endpoint.us-west.modal.direct/v1'
    })
  })

  it('never returns a mangled URL from the normalizer (load-time repair)', () => {
    expect(
      normalizeCustomOpenAiBaseUrl('https://https//api.cloudflare.com/client/v4/accounts/a35f')
    ).toBe(CUSTOM_OPENAI_DEFAULT)
  })

  it('validates Ollama base URLs the same way', () => {
    expect(validateOllamaBaseUrl('http://127.0.0.1:11434')).toEqual({
      ok: true,
      url: 'http://127.0.0.1:11434'
    })
    expect(validateOllamaBaseUrl('https://ollama.com/v1')).toEqual({
      ok: true,
      url: 'https://ollama.com'
    })
    expect(validateOllamaBaseUrl('').ok).toBe(false)
    expect(validateOllamaBaseUrl('https://https//x').ok).toBe(false)
  })

  it('describes the sanity gate in user-facing terms', () => {
    expect(hostSanityError('https://api.deepinfra.com/v1/openai')).toBeNull()
    expect(hostSanityError('ftp://api.deepinfra.com')).toContain('http or https')
    expect(hostSanityError('https://https//api.example.com')).toContain('duplicated')
  })
})
