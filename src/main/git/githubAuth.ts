import { execFile as execFileCb, spawn } from 'child_process'
import { promisify } from 'util'
import { shell } from 'electron'
import {
  clearGithubAccessToken,
  getGithubAccessToken,
  hasGithubAccessToken,
  setGithubAccessToken
} from '@main/settings/secrets'
import { sanitizedTerminalEnv } from '../agent/tools/terminal'
import { logger } from '../../shared/logger'
import { ghAvailable, resolveGhExecutable, resetGhBinaryCacheForTests } from './ghBinary'

const execFile = promisify(execFileCb)

const DEVICE_CODE_URL = 'https://github.com/login/device/code'
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const DEFAULT_SCOPE = 'repo read:org gist'
const GH_DEVICE_LOGIN_URL = 'https://github.com/login/device'
/**
 * Vyotiq's official GitHub OAuth app (owned by github.com/vyotiqai).
 * Device flow never uses a client secret, so shipping the client id in the
 * app is safe and users never need to paste credentials.
 */
export const VYOTIQ_GITHUB_OAUTH_CLIENT_ID = 'Ov23lieCjobNKY3uUz5Z'
const OAUTH_USER_AGENT = 'Vyotiq-Agent-V'
const FETCH_TIMEOUT_MS = 15_000
const MAX_TRANSIENT_POLL_FAILURES = 8

type DeviceCodeResponse = {
  device_code: string
  user_code: string
  verification_uri: string
  verification_uri_complete?: string
  expires_in: number
  interval: number
}

type TokenSuccess = {
  access_token: string
  token_type?: string
  scope?: string
}

type TokenPending = {
  error: 'authorization_pending' | 'slow_down' | 'expired_token' | 'access_denied' | string
  error_description?: string
  interval?: number
}

export type GithubAuthStatus = {
  ghAvailable: boolean
  /** True when Vyotiq has a token or `gh` is signed in to GitHub. */
  ghAuthenticated: boolean
  hasAppToken: boolean
  pending: boolean
  userCode: string | null
  verificationUri: string | null
  error: string | null
}

type PendingFlow = {
  clientId: string
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalMs: number
  expiresAt: number
  timer: ReturnType<typeof setTimeout> | null
  error: string | null
  consecutiveFailures: number
}

let pending: PendingFlow | null = null
const statusListeners = new Set<(status: GithubAuthStatus) => void>()

function ghCliEnv(): NodeJS.ProcessEnv {
  const token = resolveGhTokenForCli()
  return {
    ...sanitizedTerminalEnv(),
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    ...(token ? { GH_TOKEN: token } : {})
  }
}

function isAllowedGithubVerificationUrl(url: string): boolean {
  try {
    const uri = new URL(url)
    const host = uri.hostname.toLowerCase()
    return uri.protocol === 'https:' && (host === 'github.com' || host === 'www.github.com')
  } catch {
    return false
  }
}

async function openGithubVerificationUrl(url: string): Promise<void> {
  if (!isAllowedGithubVerificationUrl(url)) {
    throw new Error('GitHub verification URL must be https://github.com')
  }
  await shell.openExternal(url)
}

export function resolveGithubClientId(): string {
  return VYOTIQ_GITHUB_OAUTH_CLIENT_ID
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return n
  }
  return fallback
}

/** GitHub's token endpoint defaults to form-urlencoded even when JSON is requested. */
export function parseGithubOAuthBody(text: string, contentType = ''): Record<string, unknown> {
  const trimmed = text.trim()
  if (!trimmed) return {}
  const type = contentType.toLowerCase()
  const looksJson = trimmed.startsWith('{') || type.includes('application/json')
  if (looksJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      /* fall through to form parsing */
    }
  }
  const params = new URLSearchParams(trimmed)
  if (![...params.keys()].length && !trimmed.includes('=')) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of params.entries()) {
    if (key === 'expires_in' || key === 'interval') {
      out[key] = asPositiveNumber(value, 0)
    } else {
      out[key] = value
    }
  }
  return out
}

function clearPendingTimer(): void {
  if (pending?.timer) {
    clearTimeout(pending.timer)
    pending.timer = null
  }
}

export function cancelGithubAuth(): void {
  clearPendingTimer()
  pending = null
}

export function onGithubAuthStatus(fn: (status: GithubAuthStatus) => void): () => void {
  statusListeners.add(fn)
  return () => {
    statusListeners.delete(fn)
  }
}

async function emitGithubAuthStatus(): Promise<void> {
  const status = await githubAuthStatus()
  for (const fn of statusListeners) {
    try {
      fn(status)
    } catch {
      /* ignore listener errors */
    }
  }
}

async function ghAuthTokenAvailable(): Promise<boolean> {
  if (!(await ghAvailable())) return false
  const executable = await resolveGhExecutable()
  if (!executable) return false
  try {
    await execFile(executable, ['auth', 'token'], {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
      env: ghCliEnv()
    })
    return true
  } catch {
    return false
  }
}

function persistTokenToGhCli(token: string): Promise<boolean> {
  return (async () => {
    const executable = await resolveGhExecutable()
    if (!executable) return false
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        executable,
        ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--with-token'],
        {
          env: {
            ...sanitizedTerminalEnv(),
            GH_PROMPT_DISABLED: '1',
            GIT_TERMINAL_PROMPT: '0',
            GCM_INTERACTIVE: 'never'
          },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      )
      const timer = setTimeout(() => {
        child.kill()
        reject(new Error('gh auth login --with-token timed out'))
      }, 20_000)
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve()
        else reject(new Error(`gh auth login --with-token exited ${code ?? 'null'}`))
      })
      child.stdin?.write(token)
      child.stdin?.end()
    })
    await emitGithubAuthStatus()
    return true
  })().catch((err) => {
    logger.warn('Could not store token in GitHub CLI credential store', {
      scope: 'github-auth',
      err
    })
    return false
  })
}

/** Classic / fine-grained PAT and GitHub user OAuth tokens that `gh` accepts. */
export function isGithubCliUsableToken(token: string): boolean {
  return /^(ghp_|gho_|ghu_|ghs_|github_pat_)/.test(token.trim())
}

/**
 * After GitHub MCP OAuth or PAT: persist a gh-usable token, or start device flow
 * when Copilot MCP issued a token `gh` cannot use.
 */
export async function linkNativeGithubFromMcpToken(token: string): Promise<{
  linked: boolean
  startedDeviceFlow: boolean
}> {
  const trimmed = token.trim()
  if (isGithubCliUsableToken(trimmed)) {
    setGithubAccessToken(trimmed)
    await persistTokenToGhCli(trimmed)
    await emitGithubAuthStatus()
    return { linked: true, startedDeviceFlow: false }
  }
  const status = await githubAuthStatus()
  if (status.ghAuthenticated) {
    return { linked: true, startedDeviceFlow: false }
  }
  await startGithubAuth()
  return { linked: false, startedDeviceFlow: true }
}

export async function githubAuthStatus(): Promise<GithubAuthStatus> {
  const available = await ghAvailable()
  const flowPending = Boolean(pending && !pending.error)

  let hasAppToken = false
  let statusError = pending?.error ?? null
  try {
    hasAppToken = hasGithubAccessToken()
  } catch (err) {
    hasAppToken = false
    statusError = err instanceof Error ? err.message : String(err)
  }

  // Do not run `gh auth token` while a device flow is in flight — it can block
  // the IPC that Connect GitHub is waiting on.
  const ghCliLoggedIn = flowPending
    ? false
    : hasAppToken
      ? true
      : available
        ? await ghAuthTokenAvailable()
        : false

  return {
    ghAvailable: available,
    ghAuthenticated: hasAppToken || ghCliLoggedIn,
    hasAppToken,
    pending: flowPending,
    userCode: pending?.userCode ?? null,
    verificationUri: pending?.verificationUri ?? (flowPending ? GH_DEVICE_LOGIN_URL : null),
    error: statusError
  }
}

async function postForm(
  url: string,
  body: Record<string, string>
): Promise<Record<string, unknown>> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': OAUTH_USER_AGENT
      },
      body: new URLSearchParams(body).toString(),
      signal: ac.signal
    })
  } finally {
    clearTimeout(timer)
  }
  const text = await res.text()
  const json = parseGithubOAuthBody(text, res.headers.get('content-type') ?? '')
  if (!res.ok && typeof json.error !== 'string') {
    throw new Error(`GitHub OAuth HTTP ${res.status}`)
  }
  return json
}

function schedulePoll(): void {
  if (!pending) return
  clearPendingTimer()
  const wait = Math.max(pending.intervalMs, 1000)
  pending.timer = setTimeout(() => {
    void pollOnce()
  }, wait)
}

function failPending(message: string): void {
  if (!pending) return
  pending.error = message
  clearPendingTimer()
  void emitGithubAuthStatus()
}

async function completeWithAccessToken(accessToken: string): Promise<void> {
  setGithubAccessToken(accessToken)
  void persistTokenToGhCli(accessToken)
  cancelGithubAuth()
  logger.info('GitHub device OAuth succeeded', { scope: 'github-auth' })
  await emitGithubAuthStatus()
}

async function pollOnce(): Promise<void> {
  if (!pending) return
  if (Date.now() > pending.expiresAt) {
    failPending('Device code expired. Start Connect GitHub again.')
    return
  }
  const clientId = pending.clientId || resolveGithubClientId()

  const tokenBody: Record<string, string> = {
    client_id: clientId,
    device_code: pending.deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
  }

  try {
    const json = (await postForm(ACCESS_TOKEN_URL, tokenBody)) as TokenSuccess & TokenPending

    if (typeof json.access_token === 'string' && json.access_token) {
      await completeWithAccessToken(json.access_token)
      return
    }

    const err = typeof json.error === 'string' ? json.error : 'unknown'
    if (err === 'authorization_pending') {
      pending.consecutiveFailures = 0
      schedulePoll()
      void ghAuthTokenAvailable().then(async (signedIn) => {
        if (!signedIn || !pending) return
        cancelGithubAuth()
        logger.info('GitHub CLI already signed in; ending device wait', { scope: 'github-auth' })
        await emitGithubAuthStatus()
      })
      return
    }
    if (err === 'slow_down') {
      pending.consecutiveFailures = 0
      const bump =
        asPositiveNumber(json.interval, 0) > 0
          ? asPositiveNumber(json.interval, pending.intervalMs / 1000) * 1000
          : pending.intervalMs + 5000
      pending.intervalMs = bump
      schedulePoll()
      return
    }
    failPending(
      typeof json.error_description === 'string' && json.error_description
        ? json.error_description
        : `GitHub authorization failed (${err})`
    )
  } catch (err) {
    if (!pending) return
    pending.consecutiveFailures += 1
    const message = err instanceof Error ? err.message : String(err)
    logger.warn('GitHub device OAuth poll failed', { scope: 'github-auth', err })
    if (pending.consecutiveFailures >= MAX_TRANSIENT_POLL_FAILURES) {
      failPending(message)
      return
    }
    schedulePoll()
  }
}

export async function startGithubAuth(): Promise<GithubAuthStatus> {
  const clientId = resolveGithubClientId()

  cancelGithubAuth()

  logger.info('Starting GitHub device authorization', { scope: 'github-auth' })

  const json = (await postForm(DEVICE_CODE_URL, {
    client_id: clientId,
    scope: DEFAULT_SCOPE
  })) as Partial<DeviceCodeResponse> & { error?: string; error_description?: string }

  if (
    typeof json.device_code !== 'string' ||
    typeof json.user_code !== 'string' ||
    typeof json.verification_uri !== 'string'
  ) {
    throw new Error(
      typeof json.error_description === 'string'
        ? json.error_description
        : typeof json.error === 'string'
          ? json.error
          : 'Failed to start GitHub device authorization'
    )
  }

  const intervalSec = asPositiveNumber(json.interval, 5)
  const expiresIn = asPositiveNumber(json.expires_in, 900)

  const openUrl =
    typeof json.verification_uri_complete === 'string' && json.verification_uri_complete
      ? json.verification_uri_complete
      : json.verification_uri

  pending = {
    clientId,
    deviceCode: json.device_code,
    userCode: json.user_code,
    verificationUri: json.verification_uri,
    intervalMs: intervalSec * 1000,
    expiresAt: Date.now() + expiresIn * 1000,
    timer: null,
    error: null,
    consecutiveFailures: 0
  }

  try {
    await openGithubVerificationUrl(openUrl)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/verification URL must be https/i.test(message) || err instanceof TypeError) {
      cancelGithubAuth()
      throw err instanceof Error ? err : new Error('Invalid GitHub verification URL')
    }
    logger.warn('Failed to open GitHub verification URI', { scope: 'github-auth', err })
  }

  schedulePoll()
  const status = await githubAuthStatus()
  for (const fn of statusListeners) {
    try {
      fn(status)
    } catch {
      /* ignore */
    }
  }
  return status
}

export async function logoutGithubAuth(): Promise<GithubAuthStatus> {
  cancelGithubAuth()
  clearGithubAccessToken()
  if (await ghAvailable()) {
    const executable = await resolveGhExecutable()
    if (executable) {
      try {
        await execFile(executable, ['auth', 'logout', '--hostname', 'github.com'], {
          encoding: 'utf8',
          timeout: 15_000,
          windowsHide: true,
          env: ghCliEnv()
        })
      } catch (err) {
        logger.warn('gh auth logout failed', { scope: 'github-auth', err })
      }
    }
  }
  const status = await githubAuthStatus()
  for (const fn of statusListeners) {
    try {
      fn(status)
    } catch {
      /* ignore */
    }
  }
  return status
}

/** Configure Git's credential helper for the authenticated GitHub account. */
export async function setupGithubGitAuth(): Promise<void> {
  const executable = await resolveGhExecutable()
  if (!executable) throw new Error('GitHub CLI (gh) is not installed or not on PATH')
  try {
    await execFile(executable, ['auth', 'setup-git'], {
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
      env: ghCliEnv()
    })
  } catch (err) {
    logger.warn('gh auth setup-git failed', { scope: 'github-auth', err })
    throw new Error(
      'GitHub authentication could not be configured for Git pushes. Run `gh auth login` in a terminal (or add a token in Settings → GitHub), then retry.'
    )
  }
}

/** Use only the app-stored token for `gh` CLI; never fall back to ambient env. */
export function resolveGhTokenForCli(): string | undefined {
  try {
    return getGithubAccessToken() ?? undefined
  } catch (err) {
    logger.warn('GitHub token cannot be read from secure storage', {
      scope: 'github-auth',
      err
    })
    return undefined
  }
}

/** @internal */
export function resetGithubAuthForTests(): void {
  cancelGithubAuth()
  statusListeners.clear()
  resetGhBinaryCacheForTests()
}

/** @internal Drive pollOnce after injecting a pending flow (expiry / error paths). */
export async function pollGithubAuthForTests(): Promise<void> {
  await pollOnce()
}

/** @internal */
export function injectPendingGithubAuthForTests(overrides: {
  expiresAt?: number
  error?: string | null
  clientId?: string
  deviceCode?: string
}): void {
  pending = {
    clientId: overrides.clientId ?? VYOTIQ_GITHUB_OAUTH_CLIENT_ID,
    deviceCode: overrides.deviceCode ?? 'dev',
    userCode: 'ABCD-1234',
    verificationUri: 'https://github.com/login/device',
    intervalMs: 1000,
    expiresAt: overrides.expiresAt ?? Date.now() + 60_000,
    timer: null,
    error: overrides.error ?? null,
    consecutiveFailures: 0
  }
}
