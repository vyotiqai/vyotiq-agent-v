/**
 * GitHub's hosted MCP asked the user to register an OAuth app by hand.
 *
 * GitHub advertises no dynamic client registration, so the connect wizard's
 * only honest instruction for `auth: "oauth-client"` was: open
 * github.com/settings/applications/new, create an app, paste a client id and
 * a secret. Meanwhile the app already signs in to GitHub on its own account —
 * device flow, no secret, one click — and `api.githubcopilot.com` accepts that
 * same user token as a Bearer. These cover reusing it, and the boundaries that
 * keep the reuse from surprising anyone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const ISOLATED_USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-ghauth-'))

vi.mock('electron', () => ({
  app: {
    getPath: () => ISOLATED_USER_DATA,
    getAppPath: () => process.cwd(),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  },
  BrowserWindow: class {},
  nativeTheme: { shouldUseDarkColors: false, on: () => undefined }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/workspace/workspaces', () => ({
  readWorkspacesState: () => ({ openPaths: [], activePath: null, workspaces: [] }),
  findWorkspaceSettingsOverride: () => undefined
}))

import {
  getMcpServerStatus,
  hasInheritedMcpBearer,
  resolveMcpBearerToken,
  resolveMcpRequestHeaders
} from '@main/agent/mcp'
import {
  clearGithubAccessToken,
  clearMcpAuthToken,
  setGithubAccessToken,
  setMcpAuthToken
} from '@main/settings/secrets'

const APP_TOKEN = 'gho_appsigninfromdeviceflow'

const githubServer = {
  id: 'github',
  name: 'GitHub',
  enabled: true,
  transport: 'http' as const,
  url: 'https://api.githubcopilot.com/mcp/',
  auth: 'oauth-client' as const
}

const otherServer = { ...githubServer, id: 'linear', name: 'Linear', url: 'https://mcp.linear.app/mcp' }

function forget(): void {
  try {
    clearGithubAccessToken()
  } catch {
    /* nothing stored */
  }
  for (const id of ['github', 'linear']) {
    try {
      clearMcpAuthToken(id)
    } catch {
      /* nothing stored */
    }
  }
}

beforeEach(forget)
afterEach(forget)

describe('the GitHub MCP server borrowing the app sign-in', () => {
  it('sends nothing when the user has not signed in to GitHub', () => {
    expect(hasInheritedMcpBearer('github')).toBe(false)
    expect(resolveMcpRequestHeaders(githubServer)).toBeUndefined()
  })

  it('sends the app GitHub token once the user has signed in', () => {
    setGithubAccessToken(APP_TOKEN)

    expect(hasInheritedMcpBearer('github')).toBe(true)
    expect(resolveMcpRequestHeaders(githubServer)).toEqual({
      Authorization: `Bearer ${APP_TOKEN}`
    })
  })

  it('does not lend the GitHub token to any other server', () => {
    setGithubAccessToken(APP_TOKEN)

    expect(hasInheritedMcpBearer('linear')).toBe(false)
    expect(resolveMcpRequestHeaders(otherServer)).toBeUndefined()
  })

  it('prefers a credential stored for the server itself', () => {
    // A user who pasted a PAT for GitHub MCP chose that identity on purpose.
    setGithubAccessToken(APP_TOKEN)
    setMcpAuthToken('github', 'ghp_thepatthisuserpastedhere')

    expect(resolveMcpBearerToken('github')).toBe('ghp_thepatthisuserpastedhere')
  })

  it('stops the card asking for a sign-in it does not need', () => {
    // `hasAuthToken` is what the wizard and the card read to decide whether a
    // credential is still outstanding.
    expect(getMcpServerStatus([githubServer])[0].hasAuthToken).toBe(false)

    setGithubAccessToken(APP_TOKEN)

    expect(getMcpServerStatus([githubServer])[0].hasAuthToken).toBe(true)
  })
})
