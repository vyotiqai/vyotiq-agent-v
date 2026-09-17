import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'
import {
  isPlanDraftReady,
  minimalReadyPlanMarkdown,
  PLAN_STUB
} from '@renderer/features/chat/utils/planDraft'

describe('isPlanDraftReady', () => {
  it('accepts the minimal ready plan', () => {
    expect(isPlanDraftReady(minimalReadyPlanMarkdown())).toBe(true)
  })

  it('rejects the seeded stubs', () => {
    expect(isPlanDraftReady(DEFAULT_PLAN_STUB)).toBe(false)
    expect(isPlanDraftReady(PLAN_STUB)).toBe(false)
  })

  it('rejects empty or missing content', () => {
    expect(isPlanDraftReady(null)).toBe(false)
    expect(isPlanDraftReady('')).toBe(false)
    expect(isPlanDraftReady('# Plan\n')).toBe(false)
  })

  it('rejects outline-only templates without body text', () => {
    expect(
      isPlanDraftReady(
        '# Plan\n\n_Draft the plan here. Update as you learn._\n\n## Goal\n\n## Approach\n'
      )
    ).toBe(false)
  })

  it('rejects verbose headings, punctuated headings, HR, and tiny stubs', () => {
    expect(
      isPlanDraftReady('# Plan\n\n## One two three four five words here\n\n## Goal.\n\n---\n\n```\n')
    ).toBe(false)
    expect(isPlanDraftReady('# Plan\n\nTODO\n')).toBe(false)
    expect(isPlanDraftReady('# Plan\n\n- [ ] x\n')).toBe(false)
  })

  it('accepts a one-line body that meets the length floor', () => {
    expect(isPlanDraftReady('# Plan\n\n1. Do the thing\n')).toBe(true)
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

  it('accepts Done when in place of Success criteria', () => {
    expect(
      isPlanDraftReady(
        [
          '# Plan',
          '',
          '## Goal',
          '',
          'Ship the structured planner.',
          '',
          '## Done when',
          '',
          'Required sections are filled and Continue in Agent is enabled.',
          '',
          '## Approach',
          '',
          'Seed headings, prompt the model, and gate Continue on those sections.',
          '',
          '## Ordered steps',
          '',
          '1. Fill Goal, Success criteria, Approach, and Ordered steps.',
          ''
        ].join('\n')
      )
    ).toBe(true)
  })
})
