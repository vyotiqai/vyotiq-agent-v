import { describe, expect, it } from 'vitest'
import {
  detectSummaryRefusal,
  formatCompactionVerifyFailure,
  verifyCompactionSummary,
  type FoldFacts
} from '@main/agent/context/verifyCompaction'

const facts: FoldFacts = {
  decisions: ['Anchor refusal detection on the summary opening, not the full text'],
  todos: [],
  doneWhen: [],
  constraints: ['Do not add new dependencies'],
  files: [
    'src/main/agent/context/verifyCompaction.ts',
    'tests/main/unit/compactionVerifyRefusal.test.ts'
  ],
  wroteFiles: ['src/main/agent/context/verifyCompaction.ts']
}

const genuineSummary = [
  '## Session Intent',
  'Anchor refusal detection on the summary opening, not the full text, so quoted refusals stay.',
  '',
  '## Files Touched',
  '- `src/main/agent/context/verifyCompaction.ts`',
  '',
  '## Key Decisions',
  '- Anchor refusal detection on the summary opening, not the full text',
  '',
  '## Constraints',
  '- Do not add new dependencies',
  '',
  '## Next Steps',
  '- Run the verification suite.'
].join('\n')

describe('verifyCompactionSummary refusal detection', () => {
  it('fails a refusal-style summarizer output with an explicit refusal line', () => {
    const refusalSummary = [
      '## Session Intent',
      "I can't comply with this request, but I can explain how to write a session summary.",
      '',
      '## Files Touched',
      '- (none)'
    ].join('\n')

    const result = verifyCompactionSummary(refusalSummary, facts)
    expect(result.ok).toBe(false)
    const refusalFailure = result.failures.find((failure) => failure.kind === 'refusal')
    expect(refusalFailure).toBeDefined()
    const lines = result.failures.map(formatCompactionVerifyFailure)
    expect(lines.some((line) => line.startsWith('Refusal detected:'))).toBe(true)
  })

  it('detects the "I am unable to" opener variant', () => {
    expect(
      detectSummaryRefusal('I am unable to comply with this request, but I can explain instead.')
    ).not.toBeNull()
  })

  it('passes a genuine in-facts summary', () => {
    const result = verifyCompactionSummary(genuineSummary, facts)
    expect(result.ok).toBe(true)
    expect(result.failures.some((failure) => failure.kind === 'refusal')).toBe(false)
  })

  it('does not reject a summary that quotes refusal text deep inside real content', () => {
    const quotedSummary = [
      '## Session Intent',
      'Fix the compaction verification gap for refusal-style summarizer outputs.',
      '',
      '## Files Touched',
      '- `src/main/agent/context/verifyCompaction.ts`',
      '- `tests/main/unit/compactionVerifyRefusal.test.ts`',
      '',
      '## Key Decisions',
      '- Anchor refusal detection on the summary opening, not the full text',
      '- Reject the model reply "I can\'t comply with this request, but I can explain how to write a session summary" recorded mid-transcript rather than trusting coverage alone.',
      '',
      '## Constraints',
      '- Do not add new dependencies',
      '',
      '## Next Steps',
      '- Run the verification suite.'
    ].join('\n')

    const result = verifyCompactionSummary(quotedSummary, facts)
    expect(result.ok).toBe(true)
    expect(result.failures.some((failure) => failure.kind === 'refusal')).toBe(false)
  })
})
