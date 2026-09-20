import net from 'net'
import { logger } from '../../shared/logger'

/**
 * How long each candidate address gets to connect before the runtime moves on.
 *
 * Node defaults to 250ms (RFC 8305's suggestion for a local network). That is
 * shorter than the real round-trip to a lot of the internet, and the failure
 * it produces is not a slow connection — it is no connection at all:
 *
 *   `mcp.deepwiki.com` publishes 3 A and 3 AAAA records. On a machine with no
 *   IPv6 route, each AAAA attempt hangs. Each A attempt needs ~290–380ms to
 *   complete — so every one of them is abandoned 40–130ms before it would
 *   have succeeded. The runtime round-robins all six until the 10s connect
 *   budget runs out and reports
 *   `fetch failed — Connect Timeout Error (attempted addresses: …, timeout: 10000ms)`,
 *   while a plain `net.connect` to any of those same IPv4 addresses succeeds
 *   first time. Hosts that publish one address (Context7, GitHub) are
 *   unaffected, which is why this looked like one server being down.
 *
 * 1000ms clears a transcontinental round trip with margin and stays inside
 * RFC 8305's 2s ceiling. The cost is paid only where the first address is
 * genuinely unreachable: one extra second before falling back, once per
 * connection, after which the socket is pooled.
 */
export const AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS = 1000

/**
 * Widen the per-address connect window process-wide.
 *
 * Global on purpose: every outbound request in main — MCP, provider APIs,
 * the catalog, updates — goes through the same dialer and hits the same wall.
 */
export function widenHappyEyeballsWindow(
  timeoutMs = AUTO_SELECT_FAMILY_ATTEMPT_TIMEOUT_MS
): void {
  try {
    const current = net.getDefaultAutoSelectFamilyAttemptTimeout()
    if (current >= timeoutMs) return
    net.setDefaultAutoSelectFamilyAttemptTimeout(timeoutMs)
    logger.info('Widened the per-address connect window', {
      scope: 'net',
      from: current,
      to: timeoutMs
    })
  } catch (err) {
    // Older runtimes do not expose the setter. The default stands; slow hosts
    // stay slow to reach, which is where we were before.
    logger.warn('Could not widen the per-address connect window', { scope: 'net', err })
  }
}
