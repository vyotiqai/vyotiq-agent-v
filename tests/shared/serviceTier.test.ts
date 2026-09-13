import { describe, expect, it } from 'vitest'
import {
  inferSupportedServiceTiers,
  normalizeModelIdForHeuristics,
  serviceTierForApiBody
} from '@shared/domain/serviceTier'
import { modelSupportsThinking } from '@shared/reasoning'
import { pushRecentModel, modelSelectionKey } from '@shared/domain/modelSelection'
import { buildOpenAiCompatBody } from '@main/agent/providers/openai'
import type { ProviderChatRequest } from '@main/agent/providers/types'

describe('serviceTier', () => {
  it('strips openrouter prefix for heuristics', () => {
    expect(normalizeModelIdForHeuristics('openai/gpt-5.6')).toBe('gpt-5.6')
    expect(modelSupportsThinking('openai/gpt-5.6', 'openrouter')).toBe(true)
  })

  it('infers tiers from supported_parameters', () => {
    expect(inferSupportedServiceTiers('openai/gpt-5', 'openrouter', ['service_tier'])).toEqual([
      'default',
      'flex',
      'priority'
    ])
  })

  it('omits default tier from api body helper', () => {
    expect(serviceTierForApiBody('default')).toBeUndefined()
    expect(serviceTierForApiBody('priority')).toBe('priority')
  })

  it('labels priority tier as Fast in the UI', async () => {
    const { SERVICE_TIER_LABELS } = await import('@shared/domain/serviceTier')
    expect(SERVICE_TIER_LABELS.priority).toBe('Fast')
  })
})

describe('modelSelection', () => {
  it('tracks recent models MRU', () => {
    const a = modelSelectionKey('openai', 'gpt-5.6')
    const b = modelSelectionKey('anthropic', 'claude-sonnet-5')
    expect(pushRecentModel([a], b)).toEqual([b, a])
    expect(pushRecentModel([a, b], a)).toEqual([a, b])
  })
})

describe('buildOpenAiCompatBody service_tier', () => {
  it('includes service_tier when set', () => {
    const req = {
      model: 'gpt-5.6',
      messages: [],
      tools: [],
      signal: new AbortController().signal,
      serviceTier: 'priority' as const
    } satisfies ProviderChatRequest
    const body = buildOpenAiCompatBody(req, {}, 'openai')
    expect(body.service_tier).toBe('priority')
  })
})
