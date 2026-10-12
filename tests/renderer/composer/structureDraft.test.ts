import { describe, expect, it } from 'vitest'
import { mentionMarker } from '@renderer/features/chat/components/composer/mentionModel'
import {
  briefToDraft,
  draftToStructureInput,
  moveDoneWhenToChecks,
  structureEligibility,
  structuredFromText
} from '@renderer/features/chat/components/composer/structureDraft'

const file = mentionMarker({ kind: 'file', path: 'src/composer/Composer.tsx' })
const terminal = mentionMarker({ kind: 'terminal' })
const slash = mentionMarker({ kind: 'slash', slashKind: 'skill', trigger: 'review', commandId: 'skill:review' })

describe('structureDraft', () => {
  it('sends chips as tokens with what each one is, and puts the same chips back', () => {
    const draft = `fix the crash in ${file} using ${terminal}`
    const input = draftToStructureInput(draft)
    expect(input.text).toBe('fix the crash in [[@1]] using [[@2]]')
    expect(input.mentions).toEqual([
      { token: '[[@1]]', kind: 'file', label: 'Composer.tsx', path: 'src/composer/Composer.tsx' },
      { token: '[[@2]]', kind: 'terminal', label: 'Terminal' }
    ])
    const back = briefToDraft('Fix the crash in [[@1]].\n\n## Context\n- Output: [[@2]]\n- Stray [[@7]]', input.markers)
    expect(back).toBe(`Fix the crash in ${file}.\n\n## Context\n- Output: ${terminal}\n- Stray `)
  })

  it('keeps a token the person typed from posing as a chip', () => {
    expect(draftToStructureInput('explain what [[@1]] means in our templates').text).toBe(
      'explain what [[ @1]] means in our templates'
    )
  })

  it('structures only a real instruction: not a one-word reply, not a slash command', () => {
    expect(structureEligibility('yes')).toEqual({ ok: false, reason: 'Write what you want done first' })
    expect(structureEligibility('run it')).toMatchObject({ ok: false })
    expect(structureEligibility(`${slash} the auth module please`)).toEqual({ ok: false, reason: 'A slash command runs as it is' })
    expect(structureEligibility(`fix ${file} crash`)).toEqual({ ok: true })
  })

  it('keeps what you wrote with chips as their names', () => {
    expect(structuredFromText(`  fix the crash in ${file}  `)).toBe('fix the crash in @Composer.tsx')
  })

  describe('moveDoneWhenToChecks', () => {
    const brief = [
      'Add CSV export.',
      '',
      '## Scope',
      '- Usage page only',
      '',
      '## Done when',
      '- Export downloads a .csv',
      '- [ ] Columns match the table',
      '1. Test covers an empty range',
      '  - including zero rows',
      '',
      '## Verify',
      '- `pnpm test`'
    ].join('\n')

    it('takes the Done when bullets out of the brief as checks, the rest of the brief untouched', () => {
      const checks = ['Export downloads a .csv', 'Columns match the table', 'Test covers an empty range — including zero rows']
      expect(moveDoneWhenToChecks(brief, [])).toEqual({
        draft: 'Add CSV export.\n\n## Scope\n- Usage page only\n\n## Verify\n- `pnpm test`',
        checks,
        added: checks
      })
    })

    it('keeps the section when prose is left in it, and adds after the checks already there', () => {
      const move = moveDoneWhenToChecks('Fix it.\n\n## Done when\nAll of these:\n- A passes\n- B passes\n', ['Lint is clean'])
      expect(move?.draft).toBe('Fix it.\n\n## Done when\nAll of these:')
      expect(move?.checks).toEqual(['Lint is clean', 'A passes', 'B passes'])
      expect(move?.added).toEqual(['A passes', 'B passes'])
    })

    it('drops a bullet that restates a check, without adding it twice', () => {
      const move = moveDoneWhenToChecks('Fix it.\n\n## Done when\n- Tests pass.\n- The crash is gone', ['tests  PASS'])
      expect(move?.draft).toBe('Fix it.')
      expect(move?.checks).toEqual(['tests  PASS', 'The crash is gone'])
      expect(move?.added).toEqual(['The crash is gone'])
    })

    it('stops at the checks limit and leaves the bullets that do not fit in the brief', () => {
      const existing = Array.from({ length: 18 }, (_, i) => `check ${i + 1}`)
      const move = moveDoneWhenToChecks('Fix it.\n\n## Done when\n- one\n- two\n- three', existing)
      expect(move?.added).toEqual(['one', 'two'])
      expect(move?.checks).toHaveLength(20)
      expect(move?.draft).toBe('Fix it.\n\n## Done when\n- three')
    })

    it('cuts a check to the schema length and turns chips into their names', () => {
      const long = 'x'.repeat(600)
      const move = moveDoneWhenToChecks(`Do it.\n\n## Done when\n- ${long}\n- ${file} renders`, [])
      expect(move?.added).toEqual(['x'.repeat(500), '@Composer.tsx renders'])
    })

    it('offers nothing when there is no Done when, no bullet in it, or no room or need for one', () => {
      expect(moveDoneWhenToChecks('Fix it.\n\n## Verify\n- run tests', [])).toBeNull()
      expect(moveDoneWhenToChecks('Fix it.\n\n## Done when\nIt works.', [])).toBeNull()
      expect(moveDoneWhenToChecks('Fix it.\n\n## Done when\n- It works', ['it works.'])).toBeNull()
      const full = Array.from({ length: 20 }, (_, i) => `check ${i + 1}`)
      expect(moveDoneWhenToChecks('Fix it.\n\n## Done when\n- New one', full)).toBeNull()
    })
  })
})
