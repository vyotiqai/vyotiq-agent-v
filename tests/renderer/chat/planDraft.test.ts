import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'
import {
  isPlanDraftReady,
  minimalReadyPlanMarkdown
} from '@renderer/features/chat/utils/planDraft'

describe('isPlanDraftReady', () => {
  it('accepts the minimal ready plan', () => {
    expect(isPlanDraftReady(minimalReadyPlanMarkdown())).toBe(true)
  })

  it('rejects the seeded default stub', () => {
    expect(isPlanDraftReady(DEFAULT_PLAN_STUB)).toBe(false)
  })

  it('rejects empty or missing content', () => {
    expect(isPlanDraftReady(null)).toBe(false)
    expect(isPlanDraftReady('')).toBe(false)
    expect(isPlanDraftReady('# Plan\n')).toBe(false)
  })

  it('accepts a filled Goal / Steps / Done when plan without path citations', () => {
    const md = [
      '# Ship the planner',
      '',
      '## Goal',
      '',
      'Publish a clear run plan through create_plan.',
      '',
      '## Steps',
      '',
      '1. Explore the workspace, then write plan.md.',
      '',
      '## Done when',
      '',
      'plan.md has a goal, steps, and a check for finished work.'
    ].join('\n')
    expect(isPlanDraftReady(md)).toBe(true)
  })

  it('accepts freeform body text without the three headings', () => {
    const md = [
      '# Fix the login timeout',
      '',
      'Raise the session TTL in auth.ts and add a regression test.'
    ].join('\n')
    expect(isPlanDraftReady(md)).toBe(true)
  })
})
