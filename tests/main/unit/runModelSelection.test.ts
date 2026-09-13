import { describe, beforeEach, expect, it } from 'vitest'
import {
  clearRunModelSelectionForTests,
  recallRunModelSelection,
  rememberRunModelSelection
} from '@main/agent/runModelSelection'

describe('runModelSelection', () => {
  beforeEach(() => {
    clearRunModelSelectionForTests()
  })

  it('remembers and recalls per-run selections', () => {
    expect(recallRunModelSelection('r1')).toBeNull()
    rememberRunModelSelection('r1', 'openai', 'gpt-a')
    expect(recallRunModelSelection('r1')).toEqual({ provider: 'openai', model: 'gpt-a' })
    expect(recallRunModelSelection('r2')).toBeNull()
  })

  it('overwrites on re-pin and keeps a bounded history', () => {
    rememberRunModelSelection('r1', 'openai', 'gpt-a')
    rememberRunModelSelection('r1', 'anthropic', 'claude')
    expect(recallRunModelSelection('r1')).toEqual({ provider: 'anthropic', model: 'claude' })

    for (let i = 0; i < 600; i++) rememberRunModelSelection(`bulk-${i}`, 'openai', 'gpt-a')
    expect(recallRunModelSelection('bulk-0')).toBeNull()
    expect(recallRunModelSelection('bulk-599')).toEqual({ provider: 'openai', model: 'gpt-a' })
  })
})
