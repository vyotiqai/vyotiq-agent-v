import { describe, expect, it } from 'vitest'
import { prErrorLine } from '@renderer/features/chat/components/PrPanel'

describe('a pull request error, in a line', () => {
  it('gives what gh said, not the command main ran', () => {
    const raw = ['HTTP 502: Bad Gateway', 'Command failed: gh.exe pr view --json number,title,url,state,baseRefName,headRefName'].join('\n')
    expect(prErrorLine(raw)).toBe('HTTP 502: Bad Gateway')
  })

  it('skips a leading command line', () => {
    expect(prErrorLine(['Command failed: gh pr view', 'rate limit exceeded'].join('\r\n'))).toBe('rate limit exceeded')
  })

  it('says something when gh said nothing', () => {
    expect(prErrorLine('Command failed: gh pr view')).toBe('GitHub did not answer. Refresh to try again.')
  })

  it('keeps a long line short', () => {
    expect(prErrorLine('x'.repeat(500))).toHaveLength(240)
  })
})
