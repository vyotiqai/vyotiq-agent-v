import { BlockList, isIP } from 'net'

/**
 * Private-network access for the agent browser.
 *
 * Agent mode lets the browser reach loopback and LAN hosts, because pointing it
 * at your own dev server is the point. That posture is per tab, though, and a
 * tab is not a trust boundary: once the agent opens a public page in it, that
 * page's script could `fetch()` your router, a dev server's admin route, or a
 * cloud metadata address — the request rode the tab's allowance.
 *
 * The rule here is the one Chromium's Private Network Access draws: a request
 * may reach loopback or private address space only when the page that issued
 * it is itself in that space. "The page" is the top-level document for a
 * subresource, the URL being redirected away from for a redirect, and the
 * opener for a popup. A top-level navigation the agent asks for explicitly is
 * not judged here at all — that is a direct instruction, not a page acting.
 *
 * Everything in this module is synchronous and DNS-free: it runs on the
 * per-request hook. A public DNS name that merely resolves to a private address
 * is therefore not caught (beyond the wildcard-DNS names recognised below);
 * docs/egress.md states that limit.
 */

export type AddressSpace = 'loopback' | 'private' | 'public'

const LOOPBACK = new BlockList()
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4')
// 0.0.0.0 reaches the local machine on Linux and macOS; Chromium treats it as local.
LOOPBACK.addSubnet('0.0.0.0', 8, 'ipv4')
LOOPBACK.addSubnet('::1', 128, 'ipv6')
LOOPBACK.addSubnet('::', 128, 'ipv6')

const PRIVATE = new BlockList()
PRIVATE.addSubnet('10.0.0.0', 8, 'ipv4')
PRIVATE.addSubnet('100.64.0.0', 10, 'ipv4')
PRIVATE.addSubnet('169.254.0.0', 16, 'ipv4')
PRIVATE.addSubnet('172.16.0.0', 12, 'ipv4')
PRIVATE.addSubnet('192.168.0.0', 16, 'ipv4')
// Multicast, reserved and broadcast: never a public web host.
PRIVATE.addSubnet('224.0.0.0', 3, 'ipv4')
PRIVATE.addSubnet('fc00::', 7, 'ipv6')
PRIVATE.addSubnet('fe80::', 10, 'ipv6')
PRIVATE.addSubnet('fec0::', 10, 'ipv6')
PRIVATE.addSubnet('ff00::', 8, 'ipv6')

/** Names that only ever resolve inside a network (mDNS, RFC 8375, common LAN suffixes). */
const PRIVATE_SUFFIXES = ['.local', '.internal', '.lan', '.home.arpa', '.localdomain', '.intranet']

/**
 * Public wildcard-DNS services whose every name resolves to 127.0.0.1. They are
 * the stock way to aim a public-looking name at loopback, so they are named.
 */
const LOOPBACK_DNS_ZONES = ['localtest.me', 'lvh.me', 'vcap.me', 'localhost.direct']

/**
 * A dotted or dashed IPv4 embedded in a longer name — `10.0.0.1.nip.io`,
 * `app-192-168-1-1.sslip.io`. Those services answer with the embedded address.
 */
const EMBEDDED_IPV4 = /(?:^|[.-])(\d{1,3})[.-](\d{1,3})[.-](\d{1,3})[.-](\d{1,3})(?=\.)/g

function classifyIpv4(address: string): AddressSpace {
  if (LOOPBACK.check(address, 'ipv4')) return 'loopback'
  if (PRIVATE.check(address, 'ipv4')) return 'private'
  return 'public'
}

/** Expand an IPv6 literal to eight 16-bit groups; null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address
  const tail: number[] = []
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const octets = dotted[1].split('.').map(Number)
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
    text = text.slice(0, -dotted[1].length) + '0:0'
  }
  const halves = text.split('::')
  if (halves.length > 2) return null
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16))
  const head = parse(halves[0])
  const rest = halves.length === 2 ? parse(halves[1]) : []
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  const groups = [...head, ...new Array<number>(Math.max(0, fill)).fill(0), ...rest]
  if (groups.length !== 8 || groups.some((g) => !Number.isFinite(g))) return null
  if (tail.length === 2) {
    groups[6] = tail[0]
    groups[7] = tail[1]
  }
  return groups
}

function classifyIpv6(address: string): AddressSpace {
  if (LOOPBACK.check(address, 'ipv6')) return 'loopback'
  // BlockList matches IPv4-mapped forms (::ffff:a.b.c.d) against the v4 ranges too.
  if (PRIVATE.check(address, 'ipv6')) return 'private'
  const groups = ipv6Groups(address)
  if (groups) {
    // IPv4-compatible (::a.b.c.d) and NAT64 (64:ff9b::a.b.c.d) carry a v4 address.
    const compatible = groups.slice(0, 6).every((g) => g === 0)
    const nat64 = groups[0] === 0x64 && groups[1] === 0xff9b && groups.slice(2, 6).every((g) => g === 0)
    if (compatible || nat64) {
      const v4 = `${groups[6] >> 8}.${groups[6] & 0xff}.${groups[7] >> 8}.${groups[7] & 0xff}`
      return classifyIpv4(v4)
    }
  }
  return 'public'
}

/**
 * Canonicalise a host the way the URL parser does, so `0x7f.1`, `2130706433`,
 * `0177.0.0.1` and full-width digits all arrive as `127.0.0.1`.
 */
function canonicalHost(raw: string): string | null {
  let host = raw.trim().toLowerCase()
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1)
  if (host === '') return null
  if (isIP(host) === 0 && host.includes(':')) return null
  try {
    const parsed = new URL(`http://${isIP(host) === 6 ? `[${host}]` : host}/`).hostname
    host = parsed.startsWith('[') && parsed.endsWith(']') ? parsed.slice(1, -1) : parsed
  } catch {
    return null
  }
  // A trailing dot names the same host (`localhost.`); strip it before matching.
  return host.replace(/\.+$/, '')
}

/** Which address space a host belongs to, judged without DNS. */
export function classifyHostname(raw: string): AddressSpace {
  const host = canonicalHost(raw)
  if (host === null || host === '') return 'public'

  const version = isIP(host)
  if (version === 4) return classifyIpv4(host)
  if (version === 6) return classifyIpv6(host)

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback'
  if (LOOPBACK_DNS_ZONES.some((zone) => host === zone || host.endsWith(`.${zone}`))) {
    return 'loopback'
  }
  if (PRIVATE_SUFFIXES.some((suffix) => host.endsWith(suffix))) return 'private'
  // A single-label name (`router`, `nas`) only resolves through a local search domain.
  if (!host.includes('.')) return 'private'

  let embedded: AddressSpace = 'public'
  for (const match of host.matchAll(EMBEDDED_IPV4)) {
    const octets = match.slice(1, 5).map(Number)
    if (octets.some((n) => n > 255)) continue
    const space = classifyIpv4(octets.join('.'))
    if (space === 'loopback') return 'loopback'
    if (space === 'private') embedded = 'private'
  }
  return embedded
}

export function isLocalAddressSpace(space: AddressSpace | null): boolean {
  return space === 'loopback' || space === 'private'
}

const NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:'])

/**
 * The address space a URL's host is in, or null when the URL does not name a
 * network host (`about:`, `data:`, unparseable).
 */
export function addressSpaceOfUrl(raw: string): AddressSpace | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol === 'blob:') {
    // `blob:http://localhost:3000/<uuid>` belongs to the origin it embeds.
    return url.origin === 'null' ? null : addressSpaceOfUrl(url.origin)
  }
  if (!NETWORK_SCHEMES.has(url.protocol)) return null
  return classifyHostname(url.hostname)
}

/**
 * Whether a page at `raw` may issue requests into loopback/private space. A
 * `file:` page is local content on this machine, so it counts; a blank or
 * opaque page (`about:blank`, `data:`) does not.
 */
export function isPrivateNetworkInitiator(raw: string | undefined): boolean {
  if (!raw) return false
  if (raw.startsWith('file:')) return true
  return isLocalAddressSpace(addressSpaceOfUrl(raw))
}

export type PrivateNetworkDecision = { allowed: true } | { allowed: false; detail: string }

function originLabel(raw: string): string {
  try {
    const url = new URL(raw)
    return url.origin === 'null' ? `${url.protocol}` : url.origin
  } catch {
    return 'an unknown page'
  }
}

/**
 * Judge one request against the private-network rule. `initiatorUrl` is the
 * page the request came from; an empty string means "no attributable page" and
 * is treated as public, never as permission.
 */
export function evaluatePrivateNetworkAccess(
  targetUrl: string,
  initiatorUrl: string
): PrivateNetworkDecision {
  const target = addressSpaceOfUrl(targetUrl)
  if (!isLocalAddressSpace(target)) return { allowed: true }
  if (isPrivateNetworkInitiator(initiatorUrl)) return { allowed: true }
  const from = initiatorUrl ? originLabel(initiatorUrl) : 'a page with no local origin'
  return {
    allowed: false,
    detail: `${originLabel(targetUrl)} is ${target === 'loopback' ? 'loopback' : 'on the private network'}; a request from ${from} may not reach it`
  }
}
