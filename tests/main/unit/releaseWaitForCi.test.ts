import { describe, expect, it } from 'vitest'
import { ciVerdict } from '../../../scripts/release-wait-for-ci.mjs'

const run = (status: string, conclusion: string, id = 1) => ({
  databaseId: id,
  status,
  conclusion,
  event: 'push',
  url: `https://github.com/o/r/actions/runs/${id}`
})

describe('release-wait-for-ci ciVerdict', () => {
  it('passes on a successful run', () => {
    expect(ciVerdict([run('completed', 'success')], { noRunExpired: false })).toMatchObject({ kind: 'pass' })
  })

  it('passes when a re-run succeeded after a failure', () => {
    const verdict = ciVerdict([run('completed', 'failure', 1), run('completed', 'success', 2)], {
      noRunExpired: true
    })
    expect(verdict).toMatchObject({ kind: 'pass', run: { databaseId: 2 } })
  })

  it('waits while a run is queued or in progress', () => {
    const verdict = ciVerdict([run('completed', 'failure', 1), run('in_progress', '', 2)], { noRunExpired: true })
    expect(verdict.kind).toBe('wait')
  })

  it('fails when every run finished without success, naming each one', () => {
    const verdict = ciVerdict([run('completed', 'failure', 1), run('completed', 'cancelled', 2)], {
      noRunExpired: false
    })
    expect(verdict).toMatchObject({ kind: 'fail' })
    const { reason } = verdict as { reason: string }
    expect(reason).toContain('failure (push) https://github.com/o/r/actions/runs/1')
    expect(reason).toContain('cancelled (push) https://github.com/o/r/actions/runs/2')
  })

  it('waits for CI to be queued, then fails once the grace period is over', () => {
    expect(ciVerdict([], { noRunExpired: false }).kind).toBe('wait')
    const verdict = ciVerdict([], { noRunExpired: true })
    expect(verdict).toMatchObject({ kind: 'fail' })
    expect((verdict as { reason: string }).reason).toContain('No CI run exists for this commit')
  })
})
