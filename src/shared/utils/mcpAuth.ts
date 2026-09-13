/** Helpers for MCP Authorization / Bearer header handling. */

const AUTH_HEADER = 'Authorization'
const BEARER_PREFIX = 'Bearer '

export function getAuthorizationHeader(
  headers: Record<string, string> | undefined | null
): string | undefined {
  if (!headers) return undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === AUTH_HEADER.toLowerCase()) return value
  }
  return undefined
}

/** Token only (no "Bearer " prefix), or empty if unset / non-bearer. */
export function getBearerToken(
  headers: Record<string, string> | undefined | null
): string {
  const auth = getAuthorizationHeader(headers)
  if (!auth) return ''
  if (auth.toLowerCase().startsWith(BEARER_PREFIX.toLowerCase())) {
    return auth.slice(BEARER_PREFIX.length).trim()
  }
  return ''
}

/** True when Authorization is present but not a Bearer token (e.g. Basic). */
export function hasNonBearerAuthorization(
  headers: Record<string, string> | undefined | null
): boolean {
  const auth = getAuthorizationHeader(headers)
  if (!auth) return false
  return !auth.toLowerCase().startsWith(BEARER_PREFIX.toLowerCase())
}

/** Headers without any Authorization key (case-insensitive). */
export function headersWithoutAuthorization(
  headers: Record<string, string> | undefined | null
): Record<string, string> | undefined {
  if (!headers) return undefined
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === AUTH_HEADER.toLowerCase()) continue
    out[key] = value
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/**
 * Merge a bearer token into headers. Empty token removes Authorization.
 * Preserves other headers.
 */
export function withBearerToken(
  headers: Record<string, string> | undefined | null,
  token: string
): Record<string, string> | undefined {
  const base = headersWithoutAuthorization(headers) ?? {}
  const trimmed = token.trim()
  if (!trimmed) {
    return Object.keys(base).length > 0 ? base : undefined
  }
  return { ...base, [AUTH_HEADER]: `${BEARER_PREFIX}${trimmed}` }
}

/** Short FNV-1a hex digest so distinct URLs that share a host/path prefix do not collide. */
function shortUrlHash(input: string): string {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** Stable id for a remote MCP URL (marketplace package id). */
export function remoteMcpIdFromUrl(url: string, fallbackName?: string): string {
  const trimmed = url.trim()
  try {
    const u = new URL(trimmed)
    const host = u.hostname.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase()
    const path = u.pathname
      .replace(/^\//, '')
      .replace(/\/$/, '')
      .replace(/[^a-zA-Z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24)
    const base = path ? `${host}-${path}` : host
    const hash = shortUrlHash(`${u.origin}${u.pathname}${u.search}`)
    const id = `remote-${base}-${hash}`.replace(/-+/g, '-').slice(0, 64)
    if (id.includes('__')) return `remote-${host}-${hash}`.slice(0, 64)
    return id || `remote-mcp-${hash}`
  } catch {
    const slug = (fallbackName ?? 'mcp')
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 32)
    const hash = shortUrlHash(trimmed || slug)
    return `remote-${slug || 'mcp'}-${hash}`.slice(0, 64)
  }
}
