import { beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsync, spawnMock } = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  spawnMock: vi.fn()
}))

vi.mock('electron', () => ({
  app: {
    getPath: () => 'C:/vyotiq-userdata'
  }
}))

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>()
  return {
    ...actual,
    promisify: () => execFileAsync
  }
})

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: '' }))
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(() => ({
      on: vi.fn(),
      once: vi.fn(),
      emit: vi.fn()
    })),
    readdirSync: vi.fn(() => []),
    readFileSync: vi.fn(() => ''),
    renameSync: vi.fn(),
    chmodSync: vi.fn(),
    unlinkSync: vi.fn()
  }
})

vi.mock('@main/agent/tools/terminal', () => ({
  commandOnPath: vi.fn(() => false),
  invalidateCommandOnPathCache: vi.fn(),
  sanitizedTerminalEnv: vi.fn(() => ({ PATH: '/bin' }))
}))

vi.mock('@main/storage/atomicWrite', () => ({
  atomicWriteJson: vi.fn()
}))

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { spawnSync } from 'child_process'
import { commandOnPath } from '@main/agent/tools/terminal'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import {
  discoverGhExecutable,
  ghAvailable,
  installGithubCli,
  knownGhPaths,
  resetGhBinaryCacheForTests
} from '@main/git/ghBinary'

describe('ghBinary', () => {
  beforeEach(() => {
    execFileAsync.mockReset()
    spawnMock.mockReset()
    vi.mocked(commandOnPath).mockReset()
    vi.mocked(commandOnPath).mockReturnValue(false)
    vi.mocked(existsSync).mockReturnValue(false)
    resetGhBinaryCacheForTests()
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: false,
        status: 404,
        body: null
      }))
    )
  })

  it('reports gh unavailable when no binary is found', async () => {
    execFileAsync.mockRejectedValueOnce(new Error('not found'))
    await expect(ghAvailable()).resolves.toBe(false)
  })

  it('finds gh under the WinGet user install layout on Windows', () => {
    const originalPlatform = process.platform
    const originalLocalAppData = process.env.LOCALAPPDATA
    process.env.LOCALAPPDATA = 'C:\\Users\\me\\AppData\\Local'
    Object.defineProperty(process, 'platform', { value: 'win32' })

    const wingetGh = join('C:\\Users\\me\\AppData\\Local', 'Microsoft', 'WinGet', 'Links', 'gh.exe')
    const asWinPath = (value: string): string => value.replace(/\//g, '\\').toLowerCase()
    vi.mocked(existsSync).mockImplementation((target) => {
      return asWinPath(String(target)) === asWinPath(wingetGh)
    })

    try {
      expect(knownGhPaths()).toEqual([wingetGh])
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
      if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA
      else process.env.LOCALAPPDATA = originalLocalAppData
    }
  })

  it('installs via winget on Windows when available', async () => {
    vi.stubEnv('LOCALAPPDATA', 'C:/Users/me/AppData/Local')
    vi.mocked(commandOnPath).mockImplementation((bin) => bin === 'winget')
    const wingetGh = 'C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe'
    let installed = false
    vi.mocked(existsSync).mockImplementation((target) => {
      if (!installed) return false
      return String(target).replace(/\//g, '\\').toLowerCase() === wingetGh.toLowerCase()
    })
    vi.mocked(spawnSync).mockReturnValue({
      status: 0,
      stdout: `${wingetGh}\n`,
      stderr: '',
      pid: 1,
      output: [null, `${wingetGh}\n`, ''],
      signal: null
    })
    execFileAsync.mockResolvedValue({ stdout: 'gh version 2.63.0', stderr: '' })

    spawnMock.mockImplementation(() => {
      installed = true
      return {
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: (event: string, cb: (code?: number) => void) => {
          if (event === 'close') cb(0)
        },
        kill: vi.fn()
      }
    })

    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })

    try {
      const result = await installGithubCli()
      expect(result.installed).toBe(true)
      expect(result.ghAvailable).toBe(true)
      expect(spawnMock).toHaveBeenCalledWith(
        'winget',
        expect.arrayContaining(['install', '--id', 'GitHub.cli']),
        expect.any(Object)
      )
      expect(atomicWriteJson).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform })
    }
  })

  it('reuses a persisted gh path without requiring PATH refresh', async () => {
    const persisted = 'C:/vyotiq-userdata/bin/gh.exe'
    const recordPath = 'C:/vyotiq-userdata/gh-cli.json'
    vi.mocked(existsSync).mockImplementation((target) => {
      const normalized = String(target).replace(/\\/g, '/')
      return normalized === persisted || normalized === recordPath
    })
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({ version: 1, executable: persisted })
    )
    vi.mocked(spawnSync).mockReturnValue({
      status: 1,
      stdout: '',
      stderr: '',
      pid: 1,
      output: [null, '', ''],
      signal: null
    })
    execFileAsync.mockResolvedValue({ stdout: 'gh version 2.63.0', stderr: '' })

    await expect(discoverGhExecutable()).resolves.toBe(persisted)
    expect(commandOnPath).not.toHaveBeenCalled()
  })

  it('returns already-available without spawning an installer', async () => {
    const ghPath =
      process.platform === 'win32' ? 'C:\\vyotiq-userdata\\bin\\gh.exe' : 'C:/vyotiq-userdata/bin/gh'
    vi.mocked(existsSync).mockImplementation((target) => {
      return String(target).replace(/\\/g, '/') === ghPath.replace(/\\/g, '/')
    })
    execFileAsync.mockResolvedValue({ stdout: 'gh version 2.63.0', stderr: '' })
    const result = await installGithubCli()
    expect(result.detail).toMatch(/already available/i)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
