/**
 * Why a reachable MCP server reported "Connect failed".
 *
 * `mcp.deepwiki.com` publishes 3 A and 3 AAAA records. Measured from a machine
 * with no IPv6 route: every AAAA attempt hangs, and each A attempt needs
 * 290–383ms to complete. Node gives each candidate address 250ms before moving
 * on, so every IPv4 attempt was abandoned just before it would have succeeded
 * and the dialer round-robined all six until the 10s connect budget expired:
 *
 *   fetch failed — Connect Timeout Error (attempted addresses: 184.33.103.39:443,
 *   2600:1f14:36ec:d00::2d70:443, …, timeout: 10000ms)
 *
 * A plain `net.connect` to any of those same IPv4 addresses succeeded first
 * time, and raising the window to 500ms turned the same request into HTTP 200.
 * Servers publishing a single address (Context7, GitHub) never hit it, which
 * is what made this look like one vendor being down.
 */
import { afterEach, describe, expect, it } from 'vitest'
import net from 'net'
import {
  AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS,
  widenHappyEyeballsWindow
} from '@main/net/happyEyeballs'

const original = net.getDefaultAutoSelectFamilyAttemptTimeout()

afterEach(() => {
  net.setDefaultAutoSelectFamilyAttemptTimeout(original)
})

describe('the per-address connect window', () => {
  it('clears the round trip that was being cut off', () => {
    // The slowest address measured was 383ms, and that was the fast half of
    // the problem — the window has to beat a real transcontinental RTT.
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBeGreaterThanOrEqual(500)
    // RFC 8305 caps the Connection Attempt Delay at 2s; past that a dead
    // first address costs more than the failure it prevents.
    expect(AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS).toBeLessThanOrEqual(2000)
  })

  it('widens the runtime default', () => {
    net.setDefaultAutoSelectFamilyAttemptTimeout(250)

    widenHappyEyeballsWindow()

    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(
      AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS
    )
  })

  it('leaves a wider setting alone', () => {
    // A user or a launcher that already raised this knows their network
    // better than a constant compiled in months ago.
    net.setDefaultAutoSelectFamilyAttemptTimeout(5000)

    widenHappyEyeballsWindow()

    expect(net.getDefaultAutoSelectFamilyAttemptTimeout()).toBe(5000)
  })

  it('does not throw when the runtime has no such setter', () => {
    const setter = net.setDefaultAutoSelectFamilyAttemptTimeout
    // @ts-expect-error — simulating an older runtime.
    net.setDefaultAutoSelectFamilyAttemptTimeout = undefined
    try {
      expect(() => widenHappyEyeballsWindow()).not.toThrow()
    } finally {
      net.setDefaultAutoSelectFamilyAttemptTimeout = setter
    }
  })
})
