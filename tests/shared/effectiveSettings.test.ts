import { describe, expect, it } from 'vitest'
import { resolveEffectiveSettings } from '@shared/effectiveSettings'
import { DEFAULT_SETTINGS } from '@shared/ipc'

describe('resolveEffectiveSettings', () => {
  it('returns global chat settings when override is off', () => {
    const effective = resolveEffectiveSettings(DEFAULT_SETTINGS, {
      useOverride: false,
      provider: 'openai',
      model: 'gpt-5.6',
      thinkingEffort: 'max'
    })
    expect(effective.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(effective.model).toBe(DEFAULT_SETTINGS.model)
    expect(effective.thinkingEffort).toBe(DEFAULT_SETTINGS.thinkingEffort)
    expect(effective.thinkingEnabled).toBe(DEFAULT_SETTINGS.thinkingEnabled)
  })

  it('merges thinking and agent fields from workspace override', () => {
    const effective = resolveEffectiveSettings(DEFAULT_SETTINGS, {
      useOverride: true,
      provider: 'openai',
      model: 'gpt-5.6',
      thinkingEnabled: false,
      thinkingEffort: 'high',
      showThinking: false,
      keepRecentTurns: 20,
      autoCompactThresholdRatio: 0.35,
      agentPersona: 'Nova',
      agentTone: 'friendly, blunt',
      agentIdentity: 'Override blurb',
      responseLanguage: 'Spanish',
      responseVerbosity: 'detailed'
    })
    expect(effective).toEqual({
      provider: 'openai',
      model: 'gpt-5.6',
      ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
      customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
      // customProviders is global-only in both branches.
      customProviders: DEFAULT_SETTINGS.customProviders,
      thinkingEnabled: false,
      thinkingEffort: 'high',
      showThinking: false,
      keepRecentTurns: 20,
      autoCompactThresholdRatio: 0.35,
      toolApproval: DEFAULT_SETTINGS.toolApproval,
      agentPersona: 'Nova',
      agentTone: 'friendly, blunt',
      agentIdentity: 'Override blurb',
      responseLanguage: 'Spanish',
      responseVerbosity: 'detailed'
    })
  })

  it('keeps customProviders global-only in both branches', () => {
    const global = {
      ...DEFAULT_SETTINGS,
      customProviders: [{ id: 'custom:lan', name: 'LAN', baseUrl: 'http://127.0.0.1:8080/v1' }]
    }
    const override = {
      useOverride: true,
      provider: 'openai',
      model: 'gpt-5.6',
      customOpenAiBaseUrl: 'https://override.example.com/v1'
    } as const
    expect(resolveEffectiveSettings(global, override).customProviders).toEqual(
      global.customProviders
    )
    expect(
      resolveEffectiveSettings(global, { ...override, useOverride: false }).customProviders
    ).toEqual(global.customProviders)
  })

  it('falls back to global persona/tone/style when the override leaves them unset', () => {
    const effective = resolveEffectiveSettings(
      {
        ...DEFAULT_SETTINGS,
        agentPersona: 'Atlas',
        agentTone: 'formal',
        agentIdentity: 'Global blurb',
        responseVerbosity: 'balanced'
      },
      { useOverride: true, provider: 'openai', model: 'gpt-5.6' }
    )
    expect(effective.agentPersona).toBe('Atlas')
    expect(effective.agentTone).toBe('formal')
    expect(effective.agentIdentity).toBe('Global blurb')
    expect(effective.responseLanguage).toBe('')
    expect(effective.responseVerbosity).toBe('balanced')
  })

  it('lets the workspace agentIdentity override win over the global setting', () => {
    const effective = resolveEffectiveSettings(
      { ...DEFAULT_SETTINGS, agentIdentity: 'Global blurb' },
      { useOverride: true, provider: 'openai', model: 'gpt-5.6', agentIdentity: 'Override blurb' }
    )
    expect(effective.agentIdentity).toBe('Override blurb')
    expect(effective.agentPersona).toBe(DEFAULT_SETTINGS.agentPersona)
  })
})
