import { describe, expect, it } from 'vitest'
import type { FoldFacts } from '@main/agent/context/foldFacts'
import {
  foldFactsToPinned,
  formatPinnedFacts,
  mergeFoldFacts,
  pinFoldFacts,
  stripPinnedFactsAppendix
} from '@main/agent/context/pinFoldFacts'
import { verifyCompactionSummary } from '@main/agent/context/verifyCompaction'

const facts: FoldFacts = {
  files: ['src/auth.ts', 'src/session.ts'],
  wroteFiles: ['src/auth.ts'],
  decisions: ['Use JWT'],
  todos: ['Add auth tests'],
  doneWhen: ['Login uses JWT'],
  constraints: ['Do not log secrets'],
  contractGoal: 'Rewrite auth to JWT'
}

describe('pinFoldFacts', () => {
  it('is a no-op when the summary already cites every pinned fact', () => {
    const summary = `## Session Intent
Rewrite auth to JWT

## Files Touched
- src/auth.ts
- src/session.ts

## Key Decisions
- Use JWT

## Constraints
- Do not log secrets

## Next Steps
- Add auth tests
- Login uses JWT`
    expect(pinFoldFacts(summary, facts)).toBe(summary.trimEnd())
  })

  it('appends only missing facts and then verifies', () => {
    const summary = `## Session Intent
Worked on auth

## Files Touched
- src/invented/nope.ts`
    const pinned = pinFoldFacts(summary, facts)
    expect(pinned).toContain('## Pinned Facts')
    expect(pinned).toContain('src/auth.ts')
    expect(pinned).toContain('Use JWT')
    expect(pinned).toContain('Do not log secrets')
    expect(pinned).toContain('Add auth tests')
    expect(pinned).toContain('Login uses JWT')
    expect(pinned).toContain('Rewrite auth to JWT')
    const scored = verifyCompactionSummary(pinned, facts, 'edit src/auth.ts')
    expect(scored.failures.some((f) => f.kind === 'invented_path')).toBe(true)
    expect(scored.failures.some((f) => f.kind === 'missing_wrote_file')).toBe(false)
    expect(scored.failures.some((f) => f.kind === 'missing_decision')).toBe(false)
    expect(scored.failures.some((f) => f.kind === 'missing_constraint')).toBe(false)
  })

  it('mergeFoldFacts unions prior pinned facts with the current fold', () => {
    const prior = foldFactsToPinned({
      files: ['src/old/a.ts'],
      wroteFiles: ['src/old/a.ts'],
      decisions: ['Keep the old store'],
      todos: [],
      doneWhen: [],
      constraints: ['Never rewrite history']
    })
    const merged = mergeFoldFacts(
      {
        files: prior.files,
        wroteFiles: prior.wroteFiles,
        decisions: prior.decisions,
        todos: prior.todos,
        doneWhen: prior.doneWhen,
        constraints: prior.constraints,
        contractGoal: prior.contractGoal
      },
      facts
    )
    expect(merged.wroteFiles).toEqual(expect.arrayContaining(['src/old/a.ts', 'src/auth.ts']))
    expect(merged.constraints).toEqual(
      expect.arrayContaining(['Never rewrite history', 'Do not log secrets'])
    )
  })

  it('formatPinnedFacts lists sidecar facts for assemble', () => {
    const text = formatPinnedFacts(foldFactsToPinned(facts))
    expect(text).toContain('Goal: Rewrite auth to JWT')
    expect(text).toContain('`src/auth.ts`')
    expect(text).toContain('Decision: Use JWT')
    expect(text).toContain('Constraint: Do not log secrets')
  })
})

describe('stripPinnedFactsAppendix', () => {
  it('keeps the new narrative when a rolling fold carries the prior appendix', () => {
    // compactMessages merges `<prior summary>\n---\n<new summary>`, and the prior
    // half ends in its own `## Pinned Facts`. An end-anchored strip took the new
    // narrative with it, so every fold after the first kept only fold #1's prose.
    const rolling = [
      '## Session Intent',
      'Fold 1: started the auth rewrite.',
      '',
      '## Pinned Facts',
      '- Wrote: `src/auth.ts`',
      '',
      '---',
      '',
      '## Session Intent',
      'Fold 2: migrated the token store and fixed the refresh loop.',
      '',
      '## Files Touched',
      '- `src/token.ts`'
    ].join('\n')

    const stripped = stripPinnedFactsAppendix(rolling)

    expect(stripped).toContain('Fold 1: started the auth rewrite.')
    expect(stripped).toContain('Fold 2: migrated the token store and fixed the refresh loop.')
    expect(stripped).toContain('`src/token.ts`')
    expect(stripped).toContain('---')
    expect(stripped).not.toContain('Pinned Facts')
  })

  it('removes every appendix in a summary merged across several folds', () => {
    const merged = 'A.\n\n## Pinned Facts\n- Wrote: `a.ts`\n\n---\n\nB.\n\n## Pinned Facts\n- Wrote: `b.ts`'
    expect(stripPinnedFactsAppendix(merged)).toBe('A.\n\n---\n\nB.')
  })

  it('leaves a summary without an appendix alone', () => {
    const summary = '## Session Intent\nJust prose.'
    expect(stripPinnedFactsAppendix(summary)).toBe(summary)
  })

  it('is stable across CRLF line endings', () => {
    const summary = 'A.\n\n## Pinned Facts\n- Wrote: `a.ts`\n\n---\n\nB.'
    expect(stripPinnedFactsAppendix(summary.replace(/\n/g, '\r\n'))).toBe(
      stripPinnedFactsAppendix(summary)
    )
  })

  it('round-trips with pinFoldFacts: re-pinning yields one current block', () => {
    const once = pinFoldFacts('## Session Intent\nWorked on auth.', facts)
    const twice = pinFoldFacts(once, facts)
    expect(twice).toBe(once)
    expect(twice.match(/## Pinned Facts/g)).toHaveLength(1)
  })
})
