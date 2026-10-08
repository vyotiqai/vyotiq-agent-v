import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { closingIssuesFrom, prBodyFrom } from '@renderer/features/chat/components/prDraft'
import { followUpOrigin, issueTaskBrief, prCheckInstruction } from '@renderer/features/task/followUps'
import { isActionsJobUrl } from '@renderer/features/chat/components/PrPanel'

const user = (content: string): UiItem => ({ kind: 'message', id: content, role: 'user', content })
const assistant = (content: string): UiItem => ({ kind: 'message', id: content, role: 'assistant', content })

/** The failing step as the PR panel reads it from the real job log (see ghCiIssues.test.ts). */
const LOG = {
  step: 'node scripts/typecheck-tests-ratchet.mjs',
  excerpt: 'tsconfig.tests-node.json: 1 file(s) gained type errors:\nError: Process completed with exit code 1.',
  truncated: false
}

describe('prCheckInstruction with the failing step', () => {
  const check = { name: 'ubuntu-latest', url: 'https://github.com/o/r/actions/runs/1/job/2' }

  it('carries the failing step under the ask, and the record still reads it as a check fix', () => {
    const text = prCheckInstruction(check, 64, LOG)
    expect(text).toBe(
      [
        'The “ubuntu-latest” check failed on pull request #64. Read its log at https://github.com/o/r/actions/runs/1/job/2, find the cause and fix it.',
        '',
        'Failing step (node scripts/typecheck-tests-ratchet.mjs):',
        '```',
        LOG.excerpt,
        '```'
      ].join('\n')
    )
    expect(followUpOrigin(text)).toEqual({
      kind: 'prCheck',
      icon: 'pullRequest',
      ask: 'Fix the failing “ubuntu-latest” check on #64',
      about: 'node scripts/typecheck-tests-ratchet.mjs'
    })
  })

  it('is the plain ask without a log, as before', () => {
    expect(prCheckInstruction(check, 64)).toBe(prCheckInstruction(check, 64, null))
    expect(followUpOrigin(prCheckInstruction(check, 64))?.ask).toBe('Fix the failing “ubuntu-latest” check on #64')
  })

  it('fences a log that has backticks with tildes, and keeps only its end', () => {
    const text = prCheckInstruction(check, 64, { step: null, excerpt: `${'x'.repeat(5_000)}\n\`\`\`code\`\`\``, truncated: true })
    expect(text).toMatch(/\nFailing step, last lines:\n~~~~\n…\n/)
    expect(text.length).toBeLessThan(4_400)
    expect(followUpOrigin(text)?.kind).toBe('prCheck')
  })
})

describe('issueTaskBrief', () => {
  it('is the issue to resolve, its words, and a closing line', () => {
    expect(
      issueTaskBrief({ number: 12, title: ' Crash on start ', url: 'https://github.com/o/r/issues/12', body: 'Steps:\n1. open\n' })
    ).toBe(['Resolve GitHub issue #12: Crash on start', 'https://github.com/o/r/issues/12', '', 'Steps:\n1. open', '', 'Fixes #12'].join('\n'))
  })

  it('keeps a long description short and skips an empty one', () => {
    const brief = issueTaskBrief({ number: 3, title: 't', url: '', body: 'y'.repeat(10_000) })
    expect(brief.length).toBeLessThan(6_100)
    expect(issueTaskBrief({ number: 3, title: 't', url: '', body: '  ' })).toBe('Resolve GitHub issue #3: t\n\nFixes #3')
  })
})

describe('closingIssuesFrom and the PR body', () => {
  it('reads the closing lines the person sent, once each, never the agent’s', () => {
    const items = [
      user(issueTaskBrief({ number: 12, title: 't', url: '', body: '' })),
      assistant('Fixes #99'),
      user('also\nCloses #7\nfixes #12'),
      user('this fixes #5 in passing')
    ]
    expect(closingIssuesFrom(items)).toEqual([12, 7])
  })

  it('ends a drafted PR body with each issue it closes, unless the summary already says so', () => {
    expect(prBodyFrom({ summary: 'Done.', checks: [], closes: [12, 7] })).toBe('Done.\n\nFixes #12\nFixes #7')
    expect(prBodyFrom({ summary: 'Done.\n\nCloses #12', checks: [], closes: [12] })).toBe('Done.\n\nCloses #12')
    expect(prBodyFrom({ summary: '', checks: [], closes: [12] })).toBe('')
  })
})

describe('isActionsJobUrl', () => {
  it('matches the job links main can read, and nothing else', () => {
    expect(isActionsJobUrl('https://github.com/vyotiqai/vyotiq-agent-v/actions/runs/37205055756/job/111444405036')).toBe(true)
    expect(isActionsJobUrl('https://cursor.com/agents/bc-465f9607')).toBe(false)
    expect(isActionsJobUrl(null)).toBe(false)
  })
})
