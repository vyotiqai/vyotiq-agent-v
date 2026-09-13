import { lookup as dnsLookup } from 'dns/promises'
import { mkdirSync, writeFileSync } from 'fs'
import * as http from 'http'
import * as https from 'https'
import { BlockList, isIP } from 'net'
import { dirname } from 'path'
import { isRetriableToolNetworkError } from '../networkMonitor'
import {
  circuitKeyHttp,
  assertCircuitClosed,
  isCircuitOpenError,
  recordCircuitFailure,
  recordCircuitSuccess
} from '../circuitBreaker'
import {
  httpRetryBackoffMs,
  runWithNetworkRetry,
  sleepAbortable
} from '../providers/fetchWithRetry'
import { abortError } from '../../../shared/errors'
import type { IncomingMessage, RequestOptions } from 'http'

/**
 * Hard cap on bytes buffered for any public fetch. Restores the pre-a067d81
 * 2 MB limit: a hostile or accidental huge download must not balloon
 * main-process memory. `readBody` truncates at this mark; `fetchPinnedPublic`
 * destroys the socket when exceeded.
 */
export const WEB_FETCH_MAX_BYTES = 2 * 1024 * 1024
export const WEB_FETCH_DEFAULT_TIMEOUT_MS = 20_000
export const WEB_FETCH_DEFAULT_MAX_CHARS = 40_000
export const WEB_FETCH_MAX_TIMEOUT_MS = 60_000
const DEFAULT_TIMEOUT_MS = WEB_FETCH_DEFAULT_TIMEOUT_MS
const MAX_REDIRECTS = 5

type LookupFn = typeof dnsLookup

let resolveHost: LookupFn = dnsLookup

/** Test helper — override DNS resolution for SSRF checks. */
export function setDnsLookupForTests(next: LookupFn): void {
  resolveHost = next
}

/** Test helper — restore default DNS resolution. */
export function resetDnsLookupForTests(): void {
  resolveHost = dnsLookup
}

/** Resolve a URL with optional allowance for local/private addresses. */
export async function assertAllowedUrl(raw: string, allowLocal = false): Promise<URL> {
  const { url } = await resolveAllowedUrl(raw, allowLocal)
  return url
}

/** Backward-compatible alias that always blocks local/private addresses. */
export async function assertPublicUrl(raw: string): Promise<URL> {
  return assertAllowedUrl(raw, false)
}

/**
 * Resolve an http(s) URL and return the validated addresses so callers can pin
 * the TCP connect (DNS-rebinding resistant).
 *
 * @param allowLocal When `true`, loopback and private ranges (127/8, 10/8,
 *   172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fe80::/10, fc00::/7)
 *   are allowed in addition to public addresses. Used for Ollama and other
 *   explicitly local endpoints.
 */
export async function resolveAllowedUrl(
  raw: string,
  allowLocal = false
): Promise<{ url: URL; addresses: string[] }> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Not a valid URL: ${raw}`)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`Unsupported protocol ${url.protocol}; use http(s)`)
  }

  const host = stripIpv6Brackets(url.hostname).toLowerCase()
  if (isBlockedHostname(host, allowLocal)) {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const literalVersion = isIP(host)
  if (literalVersion === 4) {
    if (isBlockedAddress(host, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    }
    return { url, addresses: [host] }
  }
  if (literalVersion === 6) {
    if (isBlockedAddress(host, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    }
    return { url, addresses: [host] }
  }

  // Decimal/hex IPv4 forms that `isIP()` does not classify (e.g. 2130706433 → 127.0.0.1).
  if (isBlockedAddress(host, allowLocal)) {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const resolved = await resolveHost(host, { all: true, verbatim: true })
  if (resolved.length === 0) {
    throw new Error(`Could not resolve host: ${host}`)
  }
  const addresses: string[] = []
  for (const entry of resolved) {
    if (isBlockedAddress(entry.address, allowLocal)) {
      throw new Error(`Refusing to fetch a private or loopback address: ${host}`)
    }
    addresses.push(entry.address)
  }

  return { url, addresses }
}

/** Backward-compatible alias that always blocks local/private addresses. */
export async function resolvePublicUrl(
  raw: string
): Promise<{ url: URL; addresses: string[] }> {
  return resolveAllowedUrl(raw, false)
}

/**
 * Sync SSRF gate for Electron navigation events (no DNS).
 * Returns true when the URL must be refused immediately.
 * Hostnames that need DNS resolution return false — callers should
 * still `assertAllowedUrl` after the load settles.
 */
export function isSyncBlockedUrl(raw: string, allowLocal = false): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return true
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true

  const host = stripIpv6Brackets(url.hostname).toLowerCase()
  if (isBlockedHostname(host, allowLocal)) return true

  const literalVersion = isIP(host)
  if (literalVersion === 4) return isBlockedAddress(host, allowLocal)
  if (literalVersion === 6) return isBlockedAddress(host, allowLocal)
  // Alternate IPv4 encodings (decimal/hex) that `isIP()` misses.
  return isBlockedAddress(host, allowLocal)
}

function stripIpv6Brackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host
}

function isBlockedHostname(host: string, allowLocal = false): boolean {
  if (allowLocal) return false
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  )
}

function parseIpv4Parts(host: string): [number, number, number, number] | null {
  if (/^\d+$/.test(host)) {
    const value = Number(host)
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) return null
    return [
      (value >>> 24) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff
    ]
  }

  const parts = host.split('.')
  if (parts.length < 1 || parts.length > 4) return null

  const nums: number[] = []
  for (const part of parts) {
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(part)) return null
    const value = Number.parseInt(part, part.startsWith('0x') ? 16 : 10)
    if (!Number.isFinite(value) || value < 0) return null
    nums.push(value)
  }

  if (nums.length === 4) {
    if (nums.some((n) => n > 255)) return null
    return nums as [number, number, number, number]
  }

  if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255) return null
    return [nums[0], nums[1], nums[2], 0]
  }
  if (nums.length === 2) {
    if (nums[0] > 255) return null
    return [nums[0], nums[1], 0, 0]
  }
  if (nums.length === 1) {
    const value = nums[0]
    if (value > 0xffffffff) return null
    return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
  }

  return null
}

function isPrivateIpv4Bytes(a: number, b: number): boolean {
  if (a === 0) return true
  if (a === 10) return true
  if (a === 127) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a >= 224) return true
  return false
}

function isAllowedLocalIpv4Bytes(a: number, b: number): boolean {
  if (a === 127) return true
  if (a === 10) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/** RFC1918 / loopback / link-local / CGNAT / multicast / this-network — plus 240/4 reserved. */
const BLOCKED_V4 = new BlockList()
BLOCKED_V4.addSubnet('0.0.0.0', 8, 'ipv4')
BLOCKED_V4.addSubnet('10.0.0.0', 8, 'ipv4')
BLOCKED_V4.addSubnet('100.64.0.0', 10, 'ipv4')
BLOCKED_V4.addSubnet('127.0.0.0', 8, 'ipv4')
BLOCKED_V4.addSubnet('169.254.0.0', 16, 'ipv4')
BLOCKED_V4.addSubnet('172.16.0.0', 12, 'ipv4')
BLOCKED_V4.addSubnet('192.168.0.0', 16, 'ipv4')
BLOCKED_V4.addSubnet('224.0.0.0', 3, 'ipv4')

/** Loopback, unspecified, link-local, unique-local. IPv4-mapped uses BLOCKED_V4. */
const BLOCKED_V6 = new BlockList()
BLOCKED_V6.addSubnet('::1', 128, 'ipv6')
BLOCKED_V6.addSubnet('::', 128, 'ipv6')
BLOCKED_V6.addSubnet('fe80::', 10, 'ipv6')
BLOCKED_V6.addSubnet('fc00::', 7, 'ipv6')

const ALLOWED_LOCAL_V4 = new BlockList()
ALLOWED_LOCAL_V4.addSubnet('10.0.0.0', 8, 'ipv4')
ALLOWED_LOCAL_V4.addSubnet('100.64.0.0', 10, 'ipv4')
ALLOWED_LOCAL_V4.addSubnet('127.0.0.0', 8, 'ipv4')
ALLOWED_LOCAL_V4.addSubnet('169.254.0.0', 16, 'ipv4')
ALLOWED_LOCAL_V4.addSubnet('172.16.0.0', 12, 'ipv4')
ALLOWED_LOCAL_V4.addSubnet('192.168.0.0', 16, 'ipv4')

const ALLOWED_LOCAL_V6 = new BlockList()
ALLOWED_LOCAL_V6.addSubnet('::1', 128, 'ipv6')
ALLOWED_LOCAL_V6.addSubnet('fe80::', 10, 'ipv6')
ALLOWED_LOCAL_V6.addSubnet('fc00::', 7, 'ipv6')

function isPrivateIpv4(host: string): boolean {
  const parts = parseIpv4Parts(host)
  if (!parts) return false
  return isPrivateIpv4Bytes(parts[0], parts[1])
}

function isAllowedLocalAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return ALLOWED_LOCAL_V4.check(address, 'ipv4')
  if (version === 6) {
    return ALLOWED_LOCAL_V6.check(address, 'ipv6') || ALLOWED_LOCAL_V4.check(address, 'ipv6')
  }
  const parts = parseIpv4Parts(address)
  if (!parts) return false
  return isAllowedLocalIpv4Bytes(parts[0], parts[1])
}

function isBlockedAddress(address: string, allowLocal = false): boolean {
  if (allowLocal && isAllowedLocalAddress(address)) return false
  const version = isIP(address)
  if (version === 4) return BLOCKED_V4.check(address, 'ipv4')
  if (version === 6) {
    // type 'ipv6' also matches IPv4-mapped forms (::ffff:7f00:1) against v4 ranges.
    return BLOCKED_V6.check(address, 'ipv6') || BLOCKED_V4.check(address, 'ipv6')
  }
  // Decimal / hex IPv4 encodings that `isIP()` does not classify.
  return isPrivateIpv4(address)
}

type LookupAddress = { address: string; family: 4 | 6 }
type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number
) => void

/**
 * Custom `http(s).request` lookup that pins to already-validated IPs.
 * Node 20+ Happy Eyeballs calls lookup with `{ all: true }` and expects an
 * array of `{ address, family }` — returning a bare string yields
 * `Invalid IP address: undefined`.
 */
export function createPinnedLookup(
  addresses: string[],
  allowLocal = false
): NonNullable<RequestOptions['lookup']> {
  const entries: LookupAddress[] = []
  for (const address of addresses) {
    if (isBlockedAddress(address, allowLocal)) continue
    const version = isIP(address)
    if (version !== 4 && version !== 6) continue
    entries.push({ address, family: version })
  }
  // Prefer IPv4 for the single-address path (broader compatibility).
  const preferred = entries.find((e) => e.family === 4) ?? entries[0]
  if (!preferred) {
    throw new Error('Refusing to fetch a private or loopback address')
  }

  return ((_hostname, options, callback) => {
    const opts =
      typeof options === 'object' && options !== null
        ? (options as { all?: boolean })
        : ({} as { all?: boolean })
    const cb: LookupCallback =
      typeof options === 'function' ? (options as LookupCallback) : (callback as LookupCallback)

    if (opts.all) {
      cb(null, entries)
      return
    }
    cb(null, preferred.address, preferred.family)
  }) as NonNullable<RequestOptions['lookup']>
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
}

/** Strip tags and collapse whitespace — used to judge whether a region has substance. */
function stripHtmlTags(html: string): string {
  return decodeEntities(html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')).trim()
}

/**
 * Drop site chrome and prefer main landmarks before markdown conversion.
 * SPA shells (e.g. Hugging Face) ship most nav in static HTML; stripping
 * header/nav/footer keeps the converter from burning the char budget on links.
 */
export function extractMainHtml(html: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript|svg|iframe)[\s\S]*?<\/\1>/gi, '')

  text = text.replace(/<(nav|header|footer|aside)[^>]*>[\s\S]*?<\/\1>/gi, '')

  const landmark =
    text.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    text.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    text.match(/<[^>]+role=["']main["'][^>]*>([\s\S]*?)<\/[^>]+>/i)

  if (landmark?.[1] && stripHtmlTags(landmark[1]).length > 200) {
    return landmark[1]
  }

  return text
}

function htmlFragmentToMarkdown(html: string): string {
  let text = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|tr|li|h[1-6])>/gi, '\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<h1[^>]*>/gi, '\n# ')
    .replace(/<h2[^>]*>/gi, '\n## ')
    .replace(/<h3[^>]*>/gi, '\n### ')
    .replace(/<h[456][^>]*>/gi, '\n#### ')
    .replace(/<code[^>]*>/gi, '`')
    .replace(/<\/code>/gi, '`')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, label: string) => {
      const clean = label.replace(/<[^>]+>/g, '').trim()
      return clean ? `[${clean}](${href})` : href
    })
    .replace(/<[^>]+>/g, '')

  return decodeEntities(text)
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .filter((line) => {
      const trimmed = line.trim()
      if (!trimmed) return false
      // Icon-only <li> elements become empty bullets after tag stripping.
      return trimmed !== '-' && trimmed !== '- '
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Common SPA nav labels that dominate shell HTML when main content is client-rendered. */
const SPA_NAV_LABELS = new Set([
  'models',
  'datasets',
  'spaces',
  'docs',
  'enterprise',
  'pricing',
  'tasks',
  'collections',
  'huggingchat',
  'buckets',
  'buckets new',
  'login',
  'sign up',
  'log in',
  'home',
  'website'
])

/**
 * Detect markdown that is mostly site chrome with little page-specific prose.
 * Returns a warning paragraph when the fetch likely needs browser snapshot/API.
 */
export function spaShellWarning(markdown: string): string | null {
  const lines = markdown
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length < 4) return null

  const navHits = lines.filter((line) => {
    const label = line
      .replace(/^-\s*/, '')
      .replace(/^\[(.+)\]\([^)]+\)$/, '$1')
      .trim()
      .toLowerCase()
    return SPA_NAV_LABELS.has(label)
  }).length

  const proseLines = lines.filter(
    (line) => !line.startsWith('#') && !line.startsWith('-') && line.length >= 48
  )
  const linkish = lines.filter((line) => /^\[.+\]\(.+\)$/.test(line) || /^-\s*\[.+\]/.test(line))

  if (navHits >= 4 && proseLines.length < 4) {
    return (
      'Warning: this page looks like a JavaScript-rendered shell (mostly site navigation, little main content). ' +
      'Static fetch cannot see the rendered model card. Use browser_snapshot, a direct API/file URL, or a terminal download instead of treating this output as the page body.'
    )
  }

  if (linkish.length >= 6 && proseLines.length < 3 && lines.length < 40) {
    return (
      'Warning: fetched content is mostly navigation links with little substantive text. ' +
      'The page may require client-side rendering — use browser tools or download artifacts directly.'
    )
  }

  return null
}

/**
 * Convert HTML to a rough markdown skeleton.
 *
 * The point is to keep the structure a reader relies on — headings, links, list
 * items, code — while dropping the markup that would otherwise burn context.
 */
export function htmlToMarkdown(html: string): string {
  return htmlFragmentToMarkdown(extractMainHtml(html))
}

export type WebFetchOptions = {
  timeoutMs?: number
  maxChars?: number
}

const WEB_FETCH_RETRY_ATTEMPTS = 3

function isRetriablePublicGetError(err: unknown): boolean {
  if (isRetriableToolNetworkError(err)) return true
  const message = err instanceof Error ? err.message : String(err)
  return /\bHTTP (429|5\d{2})\b/.test(message)
}



export type PinnedFetchRequest = {
  method?: string
  body?: string
}

export async function fetchWithValidatedRedirects(
  startUrl: URL,
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal = false,
  request?: PinnedFetchRequest
): Promise<{ response: Response; finalUrl: URL }> {
  let currentUrl = startUrl
  const method = (request?.method ?? 'GET').toUpperCase()

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: validated, addresses } = await resolveAllowedUrl(currentUrl.href, allowLocal)
    const res = await publicFetchImpl(
      validated,
      addresses,
      signal,
      headers,
      allowLocal,
      request
    )

    if (res.status >= 300 && res.status < 400) {
      if (method !== 'GET' && method !== 'HEAD') {
        throw new Error(`Refusing to follow ${res.status} redirect on ${method} ${validated.href}`)
      }
      const location = res.headers.get('location')
      if (!location) {
        throw new Error(`Redirect response missing Location header for ${validated.href}`)
      }
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while fetching ${startUrl.href}`)
      }
      currentUrl = new URL(location, validated)
      continue
    }

    return { response: res, finalUrl: validated }
  }

  throw new Error(`Too many redirects while fetching ${startUrl.href}`)
}

type PublicFetchImpl = (
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal?: boolean,
  request?: PinnedFetchRequest
) => Promise<Response>

/**
 * Connect using a DNS result already proven safe so a second lookup cannot
 * rebind to a private address mid-request (SNI/Host still use the hostname).
 */
async function fetchPinnedPublic(
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  headers?: Record<string, string>,
  allowLocal = false,
  request?: PinnedFetchRequest
): Promise<Response> {
  let lookup: NonNullable<RequestOptions['lookup']>
  try {
    lookup = createPinnedLookup(addresses, allowLocal)
  } catch {
    throw new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
  }

  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const port = url.port ? Number(url.port) : defaultPort
  const method = (request?.method ?? 'GET').toUpperCase()
  const body = request?.body
  const requestHeaders: Record<string, string> = {
    ...(headers ?? { accept: 'text/html,text/plain,application/json;q=0.9,*/*;q=0.5' }),
    host: url.host
  }
  if (body != null && requestHeaders['content-length'] == null && requestHeaders['Content-Length'] == null) {
    requestHeaders['content-length'] = String(Buffer.byteLength(body))
  }

  const options: RequestOptions = {
    protocol: url.protocol,
    hostname: url.hostname,
    port,
    path: `${url.pathname}${url.search}`,
    method,
    headers: requestHeaders,
    lookup
  }

  const lib = url.protocol === 'https:' ? https : http

  return await new Promise<Response>((resolve, reject) => {
    let settled = false
    let onAbort: () => void = () => undefined
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const req = lib.request(options, (incoming: IncomingMessage) => {
      const chunks: Buffer[] = []
      let totalBytes = 0
      let tooLarge = false
      incoming.on('data', (chunk: Buffer | string) => {
        const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
        // Same byte cap as readBody(): stop buffering (but keep draining) once
        // the response exceeds WEB_FETCH_MAX_BYTES so the socket cannot balloon
        // main-process memory. The error surfaces on 'end' below.
        if (totalBytes >= WEB_FETCH_MAX_BYTES) {
          tooLarge = true
          return
        }
        const room = WEB_FETCH_MAX_BYTES - totalBytes
        const clipped = buf.byteLength > room ? buf.subarray(0, room) : buf
        totalBytes += clipped.byteLength
        if (buf.byteLength > room) tooLarge = true
        chunks.push(clipped)
      })
      incoming.on('end', () => {
        if (tooLarge) {
          finish(() =>
            reject(
              new Error(
                `Response body exceeded ${WEB_FETCH_MAX_BYTES} bytes; use browser tools or a direct download instead`
              )
            )
          )
          return
        }
        const body = Buffer.concat(chunks)
        const headerInit: Record<string, string> = {}
        for (const [key, value] of Object.entries(incoming.headers)) {
          if (value == null) continue
          headerInit[key] = Array.isArray(value) ? value.join(', ') : value
        }
        finish(() =>
          resolve(
            new Response(body, {
              status: incoming.statusCode ?? 0,
              statusText: incoming.statusMessage ?? '',
              headers: headerInit
            })
          )
        )
      })
      incoming.on('error', (err) => finish(() => reject(err)))
    })

    req.on('error', (err) => {
      finish(() => reject(err))
    })
    onAbort = (): void => {
      req.destroy()
      finish(() => reject(abortError()))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.end(body)
  })
}

let publicFetchImpl: PublicFetchImpl = fetchPinnedPublic

/** Test helper — inject fetch for redirect / network tests. */
export function setPublicFetchForTests(next: PublicFetchImpl | null): void {
  publicFetchImpl = next ?? fetchPinnedPublic
}

/** Read the full response body, capped at WEB_FETCH_MAX_BYTES. */
async function readBody(res: Response): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const chunks: Buffer[] = []
  let totalBytes = 0

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      // Hard cap (restores pre-a067d81 behavior): buffered bytes never exceed
      // WEB_FETCH_MAX_BYTES. Remaining stream bytes are read and discarded so
      // the connection can close cleanly.
      const room = WEB_FETCH_MAX_BYTES - totalBytes
      if (room <= 0) continue
      const buf = Buffer.from(value)
      if (buf.byteLength > room) {
        chunks.push(buf.subarray(0, room))
        totalBytes = WEB_FETCH_MAX_BYTES
      } else {
        chunks.push(buf)
        totalBytes += buf.byteLength
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }

  return Buffer.concat(chunks)
}

/** Shared marketplace/MCP helper — public SSRF-safe fetch with redirect validation. */
export async function fetchPublicResponse(
  startUrl: URL,
  signal: AbortSignal,
  headers?: Record<string, string>
): Promise<{ response: Response; finalUrl: URL; body: Buffer }> {
  const circuitKey = circuitKeyHttp(startUrl)
  assertCircuitClosed(circuitKey)
  try {
    for (let attempt = 1; attempt <= WEB_FETCH_RETRY_ATTEMPTS; attempt++) {
      try {
        const { response, finalUrl } = await fetchWithValidatedRedirects(startUrl, signal, headers)
        const retriableStatus = response.status >= 500 || response.status === 429
        if (retriableStatus && attempt < WEB_FETCH_RETRY_ATTEMPTS) {
          try {
            await response.body?.cancel()
          } catch {
            // Body already consumed or the connection is gone.
          }
          await sleepAbortable(httpRetryBackoffMs(attempt), signal)
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
          continue
        }
        const body = await readBody(response)
        if (retriableStatus) recordCircuitFailure(circuitKey)
        else recordCircuitSuccess(circuitKey)
        return { response, finalUrl, body }
      } catch (err) {
        if (signal.aborted) throw err
        if (!isRetriableToolNetworkError(err) || attempt >= WEB_FETCH_RETRY_ATTEMPTS) throw err
        await sleepAbortable(httpRetryBackoffMs(attempt), signal)
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      }
    }
    throw new Error('fetch failed')
  } catch (err) {
    if (!signal.aborted && !isCircuitOpenError(err) && isRetriableToolNetworkError(err)) {
      recordCircuitFailure(circuitKey)
    }
    throw err
  }
}

/**
 * Download a public URL to disk with DNS pinning and validated redirects.
 * Uses a higher byte cap than web_fetch (marketplace packages, etc.).
 */
export async function downloadPublicUrlToFile(
  rawUrl: string,
  destPath: string,
  signal?: AbortSignal,
  maxBytes = 100 * 1024 * 1024
): Promise<void> {
  const abortSignal = signal ?? AbortSignal.timeout(60_000)
  await runWithNetworkRetry(
    () => downloadPublicUrlToFileOnce(rawUrl, destPath, abortSignal, maxBytes),
    {
      signal: abortSignal,
      maxAttempts: WEB_FETCH_RETRY_ATTEMPTS,
      isRetriable: isRetriablePublicGetError,
      circuitKey: circuitKeyHttp(String(rawUrl ?? '').trim())
    }
  )
}

async function downloadPublicUrlToFileOnce(
  rawUrl: string,
  destPath: string,
  abortSignal: AbortSignal,
  maxBytes: number
): Promise<void> {
  let currentUrl = await assertPublicUrl(String(rawUrl ?? '').trim())

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const { url: validated, addresses } = await resolvePublicUrl(currentUrl.href)
    const hopResult = await downloadPinnedHop(validated, addresses, abortSignal, maxBytes)

    if (hopResult.kind === 'redirect') {
      if (hop === MAX_REDIRECTS) {
        throw new Error(`Too many redirects while downloading ${rawUrl}`)
      }
      currentUrl = new URL(hopResult.location, validated)
      continue
    }

    mkdirSync(dirname(destPath), { recursive: true })
    writeFileSync(destPath, hopResult.body)
    return
  }

  throw new Error(`Too many redirects while downloading ${rawUrl}`)
}

type DownloadHopResult =
  | { kind: 'redirect'; location: string }
  | { kind: 'body'; body: Buffer }

/** One DNS-pinned GET; either returns a redirect Location or the response body. */
function downloadPinnedHop(
  url: URL,
  addresses: string[],
  signal: AbortSignal,
  maxBytes: number
): Promise<DownloadHopResult> {
  let lookup: NonNullable<RequestOptions['lookup']>
  try {
    lookup = createPinnedLookup(addresses)
  } catch {
    return Promise.reject(
      new Error(`Refusing to fetch a private or loopback address: ${url.hostname}`)
    )
  }
  const defaultPort = url.protocol === 'https:' ? 443 : 80
  const port = url.port ? Number(url.port) : defaultPort
  const lib = url.protocol === 'https:' ? https : http

  return new Promise<DownloadHopResult>((resolve, reject) => {
    let settled = false
    let onAbort: () => void = () => undefined
    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      fn()
    }
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { host: url.host, accept: '*/*' },
        lookup
      },
      (incoming) => {
        const status = incoming.statusCode ?? 0
        if (status >= 300 && status < 400) {
          const location = incoming.headers.location
          incoming.resume()
          if (!location) {
            finish(() =>
              reject(new Error(`Redirect response missing Location header for ${url.href}`))
            )
            return
          }
          finish(() =>
            resolve({
              kind: 'redirect',
              location: Array.isArray(location) ? location[0] : location
            })
          )
          return
        }
        if (status < 200 || status >= 300) {
          incoming.resume()
          finish(() => reject(new Error(`Download failed: HTTP ${status}`)))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        incoming.on('data', (chunk: Buffer | string) => {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
          total += buf.byteLength
          if (total > maxBytes) {
            req.destroy()
            finish(() => reject(new Error(`Download exceeded ${maxBytes} bytes`)))
            return
          }
          chunks.push(buf)
        })
        incoming.on('end', () => finish(() => resolve({ kind: 'body', body: Buffer.concat(chunks) })))
        incoming.on('error', (err) => finish(() => reject(err)))
      }
    )
    req.on('error', (err) => {
      finish(() => reject(err))
    })
    req.on('close', () => signal.removeEventListener('abort', onAbort))
    onAbort = (): void => {
      req.destroy()
      finish(() => reject(abortError()))
    }
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    req.end()
  })
}
