import { describe, expect, it } from 'vitest'
import type { DoneWhenCheck } from '@shared/doneWhenChecks'
import { prBodyFrom, prTitleFrom } from '@renderer/features/chat/components/prDraft'

const check = (id: string, text: string, verdict: DoneWhenCheck['verdict'], evidence?: string): DoneWhenCheck => ({
  id,
  text,
  source: 'brief',
  verdict,
  ...(evidence ? { evidence } : {}),
  createdAt: '2026-09-30T10:00:00.000Z'
})

describe('prBodyFrom', () => {
  it('is the summary, then each check met or not in words, with its evidence', () => {
    const body = prBodyFrom({
      summary: 'Failed webhooks retry with backoff.\n',
      checks: [
        check('c1', 'Retries back off', 'met', 'pnpm vitest webhook: 12 passed'),
        check('c2', 'Dead letters are kept', 'not_met', 'no table\nyet'),
        check('c3', 'Docs updated', null)
      ]
    })
    expect(body).toBe(
      [
        'Failed webhooks retry with backoff.',
        '',
        '## Done when',
        '',
        '- [x] Retries back off',
        '  Evidence: pnpm vitest webhook: 12 passed',
        '- [ ] Dead letters are kept (not met)',
        '  Evidence: no table yet',
        '- [ ] Docs updated (not checked)'
      ].join('\n')
    )
  })

  it('is the summary alone without checks, and empty without a summary', () => {
    expect(prBodyFrom({ summary: 'Done.', checks: [] })).toBe('Done.')
    expect(prBodyFrom({ summary: '  ', checks: [check('c1', 'x', 'met')] })).toBe('')
  })
})

describe('prTitleFrom', () => {
  it('is the task title, else the summary’s first line without heading marks', () => {
    expect(prTitleFrom({ title: 'Retry webhooks', summary: '# Other', checks: [] })).toBe('Retry webhooks')
    expect(prTitleFrom({ title: null, summary: '\n## Retry failed webhooks\nMore.', checks: [] })).toBe('Retry failed webhooks')
  })

  it('fits GitHub’s title limit', () => {
    expect(prTitleFrom({ summary: 'x'.repeat(400), checks: [] }).length).toBe(256)
  })
})
