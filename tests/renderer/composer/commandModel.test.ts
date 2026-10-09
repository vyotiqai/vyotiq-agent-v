import { describe, expect, it } from 'vitest'
import type { ProviderIdAny } from '@shared/ipc'
import { matchCommandModel, type CommandModelChoices } from '@renderer/features/chat/components/composer/commandModel'
import type { ModelPickerOption } from '@renderer/features/chat/components/composer/composerModelUtils'

function options(provider: string, models: [id: string, label: string][]): ModelPickerOption[] {
  return models.map(([id, label]) => ({ value: `${provider}::${id}`, label }))
}

const choices: CommandModelChoices = {
  provider: 'openai' as ProviderIdAny,
  providers: ['openai', 'anthropic', 'openrouter'] as ProviderIdAny[],
  optionsByProvider: {
    openai: options('openai', [
      ['gpt-4o', 'GPT-4o'],
      ['gpt-5', 'GPT-5'],
      ['gpt-5-mini', 'GPT-5 mini']
    ]),
    anthropic: options('anthropic', [
      ['claude-haiku-4-5', 'Haiku 4.5'],
      ['claude-sonnet-4-5', 'Sonnet 4.5'],
      ['claude-sonnet-4', 'Sonnet 4']
    ]),
    openrouter: options('openrouter', [['anthropic/claude-opus-4-1', 'Claude Opus 4.1']])
  } as CommandModelChoices['optionsByProvider'],
  seedsByProvider: {}
}

describe('matchCommandModel', () => {
  it('takes a full provider::model key for a provider you have', () => {
    expect(matchCommandModel('anthropic::claude-sonnet-4', choices)).toBe('anthropic::claude-sonnet-4')
    expect(matchCommandModel('mistral::large', choices)).toBeNull()
  })

  it('matches the model id, a router id after its vendor, and the picker name', () => {
    expect(matchCommandModel('claude-haiku-4-5', choices)).toBe('anthropic::claude-haiku-4-5')
    expect(matchCommandModel('claude-opus-4-1', choices)).toBe('openrouter::anthropic/claude-opus-4-1')
    expect(matchCommandModel('Sonnet 4.5', choices)).toBe('anthropic::claude-sonnet-4-5')
  })

  it("reads Copilot's names, vendor in brackets", () => {
    expect(matchCommandModel('GPT-4o (copilot)', choices)).toBe('openai::gpt-4o')
  })

  it('takes a word only when one model of a provider carries it', () => {
    expect(matchCommandModel('haiku', choices)).toBe('anthropic::claude-haiku-4-5')
    expect(matchCommandModel('opus', choices)).toBe('openrouter::anthropic/claude-opus-4-1')
    // Two Sonnets: which one is not guessed.
    expect(matchCommandModel('sonnet', choices)).toBeNull()
  })

  it('prefers the task’s provider when two have the model', () => {
    const both: CommandModelChoices = {
      ...choices,
      provider: 'openrouter' as ProviderIdAny,
      optionsByProvider: {
        ...choices.optionsByProvider,
        openrouter: options('openrouter', [['openai/gpt-5', 'GPT-5']])
      }
    }
    expect(matchCommandModel('gpt-5', both)).toBe('openrouter::openai/gpt-5')
  })

  it('falls back to seed models, never a placeholder one', () => {
    const seeded: CommandModelChoices = {
      ...choices,
      optionsByProvider: {},
      seedsByProvider: {
        anthropic: [
          { value: 'anthropic::claude-haiku-4-5', label: 'Haiku 4.5' },
          {
            value: 'anthropic::example-model',
            label: 'Example',
            meta: {
              id: 'example-model',
              inputModalities: ['text'],
              outputModalities: ['text'],
              supportsTools: true,
              supportsVision: false,
              isPlaceholder: true
            }
          }
        ]
      } as CommandModelChoices['seedsByProvider']
    }
    expect(matchCommandModel('claude-haiku-4-5', seeded)).toBe('anthropic::claude-haiku-4-5')
    expect(matchCommandModel('example-model', seeded)).toBeNull()
  })
})
