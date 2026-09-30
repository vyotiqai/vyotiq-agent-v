/**
 * Proxy and extra-header rules shared by Settings (to explain a bad value)
 * and main (to refuse one at request time).
 */

export type ParsedProxyUrl = { ok: true; url: string } | { ok: false; error: string }

/**
 * A manual proxy: `http://host:port` or `https://host:port`. Credentials in
 * the URL are refused — settings are plain JSON and get exported; a proxy that
 * needs a password is set through HTTPS_PROXY in the environment instead.
 */
export function validateProxyUrl(raw: string): ParsedProxyUrl {
  const input = raw.trim()
  if (!input) return { ok: false, error: 'Enter the proxy address, like http://proxy.example.com:8080.' }
  // Chromium's URL parser percent-encodes a space in a host where Node's
  // refuses it; decide here so the renderer and main agree.
  if (/\s/.test(input)) return { ok: false, error: 'That is not a proxy address. Use http://host:port.' }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(input) ? input : `http://${input}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, error: 'That is not a proxy address. Use http://host:port.' }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http:// and https:// proxies are supported.' }
  }
  if (url.username || url.password) {
    return {
      ok: false,
      error: 'Leave the password out of the address. For a proxy that needs one, set HTTPS_PROXY before starting the app.'
    }
  }
  if (!url.hostname) return { ok: false, error: 'The proxy address needs a host.' }
  if (!/^(?:[a-z0-9-]+(?:\.[a-z0-9-]+)*|\[[0-9a-f:.]+\])$/i.test(url.hostname)) {
    return { ok: false, error: 'That is not a proxy address. Use http://host:port.' }
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    return { ok: false, error: 'A proxy address is just a host and port, with no path.' }
  }
  return { ok: true, url: `${url.protocol}//${url.host}` }
}

/** `a.com, *.corp ; 10.0.0.0/8` → `a.com,*.corp,10.0.0.0/8` (NO_PROXY form). */
export function normalizeProxyBypass(raw: string): string {
  return raw
    .split(/[,;\s]+/)
    .map((h) => h.trim())
    .filter(Boolean)
    .join(',')
}

/** RFC 9110 token characters. */
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/
/** Headers the request itself owns; setting them would break or smuggle it. */
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'te',
  'trailer',
  'proxy-authorization',
  'proxy-connection'
])
export const MAX_CUSTOM_HEADERS = 16
const MAX_HEADER_VALUE = 4096

/** Why one header can't be sent, or null when it can. */
export function customHeaderError(name: string, value: string): string | null {
  const n = name.trim()
  if (!HEADER_NAME_RE.test(n)) return `"${n || '(empty)'}" is not a header name.`
  if (RESERVED_HEADERS.has(n.toLowerCase())) return `${n} is set by the app and can't be changed.`
  if (/[\r\n\0]/.test(value)) return `${n} has a line break in its value.`
  if (value.length > MAX_HEADER_VALUE) return `${n} is longer than ${MAX_HEADER_VALUE} characters.`
  return null
}

/** Keep the headers that can be sent (first spelling of a name wins), capped. */
export function sanitizeCustomHeaders(
  headers: Record<string, string> | undefined
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  const seen = new Set<string>()
  for (const [rawName, rawValue] of Object.entries(headers)) {
    if (typeof rawValue !== 'string') continue
    const name = rawName.trim()
    const value = rawValue.trim()
    if (customHeaderError(name, value)) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out[name] = value
    if (seen.size >= MAX_CUSTOM_HEADERS) break
  }
  return Object.keys(out).length ? out : undefined
}

/** The proxy main is using right now (Settings → General → Network shows it). */
export type ProxyStatus = {
  /** Where the proxy came from; `none` is a direct connection. */
  source: 'manual' | 'environment' | 'system' | 'none'
  /** The proxy in use, never with credentials. */
  url?: string
  bypass?: string
  /** Why the setting could not be followed as written. */
  note?: string
}

/** Whether this computer has a gcloud login Vertex AI can use. */
export type GoogleAdcStatus =
  | { found: true; path: string; kind: 'authorized_user' | 'service_account'; account?: string }
  | { found: false; path: string; error: string }
