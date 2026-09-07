import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PLAN_STUB,
  PLAN_SECTIONS,
  isPlanSectionPromptLine,
  isPlanStubChromeLine,
  stripPlanStubChrome
} from '@shared/planStub'

describe('DEFAULT_PLAN_STUB chrome detection', () => {
  it('seeds the canonical plan sections', () => {
    expect(PLAN_SECTIONS.map((section) => section.heading)).toEqual([
      'Goal',
      'Scope',
      'Steps',
      'Done when',
      'Risks'
    ])
  })

  it('strips the whole stub, prompts included', () => {
    expect(stripPlanStubChrome(DEFAULT_PLAN_STUB)).toBe('')
  })

  it('keeps every stub line detectable as chrome', () => {
    for (const line of DEFAULT_PLAN_STUB.split('\n')) {
      if (!line.trim()) continue
      expect(isPlanStubChromeLine(line), line).toBe(true)
    }
  })

  it('strips the steps guidance prompt', () => {
    expect(
      isPlanSectionPromptLine(
        '_Small, understandable phases — each names affected paths and how it is verified._'
      )
    ).toBe(true)
  })
})
