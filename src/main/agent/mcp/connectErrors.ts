/**
 * Turning a failed MCP connect into something a user can act on.
 *
 * The SDK hands us whatever the runtime threw. For a remote server that is
 * usually undici's `fetch failed`, whose real cause hides one or two `cause`
 * levels down and reads like
 * `Connect Timeout Error (attempted addresses: 44.236.210.131:443, …, timeout: 10000ms)`.
 * Shown verbatim in a card that string is both frightening and useless: it
 * names six IP addresses, no hostname, and no next step.
 *
 * Two questions matter at the call site, so they are the two exports:
 * `isRetriableMcpConnectError` (is another attempt worth making?) and
 * `describeMcpConnectError` (what do we tell the user?).
 */
import { isMcpMissingBinaryError, isMcpSignInRequiredError } from './errorKinds'
import { isGitMcpNotARepoError } from './uvxCompat'

/**
 * What went wrong, in the terms the UI cares about: which control to offer.
 * `sign-in` gets a Sign in button, `network` a Retry, `binary` Install/Locate.
 * Retrying the others on the user's behalf only wastes their time.
 */
export type McpConnectErrorKind = 'sign-in' | 'network' | 'binary' | 'workspace' | 'config'

/** Node/undici error codes that mean the request never reached the server. */
const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_SOCKET'
])

const TRANSIENT_TEXT =
  /connect timeout|headers timeout|socket hang up|other side closed|network|temporarily unavailable|fetch failed/i

/** Walk the `cause` chain — undici buries the real reason two levels down. */
function* errorChain(err: unknown): Generator<Record<string, unknown>> {
  const seen = new Set<unknown>()
  let current: unknown = err
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current)
    yield current as Record<string, unknown>
    current = (current as { cause?: unknown }).cause
  }
}

/** Every message in the chain, outermost first, so a buried cause still matches. */
function messages(err: unknown): string[] {
  const out: string[] = []
  for (const link of errorChain(err)) {
    const message = link.message
    if (typeof message === 'string' && message) out.push(message)
  }
  if (out.length === 0 && err != null) out.push(String(err))
  return out
}

function codes(err: unknown): string[] {
  const out: string[] = []
  for (const link of errorChain(err)) {
    const code = link.code
    if (typeof code === 'string' && code) out.push(code)
  }
  return out
}

/**
 * Is another attempt worth making?
 *
 * Only for failures that prove the request never got a reply: DNS, TCP connect,
 * a dropped socket. A 4xx, a bad config or a missing binary will fail exactly
 * the same way the second time, and an aborted connect was deliberate.
 */
export function isRetriableMcpConnectError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return false
  const text = messages(err).join(' | ')
  if (isMcpSignInRequiredError(text) || isMcpMissingBinaryError(text)) return false
  if (isGitMcpNotARepoError(text)) return false
  if (/\b(401|403|unauthorized|forbidden|invalid_token)\b/i.test(text)) return false
  if (codes(err).some((code) => TRANSIENT_CODES.has(code))) return true
  return TRANSIENT_TEXT.test(text)
}

/** Hostname alone — the IP list undici prints is noise to everyone but us. */
function hostOf(url: string | undefined): string {
  const raw = (url ?? '').trim()
  if (!raw) return ''
  try {
    return new URL(raw).host
  } catch {
    return ''
  }
}

/**
 * The openings `describeMcpConnectError` writes for a network failure.
 *
 * `classifyMcpConnectError` runs against a stored string as well as a live
 * error — the status IPC only keeps the message — so it has to recognise this
 * module's own output. The round-trip test in `mcpConnectErrors.test.ts` feeds
 * every described failure back through `classify` so the two cannot drift.
 */
const FRIENDLY_NETWORK =
  /^(Timed out reaching|Could not reach|Could not find|No route to) |refused the connection|closed the connection|did not respond in time/

export function classifyMcpConnectError(err: unknown): McpConnectErrorKind {
  const text = messages(err).join(' | ')
  if (isMcpSignInRequiredError(text)) return 'sign-in'
  if (isMcpMissingBinaryError(text)) return 'binary'
  if (isGitMcpNotARepoError(text)) return 'workspace'
  if (/\b(401|403|unauthorized|forbidden|invalid_token)\b/i.test(text)) return 'sign-in'
  if (isRetriableMcpConnectError(err)) return 'network'
  if (FRIENDLY_NETWORK.test(text.trim())) return 'network'
  if (/TLS certificate rejected/i.test(text)) return 'network'
  const errorCodes = codes(err)
  if (errorCodes.includes('ENOENT') || /spawn |is not recognized/i.test(text)) return 'binary'
  return 'config'
}

/**
 * One sentence: what failed, and what the user can do about it.
 *
 * Messages we already wrote (missing binary, not a Git repo, sign in required,
 * the "register an OAuth app" text) pass through untouched — they are the
 * actionable version already, and rewording them here would fight the tests
 * that assert on them elsewhere.
 */
export function describeMcpConnectError(
  err: unknown,
  server: { name?: string; url?: string | null }
): string {
  const chain = messages(err)
  const text = chain.join(' | ')
  const first = chain[0] ?? 'MCP connection failed'
  if (
    isMcpSignInRequiredError(text) ||
    isMcpMissingBinaryError(text) ||
    isGitMcpNotARepoError(text) ||
    /cannot register this app automatically/i.test(text)
  ) {
    return first
  }

  const host = hostOf(server.url ?? undefined)
  const where = host ? ` ${host}` : ''
  const errorCodes = codes(err)
  const has = (...needles: string[]): boolean =>
    needles.some((n) => errorCodes.includes(n)) ||
    needles.some((n) => new RegExp(n.replace(/_/g, '[ _]'), 'i').test(text))

  if (has('ENOTFOUND', 'EAI_AGAIN')) {
    return `Could not find${where || ' the server'} — check the URL and your DNS, then retry.`
  }
  if (has('ECONNREFUSED')) {
    return `${host || 'The server'} refused the connection — check the URL and port, then retry.`
  }
  if (has('UND_ERR_CONNECT_TIMEOUT') || /connect timeout/i.test(text)) {
    return `Timed out reaching${where || ' the server'} — check your network or proxy, then retry.`
  }
  if (has('EHOSTUNREACH', 'ENETUNREACH')) {
    return `No route to${where || ' the server'} — check your network or VPN, then retry.`
  }
  if (/certificate|self.signed|CERT_|unable to verify/i.test(text)) {
    return `TLS certificate rejected for${where || ' the server'} — a proxy may be intercepting HTTPS.`
  }
  if (has('ECONNRESET', 'EPIPE') || /socket hang up|other side closed/i.test(text)) {
    return `${host || 'The server'} closed the connection — retry in a moment.`
  }
  if (/headers timeout|timed out/i.test(text)) {
    return `${host || 'The server'} did not respond in time — retry in a moment.`
  }
  // Bare `fetch failed` with no usable cause still beats showing those words.
  if (/^fetch failed$/i.test(first.trim())) {
    return `Could not reach${where || ' the server'} — check your network, then retry.`
  }
  return first
}
