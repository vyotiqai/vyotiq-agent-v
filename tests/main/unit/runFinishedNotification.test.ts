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
 */
describe('runFinishedNotificationText', () => {
  it('reads a plain finished or failed run exactly as it did', () => {
    expect(runFinishedNotificationText({ failed: false, goal: 'Fix tests' })).toEqual({
      title: 'Finished: Fix tests',
      body: 'Agent run finished'
    })
    expect(runFinishedNotificationText({ failed: true })).toEqual({
      title: 'Failed',
      body: 'Agent run failed'
    })
  })
})
