import { describe, expect, it } from 'vitest'
import { pickServedModel } from '@renderer/features/settings/hooks/useSettingsForm'

describe('pickServedModel', () => {
  it('keeps the default only when the endpoint serves it', () => {
    expect(pickServedModel(['mock-coder', 'mock-fast'], 'gpt-oss-120b')).toBe('mock-coder')
    expect(pickServedModel(['gpt-oss-120b', 'other'], 'gpt-oss-120b')).toBe('gpt-oss-120b')
  })

  it('falls back to the default for a host with no model list', () => {
    expect(pickServedModel([], 'llama3.2')).toBe('llama3.2')
  })
})
