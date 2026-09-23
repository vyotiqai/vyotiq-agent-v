import { describe, expect, it } from 'vitest'
import {
  applyCheckVerdicts,
  checksTally,
  contractDoneWhenBlock,
  doneWhenBullets,
  mergePlanChecks,
  nextCheckId,
  parseDoneWhenChecks,
  type DoneWhenCheck
} from '@shared/doneWhenChecks'

const NOW = '2026-09-24T10:00:00.000Z'
const LATER = '2026-09-24T10:05:00.000Z'

function check(partial: Partial<DoneWhenCheck> & Pick<DoneWhenCheck, 'id' | 'text'>): DoneWhenCheck {
  return { source: 'plan', verdict: null, createdAt: NOW, ...partial }
}

describe('doneWhenBullets', () => {
  it('reads list items of every marker and folds nested items into their parent', () => {
    const body = [
      'The work is done when:',
      '',
      '- [ ] The updater suite passes 20 runs in a row',
      '* No retry or sleep added around the swap',
      '1. `pnpm typecheck` is clean',
      '   - including tests/',
      '',
      'Prose after the list is not a check.'
    ].join('\n')
    expect(doneWhenBullets(body)).toEqual([
      'The updater suite passes 20 runs in a row',
      'No retry or sleep added around the swap',
      '`pnpm typecheck` is clean — including tests/'
    ])
  })

  it('finds no checks in prose', () => {
    expect(doneWhenBullets('plan.md has a goal, steps, and a check for finished work.')).toEqual([])
  })
})

describe('mergePlanChecks', () => {
  it('keeps an unchanged check with its verdict, adds new ones, drops removed ones', () => {
    const existing = [
      check({ id: 'c1', text: 'Suite passes', verdict: 'met', evidence: '6 passed', markedAt: NOW }),
      check({ id: 'c2', text: 'No sleeps added' })
    ]
    const merged = mergePlanChecks(existing, ['Suite passes.', 'Docs updated'], LATER)
    expect(merged.map((c) => [c.id, c.text, c.verdict])).toEqual([
      ['c1', 'Suite passes.', 'met'],
      ['c3', 'Docs updated', null]
    ])
    expect(merged[1]!.createdAt).toBe(LATER)
  })

  it('leaves the brief’s checks alone and never duplicates one the plan restates', () => {
    const brief = check({ id: 'c1', text: 'The suite passes', source: 'brief' })
    const merged = mergePlanChecks([brief], ['the suite passes', 'No sleeps added'], NOW)
    expect(merged.map((c) => [c.id, c.source])).toEqual([
      ['c1', 'brief'],
      ['c2', 'plan']
    ])
  })
})

describe('applyCheckVerdicts', () => {
  it('marks known ids with evidence and reports the rest', () => {
    const existing = [check({ id: 'c1', text: 'A' }), check({ id: 'c2', text: 'B' })]
    const { checks, applied, unknown } = applyCheckVerdicts(
      existing,
      [
        { id: 'C1', verdict: 'met', evidence: 'pnpm vitest run — 6 passed' },
        { id: 'c9', verdict: 'met', evidence: 'x' }
      ],
      LATER
    )
    expect(applied).toEqual(['c1'])
    expect(unknown).toEqual(['c9'])
    expect(checks[0]).toMatchObject({ verdict: 'met', evidence: 'pnpm vitest run — 6 passed', markedAt: LATER })
    expect(checks[1]!.verdict).toBeNull()
  })

  it('caps evidence', () => {
    const { checks } = applyCheckVerdicts([check({ id: 'c1', text: 'A' })], [{ id: 'c1', verdict: 'not_met', evidence: 'x'.repeat(900) }], NOW)
    expect(checks[0]!.evidence).toHaveLength(600)
  })
})

describe('tally, ids and the contract block', () => {
  it('counts met, not met and open', () => {
    const t = checksTally([
      check({ id: 'c1', text: 'A', verdict: 'met' }),
      check({ id: 'c2', text: 'B', verdict: 'not_met' }),
      check({ id: 'c3', text: 'C' })
    ])
    expect(t).toEqual({ met: 1, notMet: 1, open: 1, total: 3 })
  })

  it('numbers ids after the highest one', () => {
    expect(nextCheckId([check({ id: 'c2', text: 'A' }), check({ id: 'c7', text: 'B' })])).toBe('c8')
    expect(nextCheckId([])).toBe('c1')
  })

  it('lists every check by id in contract.md', () => {
    expect(contractDoneWhenBlock([check({ id: 'c1', text: 'Suite passes' })])).toBe(
      [
        '## Done when',
        '',
        '- (c1) Suite passes',
        '',
        'Before you finish, mark each check with `check_done_when`: met or not met, with the evidence you saw.'
      ].join('\n')
    )
  })

  it('reads a checks.json body and nothing from a broken one', () => {
    const body = JSON.stringify({ checks: [check({ id: 'c1', text: 'A' })] })
    expect(parseDoneWhenChecks(body).map((c) => c.id)).toEqual(['c1'])
    expect(parseDoneWhenChecks('{nope')).toEqual([])
    expect(parseDoneWhenChecks(null)).toEqual([])
  })
})
