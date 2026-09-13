import { describe, expect, it } from 'vitest'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'
import { isPlanDraftReady, scorePlanQuality } from '@shared/planQuality'

const COMPLETE_PLAN = [
  '# Ship the planner',
  '',
  '## Goal',
  '',
  'Make create_plan return structured quality feedback so shallow plans get refined.',
  '',
  '## Scope',
  '',
  'In: plan scoring and tool feedback. Out: plan panel rendering changes.',
  '',
  '## Steps',
  '',
  '1. Add `scorePlanQuality` to `src/shared/planQuality.ts` with unit tests.',
  '2. Surface the report in `src/main/agent/tools/createPlan.ts` and run `pnpm exec vitest run tests/shared` to verify.',
  '',
  '## Done when',
  '',
  '- [ ] `scorePlanQuality` returns no issues for a complete plan.',
  '- [ ] `pnpm typecheck` and the targeted vitest run are green.',
  '',
  '## Risks',
  '',
  'Over-strict gating could block quick plans — feedback stays advisory.'
].join('\n')

describe('scorePlanQuality', () => {
  it('returns no issues for a complete, well-structured plan', () => {
    const report = scorePlanQuality(COMPLETE_PLAN)
    expect(report.issues).toEqual([])
    expect(report.score).toBe(100)
    expect(isPlanDraftReady(COMPLETE_PLAN)).toBe(true)
  })

  it('flags every missing core section in the empty stub', () => {
    const report = scorePlanQuality(DEFAULT_PLAN_STUB)
    const joined = report.issues.join(' ')
    expect(joined).toMatch(/## Goal/)
    expect(joined).toMatch(/## Steps/)
    expect(joined).toMatch(/## Done when/)
    expect(report.score).toBeLessThan(50)
  })

  it('names missing steps and a vague Done when', () => {
    const md = [
      '# Fix login',
      '',
      '## Goal',
      '',
      'Stop sessions from timing out early.',
      '',
      '## Done when',
      '',
      'Ship it.'
    ].join('\n')
    const report = scorePlanQuality(md)
    const joined = report.issues.join(' ')
    expect(joined).toMatch(/## Steps/)
    expect(joined).toMatch(/Done when is vague/)
  })

  it('flags single-step plans and steps without path or symbol anchors', () => {
    const md = [
      '# Tidy up',
      '',
      '## Goal',
      '',
      'Clean up the workspace docs.',
      '',
      '## Steps',
      '',
      '1. Explore the workspace, then draft the plan.',
      '',
      '## Done when',
      '',
      '- [ ] The plan reads well.'
    ].join('\n')
    const report = scorePlanQuality(md)
    const joined = report.issues.join(' ')
    expect(joined).toMatch(/Only one step/)
    expect(joined).toMatch(/no affected files or symbols/)
    expect(report.score).toBeLessThan(100)
  })

  it('flags steps without their own verification even when Done when mentions tests', () => {
    const md = [
      '# Tighten plan quality',
      '',
      '## Goal',
      '',
      'Require a runnable check on every plan step.',
      '',
      '## Steps',
      '',
      '1. Edit `src/shared/planQuality.ts` so the scorer reads the Steps body.',
      '2. Edit `src/main/agent/tools/modePolicy.ts` to reword the template line.',
      '',
      '## Done when',
      '',
      '- [ ] `pnpm typecheck` passes and the targeted vitest run is green.'
    ].join('\n')
    const report = scorePlanQuality(md)
    expect(report.issues.join(' ')).toMatch(/Steps carry no verification/)
  })

  it('nudges 3-step plans without a diagram (advisory only)', () => {
    const md = [
      '# Widen coverage',
      '',
      '## Goal',
      '',
      'Extend plan scoring to cover diagram nudges.',
      '',
      '## Steps',
      '',
      '1. Edit `src/shared/planQuality.ts` to add the diagram check.',
      '2. Edit `src/shared/planStub.ts` to seed the Architecture section.',
      '3. Edit `src/main/agent/tools/modePolicy.ts` to teach the template.',
      '',
      '## Done when',
      '',
      '- [ ] `pnpm typecheck` and the targeted vitest run are green.'
    ].join('\n')
    const report = scorePlanQuality(md)
    expect(report.issues.join(' ')).toMatch(/architecture diagram/i)
  })

  it('accepts a 3-step plan that carries a mermaid architecture diagram', () => {
    const md = [
      '# Widen coverage',
      '',
      '## Goal',
      '',
      'Extend plan scoring to cover diagram nudges.',
      '',
      '## Architecture',
      '',
      '```mermaid',
      'graph TD; A[planQuality.ts] --> B[createPlan.ts] --> C[loop.ts];',
      '```',
      '',
      '## Steps',
      '',
      '1. Edit `src/shared/planQuality.ts` to add the diagram check.',
      '2. Edit `src/shared/planStub.ts` to seed the Architecture section.',
      '3. Edit `src/main/agent/tools/modePolicy.ts` to teach the template.',
      '',
      '## Done when',
      '',
      '- [ ] `pnpm typecheck` and the targeted vitest run are green.'
    ].join('\n')
    const report = scorePlanQuality(md)
    expect(report.issues).toEqual([])
    expect(report.score).toBe(100)
  })
})
