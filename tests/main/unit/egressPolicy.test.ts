import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  MAX_EGRESS_LEDGER_ENTRIES,
  checkEgress,
  currentEgressSeq,
  clearEgressLedger,
  egressLedgerSize,
  evaluateEgress,
  hostAllowedByAllowlist,
  listEgress,
  onEgressRecorded
} from '@main/net/egress'

const ALLOWLIST = ['example.com', '*.allowed.dev']

describe('egress policy', () => {
  it('hostAllowedByAllowlist matches exact and wildcard suffix hosts', () => {
    expect(hostAllowedByAllowlist('example.com', ALLOWLIST)).toBe(true)
    expect(hostAllowedByAllowlist('api.allowed.dev', ALLOWLIST)).toBe(true)
    expect(hostAllowedByAllowlist('allowed.dev', ALLOWLIST)).toBe(true)
    expect(hostAllowedByAllowlist('evil.com', ALLOWLIST)).toBe(false)
    // Empty allowlist means no extra host filter.
    expect(hostAllowedByAllowlist('evil.com', [])).toBe(true)
  })

  it('allows an allowlisted host and refuses one that is not listed', () => {
    expect(
      evaluateEgress({ url: 'https://example.com/a', purpose: 'browser_navigation', allowlist: ALLOWLIST })
    ).toEqual({ allowed: true, reason: 'allowed' })

    const denied = evaluateEgress({
      url: 'https://evil.com/a',
      purpose: 'browser_navigation',
      allowlist: ALLOWLIST
    })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('not_in_allowlist')
  })

  it('refuses private hosts unless allowLocal is set', () => {
    const strict = evaluateEgress({ url: 'http://127.0.0.1:8080/', purpose: 'browser_navigation' })
    expect(strict.allowed).toBe(false)
    expect(strict.reason).toBe('blocked_host')

    expect(
      evaluateEgress({ url: 'http://127.0.0.1:8080/', purpose: 'browser_navigation', allowLocal: true })
    ).toEqual({ allowed: true, reason: 'allowed' })
  })

  /**
   * The gap this module was written to close: before it, the allowlist was
   * enforced on navigation only, so a page on an allowed host could fetch or
   * POST anywhere.
   */
  it('applies the allowlist to page subresources, not just navigation', () => {
    const denied = evaluateEgress({
      url: 'https://evil.com/collect',
      purpose: 'browser_subresource',
      method: 'POST',
      resourceType: 'xhr',
      allowlist: ALLOWLIST
    })
    expect(denied.allowed).toBe(false)
    expect(denied.reason).toBe('not_in_allowlist')

    expect(
      evaluateEgress({
        url: 'https://api.allowed.dev/v1/items',
        purpose: 'browser_subresource',
        resourceType: 'xhr',
        allowlist: ALLOWLIST
      })
    ).toEqual({ allowed: true, reason: 'allowed' })
  })

  it('lets subresources use non-network schemes while navigation still refuses them', () => {
    for (const url of ['about:blank', 'data:text/plain,hello', 'blob:https://example.com/x']) {
      expect(evaluateEgress({ url, purpose: 'browser_subresource', allowlist: ALLOWLIST })).toEqual({
        allowed: true,
        reason: 'non_network_scheme'
      })
      const nav = evaluateEgress({ url, purpose: 'browser_navigation', allowlist: ALLOWLIST })
      expect(nav.allowed).toBe(false)
      expect(nav.reason).toBe('scheme')
    }
  })

  it('judges WebSocket subresources on their host instead of refusing them outright', () => {
    expect(
      evaluateEgress({
        url: 'wss://api.allowed.dev/socket',
        purpose: 'browser_subresource',
        resourceType: 'webSocket',
        allowlist: ALLOWLIST
      })
    ).toEqual({ allowed: true, reason: 'allowed' })

    const offList = evaluateEgress({
      url: 'wss://evil.com/socket',
      purpose: 'browser_subresource',
      resourceType: 'webSocket',
      allowlist: ALLOWLIST
    })
    expect(offList.allowed).toBe(false)
    expect(offList.reason).toBe('not_in_allowlist')

    const loopback = evaluateEgress({
      url: 'ws://127.0.0.1:9000/socket',
      purpose: 'browser_subresource',
      resourceType: 'webSocket'
    })
    expect(loopback.allowed).toBe(false)
    expect(loopback.reason).toBe('blocked_host')
  })

  it('keeps navigation strict about WebSocket schemes', () => {
    const nav = evaluateEgress({ url: 'wss://example.com/socket', purpose: 'browser_navigation' })
    expect(nav.allowed).toBe(false)
    expect(nav.reason).toBe('blocked_host')
  })

  it('refuses a URL that does not parse', () => {
    const decision = evaluateEgress({ url: 'not a url', purpose: 'mcp_remote' })
    expect(decision.allowed).toBe(false)
    expect(decision.reason).toBe('unparseable')
  })
})

describe('egress ledger', () => {
  beforeEach(() => {
    clearEgressLedger()
  })

  afterEach(() => {
    clearEgressLedger()
  })

  it('records scheme and host only, never the path or query', () => {
    checkEgress({
      url: 'https://example.com/callback?access_token=SUPERSECRET',
      purpose: 'browser_subresource',
      method: 'post',
      runId: 'run-1',
      workspacePath: '/ws',
      resourceType: 'xhr'
    })

    const [entry] = listEgress()
    expect(entry.origin).toBe('https://example.com')
    expect(entry.method).toBe('POST')
    expect(entry.allowed).toBe(true)
    expect(entry.runId).toBe('run-1')
    expect(entry.workspacePath).toBe('/ws')
    expect(entry.resourceType).toBe('xhr')
    expect(JSON.stringify(entry)).not.toContain('SUPERSECRET')
    expect(JSON.stringify(entry)).not.toContain('/callback')
  })

  it('filters by run, purpose and refusal', () => {
    checkEgress({ url: 'https://example.com/a', purpose: 'mcp_remote', runId: 'run-1' })
    checkEgress({ url: 'https://other.com/b', purpose: 'browser_subresource', runId: 'run-2' })
    checkEgress({
      url: 'https://evil.com/c',
      purpose: 'browser_subresource',
      runId: 'run-2',
      allowlist: ALLOWLIST
    })

    expect(listEgress({ runId: 'run-1' })).toHaveLength(1)
    expect(listEgress({ runId: 'run-2' })).toHaveLength(2)
    expect(listEgress({ purpose: 'mcp_remote' })).toHaveLength(1)

    const denied = listEgress({ deniedOnly: true })
    expect(denied).toHaveLength(1)
    expect(denied[0].origin).toBe('https://evil.com')
    expect(denied[0].reason).toBe('not_in_allowlist')
  })

  it('drops the oldest entries once the cap is reached', () => {
    const overflow = 10
    for (let i = 0; i < MAX_EGRESS_LEDGER_ENTRIES + overflow; i += 1) {
      checkEgress({ url: `https://host-${i}.example/`, purpose: 'mcp_remote' })
    }

    expect(egressLedgerSize()).toBe(MAX_EGRESS_LEDGER_ENTRIES)
    const entries = listEgress()
    expect(entries[0].origin).toBe(`https://host-${overflow}.example`)
    expect(entries[entries.length - 1].origin).toBe(
      `https://host-${MAX_EGRESS_LEDGER_ENTRIES + overflow - 1}.example`
    )
  })

  it('clearEgressLedger empties the ledger', () => {
    checkEgress({ url: 'https://example.com/a', purpose: 'mcp_remote' })
    expect(egressLedgerSize()).toBe(1)
    clearEgressLedger()
    expect(egressLedgerSize()).toBe(0)
    expect(listEgress()).toEqual([])
  })
})

describe('egress observers', () => {
  beforeEach(() => {
    clearEgressLedger()
  })

  afterEach(() => {
    clearEgressLedger()
  })

  it('hands every recorded decision to a listener, and stops on unsubscribe', () => {
    const seen: string[] = []
    const stop = onEgressRecorded((recorded) => seen.push(recorded.origin))

    checkEgress({ url: 'https://one.example/a', purpose: 'mcp_remote' })
    checkEgress({ url: 'https://two.example/b', purpose: 'mcp_remote' })
    stop()
    checkEgress({ url: 'https://three.example/c', purpose: 'mcp_remote' })

    expect(seen).toEqual(['https://one.example', 'https://two.example'])
  })

  it('a failing observer cannot break the request it is observing', () => {
    const stop = onEgressRecorded(() => {
      throw new Error('observer blew up')
    })
    const seen: string[] = []
    const stopSecond = onEgressRecorded((recorded) => seen.push(recorded.origin))

    expect(() =>
      checkEgress({ url: 'https://example.com/a', purpose: 'browser_subresource' })
    ).not.toThrow()
    // The throwing observer must not stop the ones registered after it.
    expect(seen).toEqual(['https://example.com'])
    expect(egressLedgerSize()).toBe(1)

    stop()
    stopSecond()
  })

  it('issues a monotonic seq that brackets an operation exactly', () => {
    checkEgress({ url: 'https://before.example/a', purpose: 'mcp_remote' })
    const mark = currentEgressSeq()
    checkEgress({ url: 'https://during.example/b', purpose: 'mcp_remote' })

    const after = listEgress().filter((recorded) => recorded.seq > mark)
    expect(after.map((recorded) => recorded.origin)).toEqual(['https://during.example'])
  })
})
