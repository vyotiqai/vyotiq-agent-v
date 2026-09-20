import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { execFileAsync, spawnMock, openExternalMock } = vi.hoisted(() => ({
  execFileAsync: vi.fn(),
  spawnMock: vi.fn(),
  openExternalMock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({}))
}))

vi.mock('@main/settings/secrets', () => {
  let stored: string | null = null
  return {
    getGithubAccessToken: vi.fn(() => stored),
    hasGithubAccessToken: vi.fn(() => Boolean(stored)),
    setGithubAccessToken: vi.fn((token: string) => {
      stored = token
    }),
    clearGithubAccessToken: vi.fn(() => {
      stored = null
    }),
    resetGithubTokenForTests: () => {
      stored = null
    }
  }
})

vi.mock('electron', () => ({
  app: {
    getPath: () => '/tmp/vyotiq-userdata'
  },
  shell: {
    openExternal: (...args: unknown[]) => openExternalMock(...args)
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
  spawn: (...args: unknown[]) => spawnMock(...args)
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => [])
  }
})

vi.mock('@main/git/ghBinary', () => ({
  ghAvailable: vi.fn(async () => true),
  resolveGhExecutable: vi.fn(async () => 'gh'),
  resetGhBinaryCacheForTests: vi.fn()
}))
vi.mock('@main/agent/tools/terminal', () => ({
  commandOnPath: vi.fn(() => true),
  invalidateCommandOnPathCache: vi.fn(),
  sanitizedTerminalEnv: vi.fn(() => ({ PATH: '/bin' }))
}))

import { clearGithubAccessToken, setGithubAccessToken } from '@main/settings/secrets'
import {
  githubAuthStatus,
  injectPendingGithubAuthForTests,
  isGithubCliUsableToken,
  linkNativeGithubFromMcpToken,
  onGithubAuthStatus,
  parseGithubOAuthBody,
  pollGithubAuthForTests,
  resetGithubAuthForTests,
  resolveGhTokenForCli,
  resolveGithubClientId,
  setupGithubGitAuth,
  startGithubAuth
} from '@main/git/githubAuth'
import { VYOTIQ_GITHUB_OAUTH_CLIENT_ID } from '@main/git/githubAuth'

describe('githubAuth helpers', () => {
  afterEach(() => {
    resetGithubAuthForTests()
    vi.mocked(clearGithubAccessToken)()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  beforeEach(() => {
    vi.mocked(clearGithubAccessToken)()
    execFileAsync.mockRejectedValue(new Error('not logged in'))
    spawnMock.mockImplementation(() => {
      const child = {
        stdin: { write: vi.fn(), end: vi.fn() },
        stdout: { on: vi.fn() },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, fn: (code?: number) => void) => {
          if (event === 'close') queueMicrotask(() => fn(0))
        }),
        kill: vi.fn()
      }
      return child
    })
  })

  it('resolves the official Vyotiq OAuth client id with no user configuration', () => {
    vi.stubEnv('VYOTIQ_GITHUB_CLIENT_ID', 'from-env')
    expect(resolveGithubClientId()).toBe(VYOTIQ_GITHUB_OAUTH_CLIENT_ID)
    expect(resolveGithubClientId()).not.toBe('178c6fc778ccc68e1d6a')
  })

  it('uses only the stored app token and never ambient GH_TOKEN', () => {
    vi.stubEnv('GH_TOKEN', 'ambient')
    vi.mocked(setGithubAccessToken)('app-token')
    expect(resolveGhTokenForCli()).toBe('app-token')

    vi.mocked(clearGithubAccessToken)()
    expect(resolveGhTokenForCli()).toBeUndefined()
  })

  it('setupGithubGitAuth error mentions gh auth login remediation when setup-git fails', async () => {
    execFileAsync.mockRejectedValue(new Error('not logged in'))
    await expect(setupGithubGitAuth()).rejects.toThrow(/gh auth login/)
  })

  it('reports pending false when the device code expired', async () => {
    injectPendingGithubAuthForTests({ expiresAt: 0 })
    await pollGithubAuthForTests()
    const status = await githubAuthStatus()
    expect(status.pending).toBe(false)
    expect(status.error).toMatch(/expired/i)
  })

  it('starts GitHub device flow without spawning gh auth login', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'WXYZ-9876',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          }),
        headers: { get: () => 'application/json' }
      })
    )
    const status = await startGithubAuth()
    expect(spawnMock).not.toHaveBeenCalled()
    expect(openExternalMock).toHaveBeenCalledWith('https://github.com/login/device')
    expect(status.pending).toBe(true)
    expect(status.userCode).toBe('WXYZ-9876')
    expect(status.verificationUri).toBe('https://github.com/login/device')
  })

  it('opens verification_uri_complete when GitHub returns it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            verification_uri_complete: 'https://github.com/login/device?user_code=ABCD-1234',
            expires_in: 900,
            interval: 5
          }),
        headers: { get: () => 'application/json' }
      })
    )
    const status = await startGithubAuth()
    expect(openExternalMock).toHaveBeenCalledWith(
      'https://github.com/login/device?user_code=ABCD-1234'
    )
    expect(status.userCode).toBe('ABCD-1234')
  })

  it('rejects a non-github.com verification host', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          device_code: 'd',
          user_code: 'ABCD-1234',
          verification_uri: 'https://evil.example/login',
          expires_in: 900,
          interval: 5
        }),
        text: async () =>
          JSON.stringify({
            device_code: 'd',
            user_code: 'ABCD-1234',
            verification_uri: 'https://evil.example/login',
            expires_in: 900,
            interval: 5
          }),
        headers: { get: () => 'application/json' }
      })
    )
    await expect(startGithubAuth()).rejects.toThrow(/github\.com/i)
  })

  it('parses GitHub form-urlencoded token bodies', () => {
    const parsed = parseGithubOAuthBody(
      'access_token=gho_secret&token_type=bearer&scope=repo%2Cgist',
      'application/x-www-form-urlencoded'
    )
    expect(parsed.access_token).toBe('gho_secret')
    expect(parsed.token_type).toBe('bearer')
  })

  it('stores the token and clears pending when the device poll succeeds', async () => {
    const seen: Array<{ pending: boolean; ghAuthenticated: boolean }> = []
    onGithubAuthStatus((status) => {
      seen.push({ pending: status.pending, ghAuthenticated: status.ghAuthenticated })
    })
    injectPendingGithubAuthForTests({})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () => 'access_token=gho_from_github&token_type=bearer&scope=repo',
        headers: { get: () => 'application/x-www-form-urlencoded' }
      })
    )
    await pollGithubAuthForTests()
    expect(vi.mocked(setGithubAccessToken)).toHaveBeenCalledWith('gho_from_github')
    const status = await githubAuthStatus()
    expect(status.pending).toBe(false)
    expect(status.ghAuthenticated).toBe(true)
    expect(status.hasAppToken).toBe(true)
    expect(seen.some((s) => s.ghAuthenticated && !s.pending)).toBe(true)
    expect(resolveGhTokenForCli()).toBe('gho_from_github')
  })

  it('exchanges the device code without a client secret', async () => {
    injectPendingGithubAuthForTests({ deviceCode: 'device-xyz' })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ access_token: 'gho_json' }),
      headers: { get: () => 'application/json' }
    })
    vi.stubGlobal('fetch', fetchMock)
    await pollGithubAuthForTests()
    expect(fetchMock).toHaveBeenCalled()
    const init = fetchMock.mock.calls[0]?.[1] as { body?: string }
    const body = new URLSearchParams(init.body)
    expect(body.get('client_id')).toBe(VYOTIQ_GITHUB_OAUTH_CLIENT_ID)
    expect(body.get('client_secret')).toBeNull()
    expect(body.get('device_code')).toBe('device-xyz')
    expect(body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code')
  })

  it('keeps polling after a transient token-endpoint failure', async () => {
    injectPendingGithubAuthForTests({})
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({ error: 'authorization_pending' }),
        headers: { get: () => 'application/json' }
      })
    )
    await pollGithubAuthForTests()
    const status = await githubAuthStatus()
    expect(status.pending).toBe(true)
    expect(status.error).toBeNull()
  })

  /**
   * Connect GitHub opened a browser and then hung, twice, on a machine where
   * `gh auth login` had already been run:
   *
   *   22:01:04 [github-auth] Starting GitHub device authorization
   *   22:01:10 [github-auth] GitHub CLI already signed in; ending device wait
   *
   * The flow noticed the CLI six seconds in and cancelled itself — without
   * keeping the token. `ghAuthenticated` went true, `hasAppToken` stayed
   * false, so the dialog waited for a token nothing was going to produce and
   * the GitHub MCP, which reads Agent V's own storage, still had no Bearer.
   */
  describe('a machine where the GitHub CLI is already signed in', () => {
    it('takes that sign-in instead of asking for a device code', async () => {
      execFileAsync.mockResolvedValue({ stdout: 'gho_alreadysignedinwithgh\n', stderr: '' })
      const fetchMock = vi.fn()
      vi.stubGlobal('fetch', fetchMock)

      const status = await startGithubAuth()

      expect(fetchMock).not.toHaveBeenCalled()
      expect(openExternalMock).not.toHaveBeenCalled()
      expect(vi.mocked(setGithubAccessToken)).toHaveBeenCalledWith('gho_alreadysignedinwithgh')
      expect(status.hasAppToken).toBe(true)
      expect(status.pending).toBe(false)
    })

    it('keeps the token when the user signs in with gh mid-flow', async () => {
      injectPendingGithubAuthForTests({})
      execFileAsync.mockResolvedValue({ stdout: 'gho_fromtheterminal', stderr: '' })
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          text: async () => JSON.stringify({ error: 'authorization_pending' }),
          headers: { get: () => 'application/json' }
        })
      )

      await pollGithubAuthForTests()
      // Adoption runs off the poll, so the token lands a tick later.
      await vi.waitFor(() => {
        expect(vi.mocked(setGithubAccessToken)).toHaveBeenCalledWith('gho_fromtheterminal')
      })

      const status = await githubAuthStatus()
      expect(status.pending).toBe(false)
      // What the cancel-and-forget version lost.
      expect(status.hasAppToken).toBe(true)
      // No point handing the CLI back the token it just gave us.
      expect(spawnMock).not.toHaveBeenCalled()
    })

    it('falls back to the device code when gh prints more than a token', async () => {
      execFileAsync.mockResolvedValue({
        stdout: 'gho_token\nwarning: your token is about to expire\n',
        stderr: ''
      })
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            device_code: 'd',
            user_code: 'ABCD-1234',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          }),
        headers: { get: () => 'application/json' }
      })
      vi.stubGlobal('fetch', fetchMock)

      const status = await startGithubAuth()

      expect(fetchMock).toHaveBeenCalled()
      expect(status.pending).toBe(true)
      expect(vi.mocked(setGithubAccessToken)).not.toHaveBeenCalled()
    })
  })

  it('treats classic PATs as gh-usable and Copilot tokens as not', () => {
    expect(isGithubCliUsableToken('ghp_abc')).toBe(true)
    expect(isGithubCliUsableToken('github_pat_abc')).toBe(true)
    expect(isGithubCliUsableToken('gho_abc')).toBe(true)
    expect(isGithubCliUsableToken('ya29.copilot-opaque')).toBe(false)
  })

  it('persists a PAT into native gh without starting device flow', async () => {
    const result = await linkNativeGithubFromMcpToken('ghp_from_mcp')
    expect(result).toEqual({ linked: true, startedDeviceFlow: false })
    expect(vi.mocked(setGithubAccessToken)).toHaveBeenCalledWith('ghp_from_mcp')
    expect(spawnMock).toHaveBeenCalled()
  })

  it('starts device flow when MCP OAuth token is not gh-usable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            device_code: 'device-1',
            user_code: 'WXYZ-9876',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5
          }),
        headers: { get: () => 'application/json' }
      })
    )
    const result = await linkNativeGithubFromMcpToken('copilot-opaque-token')
    expect(result.startedDeviceFlow).toBe(true)
    expect(result.linked).toBe(false)
    expect(openExternalMock).toHaveBeenCalled()
  })
})
