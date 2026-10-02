import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/vyotiq-model-fallback', getAppPath: () => '/tmp/vyotiq-app', isPackaged: false }
}))
vi.mock('@main/settings/secrets', () => ({
  getSecret: () => null,
  hasStoredSecretBlob: () => false,
  secretStatus: () => ({ encryptionAvailable: true, keys: {} })
}))

import type { ChatMessage, ModelInfo, ProviderIdAny, Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS, SettingsSchema } from '@shared/ipc'
import {
  classifyOutageFailure,
  classifyThrownOutage,
  createModelFallback,
  FALLBACK_AFTER_OUTAGE_ATTEMPTS,
  historyForFallback,
  messagesHaveImages,
  PRIMARY_RETRY_AFTER_MS,
  type FallbackNeeds,
  type ModelTarget
} from '@main/agent/modelFallback'
import { baseModelInfo } from '@main/agent/providers/normalize'
import { toOpenAiMessages } from '@main/agent/providers/openai'
import { toAnthropicMessages } from '@main/agent/providers/anthropic'
import type { LlmProvider } from '@main/agent/providers/types'

const QUOTA_BODY =
  'Weekly usage limit reached. Resets in 6 days. To continue using this model now, enable usage from your available balance.'

describe('classifyOutageFailure', () => {
  it('never treats a 429 (rate limit or usage limit) as an outage', () => {
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 429, message: QUOTA_BODY })).toBeNull()
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 429, message: 'Rate limited' })).toBeNull()
    // A quota message is a wait even without its status or on a 5xx wrapper.
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', message: QUOTA_BODY })).toBeNull()
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 503, message: 'quota exceeded' })).toBeNull()
  })

  it('treats 5xx, 529 overloaded and 408 as outages', () => {
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 529, message: 'Overloaded' })).toBe('overloaded')
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 503, message: 'Service Unavailable' })).toBe('HTTP 503')
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 500, message: '' })).toBe('HTTP 500')
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: 408, message: '' })).toBe('timed out')
  })

  it('treats connection refused / reset, DNS and timeouts as outages', () => {
    expect(
      classifyOutageFailure({ errorCode: 'PROVIDER_NETWORK', message: 'connect ECONNREFUSED 10.1.2.3:443' })
    ).toBe('connection refused')
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_NETWORK', message: 'read ECONNRESET' })).toBe('connection reset')
    expect(
      classifyOutageFailure({ errorCode: 'PROVIDER_NETWORK', message: 'getaddrinfo ENOTFOUND api.example.com' })
    ).toBe('DNS lookup failed')
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_TIMEOUT', message: 'idle' })).toBe('timed out')
    // A dead local endpoint (the loop would not retry it) is an outage too.
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_STREAM', message: 'connect ECONNREFUSED 127.0.0.1:11434' })).toBe(
      'connection refused'
    )
  })

  it('leaves request and key errors alone: 400, 401, 403, 402, 404', () => {
    for (const status of [400, 401, 402, 403, 404, 422]) {
      expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', httpStatus: status, message: 'nope' })).toBeNull()
    }
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_AUTH', message: 'Invalid API key' })).toBeNull()
  })

  it('does not switch on an open circuit (the fetch layer opens it on 429s too)', () => {
    expect(classifyOutageFailure({ errorCode: 'CIRCUIT_OPEN', message: 'Circuit open for http:x; retry in 59s' })).toBeNull()
  })

  it('reads status-less in-band frames only by unmistakable outage wording', () => {
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', message: '{"type":"overloaded_error"} Overloaded' })).toBe(
      'overloaded'
    )
    expect(classifyOutageFailure({ errorCode: 'PROVIDER_HTTP', message: 'Something odd happened' })).toBeNull()
  })
})

describe('classifyThrownOutage', () => {
  const coded = (code: string, message = code): Error => Object.assign(new Error(message), { code })

  it('classifies connect failures by code', () => {
    expect(classifyThrownOutage(coded('ECONNREFUSED', 'connect ECONNREFUSED 1.2.3.4:443'))).toBe('connection refused')
    expect(classifyThrownOutage(coded('ETIMEDOUT', 'Connect timed out'))).toBe('timed out')
    expect(classifyThrownOutage(new TypeError('fetch failed', { cause: coded('ENOTFOUND') }))).toBe('DNS lookup failed')
  })

  it('ignores aborts and ordinary errors', () => {
    const abort = new Error('Aborted')
    abort.name = 'AbortError'
    expect(classifyThrownOutage(abort)).toBeNull()
    expect(classifyThrownOutage(new Error('JSON parse failed'))).toBeNull()
  })
})

describe('historyForFallback', () => {
  const anthropicTurn: ChatMessage[] = [
    { role: 'user', content: 'fix it' },
    {
      role: 'assistant',
      content: 'Looking.',
      reasoningState: { kind: 'anthropic', blocks: [{ type: 'thinking', thinking: 'secret chain of thought' }] },
      toolCalls: [{ id: 'toolu_1', name: 'read', arguments: '{"path":"a.ts"}' }]
    },
    { role: 'tool', toolCallId: 'toolu_1', toolName: 'read', content: 'file body' }
  ]

  it('drops Anthropic thinking blocks for an OpenAI-compatible fallback', () => {
    const info = baseModelInfo('gpt-fb', { contextWindow: 128_000, supportsTools: true }, 'openai')
    const history = historyForFallback(anthropicTurn, info)
    expect(history[1]!.reasoningState).toBeUndefined()
    // Text, tool calls and results are kept as they were.
    expect(history[1]!.toolCalls).toEqual(anthropicTurn[1]!.toolCalls)
    expect(history[2]).toBe(anthropicTurn[2])
    const wire = toOpenAiMessages(history, 'system')
    expect(JSON.stringify(wire)).not.toContain('secret chain of thought')
    expect(JSON.stringify(wire)).not.toContain('reasoning_content')
    const assistant = wire.find((m) => m.role === 'assistant') as { tool_calls?: unknown[] } | undefined
    expect(assistant?.tool_calls).toHaveLength(1)
    // The primary's own history is not touched.
    expect(anthropicTurn[1]!.reasoningState).toBeDefined()
  })

  it('keeps replay state the fallback produced itself', () => {
    const own = { kind: 'openai_compat', reasoningContent: 'own reasoning' }
    const info = baseModelInfo('gpt-fb', { contextWindow: 128_000, supportsTools: true }, 'openai')
    const history = historyForFallback(
      [...anthropicTurn, { role: 'assistant', content: 'next', reasoningState: own }],
      info,
      (state) => state === own
    )
    expect(history[3]!.reasoningState).toBe(own)
    expect(history[1]!.reasoningState).toBeUndefined()
  })

  it('works the other way: OpenAI-compatible reasoning never reaches Anthropic', () => {
    const info = baseModelInfo('claude-fb', { contextWindow: 200_000, supportsTools: true }, 'anthropic')
    const history = historyForFallback(
      [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'ok', reasoningState: { kind: 'openai_compat', reasoningContent: 'hmm' } }
      ],
      info
    )
    expect(JSON.stringify(toAnthropicMessages(history))).not.toContain('hmm')
  })

  it('replaces images for a model that cannot see them', () => {
    const withImage: ChatMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', url: 'data:image/png;base64,AA==' }] }
    ]
    expect(messagesHaveImages(withImage)).toBe(true)
    const textOnly = baseModelInfo('text-only', { contextWindow: 8000, supportsVision: false, inputModalities: ['text'] }, 'openai')
    expect(messagesHaveImages(historyForFallback(withImage, textOnly))).toBe(false)
  })
})

function info(id: string, partial: Partial<ModelInfo> = {}): ModelInfo {
  return baseModelInfo(id, { contextWindow: 128_000, supportsTools: true, ...partial }, 'openai')
}

function fakeProvider(id: string): LlmProvider {
  return {
    id: id as LlmProvider['id'],
    listModels: async () => [],
    async *streamChat() {}
  }
}

function primaryTarget(): ModelTarget {
  return {
    runProviderId: 'anthropic',
    providerId: 'anthropic',
    model: 'claude-main',
    provider: fakeProvider('anthropic'),
    apiKey: 'sk-ant',
    baseUrl: undefined,
    modelInfo: info('claude-main'),
    price: null,
    thinkingAllowed: true
  }
}

function settingsWith(models: Array<{ provider: ProviderIdAny; model: string }>, enabled = true): Settings {
  return { ...DEFAULT_SETTINGS, provider: 'anthropic', model: 'claude-main', modelFallback: { enabled, models } }
}

const needs = (over: Partial<FallbackNeeds> = {}): FallbackNeeds => ({
  tools: true,
  images: false,
  promptTokens: 1000,
  signal: new AbortController().signal,
  ...over
})

function controller(
  models: Array<{ provider: ProviderIdAny; model: string }>,
  opts: { enabled?: boolean; keys?: Record<string, string>; infos?: Record<string, ModelInfo>; now?: () => number } = {}
) {
  const keys = opts.keys ?? { openai: 'sk-openai', xai: 'xai-key' }
  return createModelFallback({
    settings: settingsWith(models, opts.enabled ?? true),
    primary: primaryTarget(),
    deps: {
      getProvider: (id) => fakeProvider(id),
      getSecret: (id) => keys[id] ?? null,
      hasStoredSecretBlob: () => false,
      encryptionAvailable: () => true,
      resolveModelInfo: async (_p, model) => opts.infos?.[model] ?? info(model),
      now: opts.now ?? (() => 0)
    }
  })
}

describe('createModelFallback', () => {
  it('does nothing when off', async () => {
    const fb = controller([{ provider: 'openai', model: 'gpt-fb' }], { enabled: false })
    for (let i = 0; i < 5; i++) expect(await fb.onOutage('HTTP 503', needs())).toBeNull()
    expect(fb.isPrimary()).toBe(true)
  })

  it('switches after the outage threshold, and says so', async () => {
    const fb = controller([{ provider: 'openai', model: 'gpt-fb' }])
    fb.beginStep()
    for (let i = 1; i < FALLBACK_AFTER_OUTAGE_ATTEMPTS; i++) {
      expect(await fb.onOutage('HTTP 529', needs())).toBeNull()
    }
    const change = await fb.onOutage('overloaded', needs())
    expect(change?.to.model).toBe('gpt-fb')
    expect(change?.to.runProviderId).toBe('openai')
    expect(change?.message).toBe('Switched to gpt-fb — Anthropic unavailable (overloaded)')
    expect(fb.isPrimary()).toBe(false)
    expect(fb.current().apiKey).toBe('sk-openai')
    // The next attempt does not wait out the old model's backoff.
    expect(fb.takeSkipWait()).toBe(true)
    expect(fb.takeSkipWait()).toBe(false)
  })

  it('switches at once for a failure the loop would not retry', async () => {
    const fb = controller([{ provider: 'openai', model: 'gpt-fb' }])
    fb.beginStep()
    expect((await fb.onOutage('connection refused', needs(), { immediate: true }))?.to.model).toBe('gpt-fb')
  })

  it('skips a fallback with no key, no tool support, no image support or too small a window', async () => {
    const fb = controller(
      [
        { provider: 'anthropic', model: 'claude-main' }, // the task's own model: ignored
        { provider: 'gemini', model: 'no-key' },
        { provider: 'openai', model: 'no-tools' },
        { provider: 'openai', model: 'blind' },
        { provider: 'openai', model: 'tiny' }
      ].slice(0, 4) as Array<{ provider: ProviderIdAny; model: string }>,
      {
        infos: {
          'no-tools': info('no-tools', { supportsTools: false }),
          blind: info('blind', { supportsVision: false, inputModalities: ['text'] })
        }
      }
    )
    fb.beginStep()
    await fb.onOutage('HTTP 503', needs({ images: true }))
    expect(await fb.onOutage('HTTP 503', needs({ images: true }))).toBeNull()
    expect(fb.isPrimary()).toBe(true)

    const small = controller([{ provider: 'openai', model: 'tiny' }], { infos: { tiny: info('tiny', { contextWindow: 4000 }) } })
    small.beginStep()
    await small.onOutage('HTTP 503', needs({ promptTokens: 50_000 }))
    expect(await small.onOutage('HTTP 503', needs({ promptTokens: 50_000 }))).toBeNull()
  })

  it('walks the list in order, then back to the task model, at most one lap per step', async () => {
    const fb = controller([
      { provider: 'openai', model: 'fb-1' },
      { provider: 'xai', model: 'fb-2' }
    ])
    fb.beginStep()
    const seen: string[] = []
    for (let i = 0; i < 20; i++) {
      const change = await fb.onOutage('HTTP 503', needs())
      if (change) seen.push(change.to.model)
    }
    expect(seen).toEqual(['fb-1', 'fb-2', 'claude-main'])
    expect(fb.isPrimary()).toBe(true)
  })

  it('goes back to the task model at a step start once the switch is old enough', async () => {
    let now = 0
    const fb = controller([{ provider: 'openai', model: 'gpt-fb' }], { now: () => now })
    fb.beginStep()
    await fb.onOutage('HTTP 503', needs(), { immediate: true })
    now = PRIMARY_RETRY_AFTER_MS - 1
    expect(fb.beginStep()).toBeNull()
    expect(fb.isPrimary()).toBe(false)
    now = PRIMARY_RETRY_AFTER_MS
    const back = fb.beginStep()
    expect(back?.restored).toBe(true)
    expect(back?.message).toBe('Back on claude-main — trying Anthropic again')
    expect(fb.isPrimary()).toBe(true)
  })

  it('hands the task model its messages untouched (prompt cache), a fallback its stripped copy', async () => {
    const fb = controller([{ provider: 'openai', model: 'gpt-fb' }])
    const messages: ChatMessage[] = [
      { role: 'assistant', content: 'a', reasoningState: { kind: 'anthropic', blocks: [] } }
    ]
    expect(fb.requestMessages(messages)).toBe(messages)
    fb.beginStep()
    await fb.onOutage('HTTP 503', needs(), { immediate: true })
    const own = { kind: 'openai_compat', reasoningContent: 'mine' }
    fb.noteReasoningState(own)
    const out = fb.requestMessages([...messages, { role: 'assistant', content: 'b', reasoningState: own }])
    expect(out[0]!.reasoningState).toBeUndefined()
    expect(out[1]!.reasoningState).toBe(own)
  })
})

describe('modelFallback setting', () => {
  it('loads settings written before it existed', () => {
    const { modelFallback: _absent, ...old } = DEFAULT_SETTINGS
    expect(SettingsSchema.parse(old).modelFallback).toEqual({ enabled: false, models: [] })
  })

  it('caps the list at three, drops repeats and unreadable rows', () => {
    const parsed = SettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      modelFallback: {
        enabled: true,
        models: [
          { provider: 'openai', model: 'a' },
          { provider: 'openai', model: 'a' },
          { provider: 'nope', model: 'b' },
          { provider: 'xai', model: 'c' },
          { provider: 'gemini', model: 'd' },
          { provider: 'mistral', model: 'e' }
        ]
      }
    })
    expect(parsed.modelFallback.models.map((m) => m.model)).toEqual(['a', 'c', 'd'])
  })

  it('falls back to off when the value is junk', () => {
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS, modelFallback: 'yes' }).modelFallback).toEqual({
      enabled: false,
      models: []
    })
  })
})
