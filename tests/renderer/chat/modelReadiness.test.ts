import { describe, expect, it } from 'vitest'
import { emptySecretStatus } from '@shared/ipc'
import {
  deriveModelReadiness,
  modelReadinessBlocksSend,
  modelReadinessSendReason
} from '../../../src/renderer/src/features/chat/components/composer/modelReadiness'

const CUSTOM_405_WARNING =
  'Custom OpenAI-compatible does not serve a model list (HTTP 405); the host is reachable and chat can still connect. Type a model ID in the composer model picker search and press Enter to use it. Showing illustrative placeholder model IDs (not live models).'

describe('deriveModelReadiness', () => {
  it('requires an API key for cloud providers without a saved secret', () => {
    const issue = deriveModelReadiness({
      provider: 'openai',
      model: 'gpt-4o',
      secrets: emptySecretStatus(),
      catalogWarning: null,
      liveCatalog: null,
      catalogLoading: false
    })
    expect(issue).toEqual({ kind: 'missing_key', provider: 'openai', label: 'OpenAI' })
    expect(modelReadinessSendReason(issue!)).toMatch(/API key/i)
    expect(modelReadinessBlocksSend(issue)).toBe(true)
  })

  it('treats local Ollama as configured without a key', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: null,
      liveCatalog: [{
        id: 'qwen2.5',
        displayName: 'qwen2.5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }],
      catalogLoading: false
    })
    expect(issue).toBeNull()
    expect(modelReadinessBlocksSend(issue)).toBe(false)
  })

  it('flags seed-fallback catalog warnings as unreachable', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: 'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).',
      liveCatalog: null,
      catalogLoading: false
    })
    expect(issue?.kind).toBe('unreachable')
    expect(modelReadinessBlocksSend(issue)).toBe(true)
    expect(modelReadinessSendReason(issue!)).toMatch(/not ready/i)
  })

  it('classifies 405 list-unsupported as manual_catalog (not unreachable) and does not block send', () => {
    const issue = deriveModelReadiness({
      provider: 'custom',
      model: '@cf/meta/llama-3.1-8b-instruct',
      secrets: { ...emptySecretStatus(), custom: true },
      customOpenAiBaseUrl: 'https://api.cloudflare.com/client/v4/accounts/x/ai/v1',
      catalogWarning: CUSTOM_405_WARNING,
      liveCatalog: null,
      catalogLoading: false
    })
    expect(issue?.kind).toBe('manual_catalog')
    expect(issue).toMatchObject({
      kind: 'manual_catalog',
      provider: 'custom',
      detail: CUSTOM_405_WARNING
    })
    expect(modelReadinessBlocksSend(issue)).toBe(false)
    expect(modelReadinessSendReason(issue!)).toMatch(/no model list/i)
    expect(modelReadinessSendReason(issue!)).not.toMatch(/before sending/i)
  })

  it('does not flag a selected model missing from the live catalog', () => {
    // Hosted catalogs omit servable models (OpenRouter stealth ids like
    // `stealth/union-alpha` are routed but unlisted), so catalog membership
    // must never block send — a wrong id fails at send time instead.
    const issue = deriveModelReadiness({
      provider: 'openrouter',
      model: 'stealth/union-alpha',
      secrets: { ...emptySecretStatus(), openrouter: true },
      catalogWarning: null,
      liveCatalog: [{
        id: 'openai/gpt-4o',
        displayName: 'GPT-4o',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false
      }],
      catalogLoading: false
    })
    expect(issue).toBeNull()
    expect(modelReadinessBlocksSend(issue)).toBe(false)
  })

  it('does not block during the first catalog load before any warning', () => {
    const issue = deriveModelReadiness({
      provider: 'ollama',
      model: 'qwen2.5',
      secrets: emptySecretStatus(),
      ollamaBaseUrl: 'http://127.0.0.1:11434',
      catalogWarning: null,
      liveCatalog: null,
      catalogLoading: true
    })
    expect(issue).toBeNull()
  })
})
