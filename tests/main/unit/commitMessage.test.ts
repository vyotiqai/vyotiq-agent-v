import { describe, expect, it } from 'vitest'
import { parseGeneratedCommitMessage } from '@main/git/commitMessage'

describe('commit message generation', () => {
  it('accepts a conventional subject from a fenced model response', () => {
    expect(parseGeneratedCommitMessage('```text\nfeat(cli): add shell tools\n```')).toBe(
      'feat(cli): add shell tools'
    )
  })

  it('rejects vague file-count and placeholder suggestions', () => {
    expect(parseGeneratedCommitMessage('Update 11 files')).toBeNull()
    expect(parseGeneratedCommitMessage('chore: update 11 files')).toBeNull()
    expect(parseGeneratedCommitMessage('WIP')).toBeNull()
    expect(parseGeneratedCommitMessage('fix')).toBeNull()
    expect(parseGeneratedCommitMessage('fix: fix')).toBeNull()
  })

  it('normalizes a useful plain-language response into a conventional subject', () => {
    expect(parseGeneratedCommitMessage('Fix the shell tool exit handling')).toBe(
      'fix: Fix the shell tool exit handling'
    )
  })

  it('prefers a conventional subject when the model adds commentary', () => {
    expect(
      parseGeneratedCommitMessage(
        'Here is the suggested commit message:\n\nrefactor(tools): share shell execution helpers\n\nThis keeps the tools consistent.'
      )
    ).toBe('refactor(tools): share shell execution helpers')
  })

  it('keeps generated subjects within the review-friendly length limit', () => {
    const result = parseGeneratedCommitMessage(
      'feat: add a deliberately long but still meaningful change description that should be shortened safely'
    )
    expect(result).toBeTruthy()
    expect(result!.length).toBeLessThanOrEqual(72)
  })
})
