import { describe, expect, it } from 'vitest'
import { compareModelOptions } from '@renderer/features/task/compareModels'

const opt = (provider: string, id: string, label = id) => ({ value: `${provider}::${id}`, label })

describe('Also run on: compare models', () => {
  const base = {
    provider: 'anthropic' as const,
    model: 'claude-sonnet-5-5',
    providers: ['anthropic', 'openai'] as const,
    providerLabel: (id: string) => (id === 'openai' ? 'OpenAI' : 'Anthropic'),
    optionsByProvider: {
      anthropic: [opt('anthropic', 'claude-sonnet-5-5'), opt('anthropic', 'claude-opus-5-5'), opt('anthropic', 'claude-haiku-5-5')],
      openai: [opt('openai', 'gpt-5.5'), opt('openai', 'gpt-5.5-mini')]
    }
  }

  it('offers favorites, then recent, then suggestions, never the picked model', () => {
    const options = compareModelOptions({
      ...base,
      providers: [...base.providers],
      favoriteModels: ['openai::gpt-5.5', 'anthropic::claude-sonnet-5-5'],
      recentModels: ['anthropic::claude-opus-5-5'],
      seedsByProvider: { openai: [opt('openai', 'gpt-5.5-mini')] }
    })
    expect(options.map((o) => o.value)).toEqual(['openai::gpt-5.5', 'anthropic::claude-opus-5-5', 'openai::gpt-5.5-mini'])
    expect(options[0]?.group).toBe('OpenAI')
  })

  it('falls back to the picked provider’s list, and skips models no provider lists', () => {
    const options = compareModelOptions({ ...base, providers: [...base.providers], favoriteModels: ['mistral::large'] })
    expect(options.map((o) => o.value)).toEqual(['anthropic::claude-opus-5-5', 'anthropic::claude-haiku-5-5'])
  })
})
