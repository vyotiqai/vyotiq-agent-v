import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFile, spawnSync } = vi.hoisted(() => ({
  execFile: vi.fn(),
  spawnSync: vi.fn(() => ({ status: 0, stdout: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe\n' }))
}))

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execFile, spawnSync }
})

import {
  commandOnPath,
  prewarmCommandOnPath,
  resetCommandOnPathCacheForTests
} from '@main/agent/tools/terminal'

describe('prewarmCommandOnPath', () => {
  beforeEach(() => {
    resetCommandOnPathCacheForTests()
    execFile.mockReset()
    spawnSync.mockClear()
  })

  // The first run's session env looked up pwsh with a blocking spawnSync
  // (~370ms on the main thread). Warmed at startup, it is a cache hit.
  it('answers a later lookup from the cache, without a blocking spawn', () => {
    execFile.mockImplementation((_file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
      cb(args[0] === 'pwsh' ? null : new Error('not found'), args[0] === 'pwsh' ? 'C:\\pwsh.exe\n' : '')
    })

    prewarmCommandOnPath(['pwsh', 'powershell'])

    expect(commandOnPath('pwsh')).toBe(true)
    expect(commandOnPath('powershell')).toBe(false)
    expect(spawnSync).not.toHaveBeenCalled()
  })

  it('keeps an answer a synchronous lookup already cached', () => {
    commandOnPath('pwsh')
    prewarmCommandOnPath(['pwsh'])
    expect(execFile).not.toHaveBeenCalled()
    expect(spawnSync).toHaveBeenCalledTimes(1)
  })
})
