import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => join(tmpdir(), 'vyotiq-owner-pid'), getAppPath: () => tmpdir(), isPackaged: false }
}))

import { ownedByLiveProcess, processAlive } from '@main/agent/state'

const NOW = Date.parse('2026-10-08T12:00:00.000Z')
const status = (over: Record<string, unknown>) =>
  ({ status: 'running', step: 3, updatedAt: '2026-10-08T11:59:00.000Z', ...over }) as never

describe('ownedByLiveProcess', () => {
  it('leaves a headless run alone while its process lives', () => {
    expect(ownedByLiveProcess(status({ ownerPid: 4242 }), NOW, () => true)).toBe(true)
  })

  it('treats a dead owner, our own process, or no owner as nobody', () => {
    expect(ownedByLiveProcess(status({ ownerPid: 4242 }), NOW, () => false)).toBe(false)
    expect(ownedByLiveProcess(status({ ownerPid: process.pid }), NOW, () => true)).toBe(false)
    expect(ownedByLiveProcess(status({}), NOW, () => true)).toBe(false)
  })

  it('stops trusting the id a day after the last write (ids get reused)', () => {
    expect(ownedByLiveProcess(status({ ownerPid: 4242, updatedAt: '2026-10-07T11:00:00.000Z' }), NOW, () => true)).toBe(false)
  })

  it('sees this process as alive', () => {
    expect(processAlive(process.pid)).toBe(true)
  })
})
