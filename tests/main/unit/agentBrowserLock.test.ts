import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  session: { fromPartition: () => ({ on: vi.fn() }) },
  WebContentsView: class {
    webContents = {
      on: vi.fn(),
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      close: vi.fn()
    }
    setBounds = vi.fn()
    setVisible = vi.fn()
  }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { resetAgentBrowserForTests, runWithBrowserMutexForTests } from '@main/app/agentBrowser'

describe('browser global mutex', () => {
  afterEach(() => {
    resetAgentBrowserForTests()
  })

  it('serializes concurrent browser ops', async () => {
    let inFlight = 0
    let maxInFlight = 0
    const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

    await runWithBrowserMutexForTests([
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay(25)
        inFlight -= 1
        return 'a'
      },
      async () => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await delay(25)
        inFlight -= 1
        return 'b'
      }
    ])

    expect(maxInFlight).toBe(1)
  })
})
