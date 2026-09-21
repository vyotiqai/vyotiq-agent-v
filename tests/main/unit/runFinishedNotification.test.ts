import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-notif-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import { runFinishedNotificationText } from '@main/agent/startAgentRun'

/**
 * What a finished run tells the user.
 *
 * The delegated-task flow is the one the user is away for, and it is exactly
 * the one that named nothing: a delegated run sets no goal, so the goal-only
 * title fell through to a bare "Finished" every time.
 */
describe('runFinishedNotificationText', () => {
  it('names the teammate and the work', () => {
    expect(
      runFinishedNotificationText({
        failed: false,
        goal: 'Audit the pricing pages',
        teammateName: 'Scout',
        delegated: true
      })
    ).toEqual({ title: 'Scout finished: Audit the pricing pages', body: 'Delegated task finished' })
  })

  it('still names the teammate when a delegated run set no goal', () => {
    // The regression case: this is the shape of nearly every delegated run.
    expect(
      runFinishedNotificationText({ failed: false, teammateName: 'Scout', delegated: true })
    ).toEqual({ title: 'Scout finished', body: 'Delegated task finished' })
  })

  it('reports a failure as a failure, with the same identification', () => {
    expect(
      runFinishedNotificationText({ failed: true, teammateName: 'Scout', delegated: true })
    ).toEqual({ title: 'Scout failed', body: 'Delegated task failed' })
  })

  it('leaves an unbound run reading exactly as it did', () => {
    expect(
      runFinishedNotificationText({ failed: false, goal: 'Fix tests', delegated: false })
    ).toEqual({ title: 'Finished: Fix tests', body: 'Agent run finished' })
    expect(runFinishedNotificationText({ failed: true, delegated: false })).toEqual({
      title: 'Failed',
      body: 'Agent run failed'
    })
  })

  it('treats a blank teammate name as no teammate', () => {
    // `agentProfileName` is optional on the status and a hand-edited one can
    // be whitespace; a title of " finished" would name nobody and look broken.
    expect(
      runFinishedNotificationText({
        failed: false,
        goal: 'Fix tests',
        teammateName: '   ',
        delegated: false
      })
    ).toEqual({ title: 'Finished: Fix tests', body: 'Agent run finished' })
  })

  it('distinguishes a teammate chat from a delegated task in the body', () => {
    // A teammate-bound chat the user sent by hand is not a delegated task, and
    // saying so would misreport where the work came from.
    expect(
      runFinishedNotificationText({ failed: false, teammateName: 'Scout', delegated: false })
    ).toEqual({ title: 'Scout finished', body: 'Agent run finished' })
  })
})
