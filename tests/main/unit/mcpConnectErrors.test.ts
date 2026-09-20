/**
 * What a user is told when a remote MCP server will not connect.
 *
 * The DeepWiki card read `Connect failed · fetch failed — Connect Timeout
 * Err…`: undici's wording, truncated mid-word, listing six IP addresses and
 * no hostname. It named no cause the user could act on and offered no control
 * — the card's button was permanently disabled. These cover the half of that
 * fix that lives in main: naming the failure, and deciding whether another
 * attempt is worth making.
 */
import { describe, expect, it } from 'vitest'
import {
  classifyMcpConnectError,
  describeMcpConnectError,
  isRetriableMcpConnectError
} from '@main/agent/mcp/connectErrors'

const DEEPWIKI = { name: 'DeepWiki', url: 'https://mcp.deepwiki.com/mcp' }

/** The real shape: `fetch failed` outside, the reason on `cause`. */
function fetchFailed(causeMessage: string, code?: string): Error {
  const cause = new Error(causeMessage)
  if (code) (cause as Error & { code?: string }).code = code
  const err = new Error('fetch failed')
  ;(err as Error & { cause?: unknown }).cause = cause
  return err
}

const CONNECT_TIMEOUT =
  'Connect Timeout Error (attempted addresses: 44.236.210.131:443, ' +
  '2600:1f14:36ec:d01::ebaf:443, 184.33.103.39:443, timeout: 10000ms)'

describe('describeMcpConnectError', () => {
  it('replaces undici connect-timeout noise with the host and a next step', () => {
    const message = describeMcpConnectError(
      fetchFailed(CONNECT_TIMEOUT, 'UND_ERR_CONNECT_TIMEOUT'),
      DEEPWIKI
    )
    expect(message).toBe(
      'Timed out reaching mcp.deepwiki.com — check your network or proxy, then retry.'
    )
    // The things that made the original unreadable.
    expect(message).not.toMatch(/fetch failed|attempted addresses|\d+\.\d+\.\d+\.\d+|10000ms/)
  })

  it('names DNS failure as DNS rather than as a generic fetch failure', () => {
    expect(
      describeMcpConnectError(fetchFailed('getaddrinfo ENOTFOUND x', 'ENOTFOUND'), DEEPWIKI)
    ).toBe('Could not find mcp.deepwiki.com — check the URL and your DNS, then retry.')
  })

  it('distinguishes a refused connection from an unreachable network', () => {
    expect(
      describeMcpConnectError(fetchFailed('connect ECONNREFUSED', 'ECONNREFUSED'), DEEPWIKI)
    ).toMatch(/^mcp\.deepwiki\.com refused the connection/)
    expect(
      describeMcpConnectError(fetchFailed('connect EHOSTUNREACH', 'EHOSTUNREACH'), DEEPWIKI)
    ).toMatch(/^No route to mcp\.deepwiki\.com/)
  })

  it('calls out an intercepting proxy when TLS is the problem', () => {
    const err = fetchFailed('unable to verify the first certificate')
    expect(describeMcpConnectError(err, DEEPWIKI)).toMatch(/proxy may be intercepting HTTPS/)
  })

  it('still says something useful when there is no cause to read', () => {
    expect(describeMcpConnectError(new Error('fetch failed'), DEEPWIKI)).toBe(
      'Could not reach mcp.deepwiki.com — check your network, then retry.'
    )
  })

  it('falls back to the server-less wording when the url is unusable', () => {
    expect(describeMcpConnectError(new Error('fetch failed'), { name: 'X', url: 'not a url' })).toBe(
      'Could not reach the server — check your network, then retry.'
    )
  })

  it('leaves messages that are already actionable alone', () => {
    // Rewriting these would both lose detail and fight the tests elsewhere
    // that assert on their exact text.
    for (const message of [
      'Sign in required',
      'uvx was not found on PATH',
      'GitHub cannot register this app automatically. Add its OAuth client ID and secret, then connect again.'
    ]) {
      expect(describeMcpConnectError(new Error(message), DEEPWIKI)).toBe(message)
    }
  })
})

describe('isRetriableMcpConnectError', () => {
  it('retries failures that prove the request never arrived', () => {
    const transient: Array<[string, string | undefined]> = [
      [CONNECT_TIMEOUT, 'UND_ERR_CONNECT_TIMEOUT'],
      ['getaddrinfo EAI_AGAIN', 'EAI_AGAIN'],
      ['read ECONNRESET', 'ECONNRESET'],
      ['socket hang up', undefined]
    ]
    for (const [message, code] of transient) {
      expect(isRetriableMcpConnectError(fetchFailed(message, code)), message).toBe(true)
    }
  })

  it('does not retry what a second attempt cannot change', () => {
    // A rejected credential, a missing binary and a wrong workspace all fail
    // identically next time; retrying only delays telling the user.
    for (const message of [
      'Sign in required',
      'HTTP 401 Unauthorized',
      'uvx was not found on PATH',
      'This MCP server needs a Git repository'
    ]) {
      expect(isRetriableMcpConnectError(new Error(message)), message).toBe(false)
    }
  })

  it('does not retry a deliberate abort', () => {
    const err = new Error('The operation was aborted')
    err.name = 'AbortError'
    expect(isRetriableMcpConnectError(err)).toBe(false)
  })

  it('reads a code buried two causes deep', () => {
    const inner = new Error('connect ETIMEDOUT')
    ;(inner as Error & { code?: string }).code = 'ETIMEDOUT'
    const middle = new Error('fetch failed')
    ;(middle as Error & { cause?: unknown }).cause = inner
    const outer = new Error('SSE error')
    ;(outer as Error & { cause?: unknown }).cause = middle
    expect(isRetriableMcpConnectError(outer)).toBe(true)
  })
})

describe('classifyMcpConnectError', () => {
  it('picks the control the card should offer', () => {
    expect(classifyMcpConnectError(new Error('Sign in required'))).toBe('sign-in')
    expect(classifyMcpConnectError(new Error('HTTP 403 Forbidden'))).toBe('sign-in')
    expect(classifyMcpConnectError(new Error('uvx was not found on PATH'))).toBe('binary')
    expect(classifyMcpConnectError(fetchFailed(CONNECT_TIMEOUT, 'UND_ERR_CONNECT_TIMEOUT'))).toBe(
      'network'
    )
  })

  /**
   * Status crosses IPC as a string, so by the time the renderer asks "is this
   * retriable?" the original error object is gone and `classify` is reading
   * the sentence `describe` wrote. If the two drift, a network failure loses
   * its Retry button silently — nothing else would fail.
   */
  it('classifies its own descriptions the same way it classified the error', () => {
    const cases: Array<[unknown, string]> = [
      [fetchFailed(CONNECT_TIMEOUT, 'UND_ERR_CONNECT_TIMEOUT'), 'network'],
      [fetchFailed('getaddrinfo ENOTFOUND x', 'ENOTFOUND'), 'network'],
      [fetchFailed('connect ECONNREFUSED', 'ECONNREFUSED'), 'network'],
      [fetchFailed('connect EHOSTUNREACH', 'EHOSTUNREACH'), 'network'],
      [fetchFailed('read ECONNRESET', 'ECONNRESET'), 'network'],
      [fetchFailed('unable to verify the first certificate'), 'network'],
      [new Error('fetch failed'), 'network'],
      [new Error('Sign in required'), 'sign-in'],
      [new Error('uvx was not found on PATH'), 'binary']
    ]
    for (const [err, expected] of cases) {
      const described = describeMcpConnectError(err, DEEPWIKI)
      expect(classifyMcpConnectError(err), String(err)).toBe(expected)
      expect(classifyMcpConnectError(described), described).toBe(expected)
    }
  })
})
