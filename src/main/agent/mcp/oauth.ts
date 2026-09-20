import { createServer, type Server } from 'http'
import { randomBytes, timingSafeEqual } from 'crypto'
import { shell } from 'electron'
import { VYOTIQ_MARK_PATHS, VYOTIQ_MARK_VIEW_BOX } from '../../../shared/brand/vyotiqMark'
import type {
  OAuthClientProvider,
  OAuthDiscoveryState
} from '@modelcontextprotocol/sdk/client/auth.js'
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens
} from '@modelcontextprotocol/sdk/shared/auth.js'
import {
  GMAIL_MCP_ID,
  GOOGLE_ACCESS_READ,
  GOOGLE_CALENDAR_MCP_ID,
  GOOGLE_DRIVE_MCP_ID,
  MCP_OAUTH_CALLBACK_PATH,
  isGoogleMcpId,
  mcpOAuthCallbackUrl,
  mcpOAuthFixedPortBusyMessage,
  type GoogleMcpAccess,
  type GoogleMcpId
} from '../../../shared/mcpApps'
import {
  clearMcpOAuthState,
  getMcpOAuthState,
  patchMcpOAuthState,
  setMcpOAuthState,
  type McpOAuthStoredState
} from '../../settings/secrets'
import type { McpOAuthStaticClient } from './oauthStaticClient'
import { logger } from '../../../shared/logger'

const CALLBACK_TIMEOUT_MS = 5 * 60_000

type PendingAuth = {
  resolve: (code: string) => void
  reject: (err: Error) => void
  server: Server
  timer: ReturnType<typeof setTimeout>
}

const pendingByServerId = new Map<string, PendingAuth>()

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/*
 * Drawn inline rather than linked: this page is served from a throwaway
 * localhost origin with no asset route, and the mark has to follow
 * currentColor so it works on either colour scheme. The geometry is generated
 * — this file used to carry its own snapshot of it, at a hexagon radius that
 * matched neither the kit nor the in-app component.
 */
const MARK_SVG =
  `<svg viewBox="${VYOTIQ_MARK_VIEW_BOX}" width="40" height="40" aria-hidden="true">` +
  VYOTIQ_MARK_PATHS.map((d) => `<path fill="currentColor" d="${d}"/>`).join('') +
  '</svg>'

function htmlPage(title: string, body: string): string {
  const safeTitle = escapeHtml(title)
  const safeBody = escapeHtml(body)
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${safeTitle} · Vyotiq</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: system-ui, sans-serif;
      background: #000;
      color: #fff;
    }
    main { text-align: center; padding: 2rem; max-width: 28rem; }
    .mark { color: #fff; margin: 0 auto 1.25rem; }
    h1 { font-size: 1.15rem; font-weight: 500; letter-spacing: 0.04em; margin: 0 0 0.5rem; }
    p { margin: 0; color: #a3a3a3; line-height: 1.45; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${MARK_SVG}</div>
    <h1>${safeTitle}</h1>
    <p>${safeBody}</p>
  </main>
</body>
</html>`
}

/**
 * Start a one-shot localhost HTTP server to receive the OAuth redirect.
 * Random port when `fixedPort` is omitted (GitHub DCR). Fixed port when static
 * client credentials are present — no silent fallback if that port is taken.
 */
export async function beginMcpOAuthCallback(
  serverId: string,
  opts?: { fixedPort?: number }
): Promise<{
  redirectUrl: string
  waitForCode: () => Promise<string>
}> {
  cancelMcpOAuthCallback(serverId, new Error('OAuth callback superseded'))

  const requestedPort = opts?.fixedPort
  const server = createServer()
  const listenPort = await new Promise<number>((resolve, reject) => {
    server.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code
      if (requestedPort != null && code === 'EADDRINUSE') {
        reject(new Error(mcpOAuthFixedPortBusyMessage(requestedPort)))
        return
      }
      reject(err)
    })
    server.listen(requestedPort ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OAuth callback server'))
        return
      }
      resolve(addr.port)
    })
  })

  const redirectUrl = mcpOAuthCallbackUrl(listenPort)

  let settleCode: ((code: string) => void) | null = null
  let settleErr: ((err: Error) => void) | null = null
  const codePromise = new Promise<string>((resolve, reject) => {
    settleCode = resolve
    settleErr = reject
  })
  // Several paths cancel a flow before anyone awaits `waitForCode()` — a
  // connect that fails first, a non-interactive retry, a superseded attempt.
  // An unobserved rejection in the main process is noisy at best and fatal
  // under strict unhandled-rejection modes, so mark it handled up front; the
  // real caller still sees the rejection through `waitForCode()`.
  void codePromise.catch(() => undefined)

  const timer = setTimeout(() => {
    cancelMcpOAuthCallback(serverId, new Error('OAuth callback timed out'))
  }, CALLBACK_TIMEOUT_MS)

  const pending: PendingAuth = {
    resolve: (code) => settleCode?.(code),
    reject: (err) => settleErr?.(err),
    server,
    timer
  }
  pendingByServerId.set(serverId, pending)

  server.on('request', (req, res) => {
    try {
      const remote = req.socket.remoteAddress
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Forbidden', 'OAuth callback must come from localhost.'))
        return
      }
      const url = new URL(req.url ?? '/', redirectUrl)
      if (url.pathname !== MCP_OAUTH_CALLBACK_PATH) {
        res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Not found', 'Unexpected path.'))
        return
      }
      const err = url.searchParams.get('error')
      const desc = url.searchParams.get('error_description')
      if (err) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Authorization failed', desc || err))
        cancelMcpOAuthCallback(serverId, new Error(desc || err))
        return
      }
      const code = url.searchParams.get('code')
      if (!code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(htmlPage('Authorization failed', 'Missing authorization code.'))
        cancelMcpOAuthCallback(serverId, new Error('Missing authorization code'))
        return
      }
      // The redirect lands on a fixed loopback port that any local process or
      // web page can reach, so a bare `code` proves nothing: without this, an
      // attacker could drop their own authorization code here and bind the
      // user's client to the attacker's account. PKCE does not cover that.
      if (!consumeMcpOAuthState(serverId, url.searchParams.get('state'))) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(
          htmlPage(
            'Authorization failed',
            'This response did not match the sign-in Vyotiq started. Try Sign in again.'
          )
        )
        logger.warn('Rejected MCP OAuth callback with a bad state parameter', {
          scope: 'mcp',
          serverId
        })
        cancelMcpOAuthCallback(serverId, new Error('OAuth state mismatch'))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(htmlPage('Connected', 'You can close this window and return to Vyotiq.'))
      clearTimeout(timer)
      pendingByServerId.delete(serverId)
      try {
        server.close()
      } catch {
        // ignore
      }
      pending.resolve(code)
    } catch (e) {
      cancelMcpOAuthCallback(
        serverId,
        e instanceof Error ? e : new Error('OAuth callback error')
      )
    }
  })

  return {
    redirectUrl,
    waitForCode: () => codePromise
  }
}

export function cancelMcpOAuthCallback(serverId: string, err?: Error): void {
  const pending = pendingByServerId.get(serverId)
  if (!pending) return
  pendingByServerId.delete(serverId)
  clearTimeout(pending.timer)
  try {
    pending.server.close()
  } catch {
    // ignore
  }
  if (err) pending.reject(err)
}

/**
 * Compare without leaking how much of the value matched.
 * Different lengths are a mismatch, which `timingSafeEqual` would throw on.
 */
function statesMatch(expected: string, received: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(received, 'utf8')
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Check the `state` on a redirect against the one we issued, and burn it so the
 * same response cannot be replayed. Returns false when nothing was issued —
 * every flow we start stores one first, so an absent value means this callback
 * did not come from us.
 */
export function consumeMcpOAuthState(serverId: string, received: string | null): boolean {
  const stored = getMcpOAuthState(serverId)
  const expected = stored?.oauthState
  if (!expected || !received) return false
  const next = { ...stored }
  delete next.oauthState
  setMcpOAuthState(serverId, next)
  return statesMatch(expected, received)
}

export type VyotiqMcpOAuthProvider = OAuthClientProvider & {
  readonly serverId: string
  readonly redirectUrl: string
}

export type { McpOAuthStaticClient } from './oauthStaticClient'

/** Documented Gmail/Drive/Calendar MCP consent scopes (Google Workspace MCP servers). */
const GOOGLE_MCP_READ_SCOPES: Record<GoogleMcpId, readonly string[]> = {
  [GMAIL_MCP_ID]: ['https://www.googleapis.com/auth/gmail.readonly'],
  [GOOGLE_DRIVE_MCP_ID]: ['https://www.googleapis.com/auth/drive.readonly'],
  [GOOGLE_CALENDAR_MCP_ID]: [
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
    'https://www.googleapis.com/auth/calendar.events.freebusy',
    'https://www.googleapis.com/auth/calendar.events.readonly'
  ]
}

const GOOGLE_MCP_WRITE_SCOPES: Record<GoogleMcpId, readonly string[]> = {
  [GMAIL_MCP_ID]: ['https://www.googleapis.com/auth/gmail.compose'],
  [GOOGLE_DRIVE_MCP_ID]: ['https://www.googleapis.com/auth/drive.file'],
  [GOOGLE_CALENDAR_MCP_ID]: ['https://www.googleapis.com/auth/calendar.events']
}

/** Space-separated OAuth `scope` for Google MCP, or undefined for non-Google servers. */
export function googleMcpOAuthScope(
  serverId: string,
  googleAccess?: GoogleMcpAccess | null
): string | undefined {
  if (!isGoogleMcpId(serverId)) return undefined
  const read = GOOGLE_MCP_READ_SCOPES[serverId]
  const write =
    googleAccess === GOOGLE_ACCESS_READ ? [] : GOOGLE_MCP_WRITE_SCOPES[serverId]
  return [...read, ...write].join(' ')
}

/**
 * MCP SDK OAuthClientProvider backed by Electron safeStorage.
 * Uses a localhost redirect URL for the Authorization Code + PKCE flow.
 * When `staticClient` is set, `clientInformation()` returns it and DCR is skipped.
 * Google MCP sets `clientMetadata.scope` from `googleAccess` (readonly vs full MCP scopes).
 */
export function createMcpOAuthProvider(
  serverId: string,
  redirectUrl: string,
  opts?: { staticClient?: McpOAuthStaticClient; googleAccess?: GoogleMcpAccess }
): VyotiqMcpOAuthProvider {
  const read = (): McpOAuthStoredState => getMcpOAuthState(serverId) ?? {}
  const staticClient = opts?.staticClient
  const confidential = Boolean(staticClient?.client_secret)
  const scope = googleMcpOAuthScope(serverId, opts?.googleAccess)

  return {
    serverId,
    get redirectUrl() {
      return redirectUrl
    },
    get clientMetadata(): OAuthClientMetadata {
      return {
        client_name: 'Vyotiq',
        redirect_uris: [redirectUrl],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: confidential ? 'client_secret_post' : 'none',
        ...(scope ? { scope } : {})
      }
    },
    clientInformation(): OAuthClientInformationMixed | undefined {
      if (staticClient) {
        return {
          client_id: staticClient.client_id,
          ...(staticClient.client_secret ? { client_secret: staticClient.client_secret } : {})
        } as OAuthClientInformationMixed
      }
      const info = read().clientInformation
      return info as OAuthClientInformationMixed | undefined
    },
    saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
      patchMcpOAuthState(serverId, {
        clientInformation: clientInformation as Record<string, unknown>
      })
    },
    tokens(): OAuthTokens | undefined {
      const tokens = read().tokens
      if (!tokens?.access_token) return undefined
      return tokens as OAuthTokens
    },
    saveTokens(tokens: OAuthTokens): void {
      patchMcpOAuthState(serverId, { tokens: tokens as McpOAuthStoredState['tokens'] })
    },
    async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
      logger.info('Opening MCP OAuth authorization URL', {
        scope: 'mcp',
        serverId,
        host: authorizationUrl.host
      })
      if (authorizationUrl.protocol !== 'https:') {
        throw new Error('MCP OAuth authorization URL must be https')
      }
      await shell.openExternal(authorizationUrl.toString())
    },
    /**
     * The SDK only sends `state` when the provider supplies one. Storing it
     * here is what lets the loopback callback tell our own redirect apart from
     * a code someone else pushed at the fixed port.
     */
    state(): string {
      const value = randomBytes(32).toString('base64url')
      patchMcpOAuthState(serverId, { oauthState: value })
      return value
    },
    saveCodeVerifier(codeVerifier: string): void {
      patchMcpOAuthState(serverId, { codeVerifier })
    },
    codeVerifier(): string {
      const v = read().codeVerifier
      if (!v) throw new Error('Missing PKCE code verifier for MCP OAuth')
      return v
    },
    saveDiscoveryState(state): void {
      patchMcpOAuthState(serverId, {
        discoveryState: state as unknown as Record<string, unknown>
      })
    },
    discoveryState(): OAuthDiscoveryState | undefined {
      const state = read().discoveryState
      if (!state) return undefined
      return state as unknown as OAuthDiscoveryState
    },
    async invalidateCredentials(scope): Promise<void> {
      if (scope === 'all') {
        clearMcpOAuthState(serverId)
        return
      }
      const prev = { ...read() }
      if (scope === 'tokens') {
        delete prev.tokens
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'verifier') {
        delete prev.codeVerifier
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'client') {
        delete prev.clientInformation
        setMcpOAuthState(serverId, prev)
        return
      }
      if (scope === 'discovery') {
        delete prev.discoveryState
        setMcpOAuthState(serverId, prev)
        return
      }
      const _exhaustive: never = scope
      void _exhaustive
    }
  }
}
