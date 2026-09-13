/**
 * PII / secret scrubbing for logs and optional Sentry payloads.
 * Shared so unit tests can cover redaction without Electron.
 */

const API_KEY_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-or-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bgsk_[A-Za-z0-9_-]{8,}\b/g,
  // Modal proxy token, combined form wk-<id>.ws-<secret> (modal.com Shared Endpoints)
  /\bwk-[A-Za-z0-9_-]{4,}\.ws-[A-Za-z0-9_-]{4,}\b/g,
  /\bBearer\s+[A-Za-z0-9._\-+=/]{8,}/gi,
  /\b(?:Authorization|X-Api-Key)\s*[:=]\s*[^\s,;]+/gi,
  /\bapi[_-]?key["']?\s*[:=]\s*["']?[^\s"',}&}]+/gi,
  /\b(?:access[_-]?token|refresh[_-]?token|session[_-]?token|client[_-]?secret|token)["']?\s*[:=]\s*["']?[^\s"',}&}]+/gi,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
  // OpenAI-style masked key echo in error messages
  /Incorrect API key provided:\s*[A-Za-z0-9*_./+=-]{6,}/gi
]

const DATA_URL_RE = /data:(?:image|audio|application)\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]+/gi
const COOKIE_RE = /\b(?:cookie|set-cookie)\s*[:=]\s*[^\n;]+/gi
const PEM_RE =
  /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/g

/** Absolute paths → basename only (keeps filenames, drops user home / drive letters). */
export function scrubPath(value: string): string {
  const normalized = value.replace(/\\/g, '/')
  const parts = normalized.split('/').filter(Boolean)
  if (parts.length === 0) return value
  // Windows drive or absolute POSIX / UNC
  const looksAbsolute =
    /^[A-Za-z]:/.test(value) || value.startsWith('/') || value.startsWith('\\\\')
  if (!looksAbsolute) return value
  return parts[parts.length - 1] ?? value
}

export function scrubString(input: string): string {
  let out = input
  // Reset lastIndex — global patterns are reused across calls
  PEM_RE.lastIndex = 0
  DATA_URL_RE.lastIndex = 0
  COOKIE_RE.lastIndex = 0
  out = out.replace(PEM_RE, '[redacted-pem]')
  out = out.replace(DATA_URL_RE, 'data:[redacted]')
  out = out.replace(COOKIE_RE, '[redacted-cookie]')
  for (const re of API_KEY_PATTERNS) {
    re.lastIndex = 0
    out = out.replace(re, '[redacted]')
  }
  // Absolute path-like segments in free text (best-effort). Capture through
  // spaces so a path like `C:\Users\John Doe\AppData\...` is matched whole
  // (its basename, e.g. a filename, is kept while the username segment is
  // dropped) instead of stopping at the first space and leaking `John`.
  out = out.replace(/(?:[A-Za-z]:\\|\\\\|\/(?:Users|home|root)\/)[\w \\/.-]*/g, (m) =>
    scrubPath(m)
  )
  return out
}

const SENSITIVE_KEYS = new Set([
  'authorization',
  'x-api-key',
  'xapikey',
  'apikey',
  'api_key',
  'key',
  'secret',
  'password',
  'token',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'sessiontoken',
  'session_token',
  'clientsecret',
  'client_secret',
  'privatekey',
  'private_key',
  'dsn',
  'cookie',
  'set-cookie',
  'contents',
  'content',
  'body',
  'messages',
  'prompt',
  'image',
  'images',
  'url',
  'dataurl',
  'data_url'
])

const PATH_KEYS = new Set([
  'path',
  'workspacepath',
  'filepath',
  'cwd',
  'dir',
  'directory',
  'logfile',
  'logpath'
])

/**
 * Substring fragments that indicate a secret-bearing key. Exact-match
 * `SENSITIVE_KEYS` misses common names like `accessKey`, `secretKey`,
 * `clientSecretId`, `dbPassword`, `privateKeyPem`, `apiKeySecret`. We match
 * those by fragment while avoiding over-broad fragments (e.g. `auth` would also
 * hit `author`).
 */
const SENSITIVE_KEY_SUBSTRINGS = [
  'secret',
  'token',
  'password',
  'passwd',
  'privatekey',
  'private_key',
  'apikey',
  'api_key',
  'credential',
  'cred',
  'accesskey',
  'access_key',
  'dsn'
]

function isSensitiveKey(lower: string): boolean {
  if (SENSITIVE_KEYS.has(lower)) return true
  return SENSITIVE_KEY_SUBSTRINGS.some((s) => lower.includes(s))
}

/** Log fields that may keep semantic path hints without full home paths. */
const SEMANTIC_PATH_KEYS = new Set(['logsdir'])

function isErrorLike(value: object): value is Error {
  return (
    value instanceof Error ||
    (typeof (value as { message?: unknown }).message === 'string' &&
      typeof (value as { name?: unknown }).name === 'string' &&
      (value as { name: string }).name.endsWith('Error'))
  )
}

/**
 * Serialize Error / AppError without relying on enumerable own keys
 * (Error.message / stack are typically non-enumerable).
 */
function scrubErrorLike(value: Error, depth: number, seen: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    name: value.name,
    message: scrubString(value.message)
  }
  if (typeof value.stack === 'string') {
    out.stack = scrubString(value.stack)
  }
  const rec = value as Error & Record<string, unknown>
  for (const k of [
    'code',
    'severity',
    'retriable',
    'correlationId',
    'context',
    'syscall',
    'address',
    'port',
    'errno'
  ] as const) {
    if (k in rec && rec[k] !== undefined) {
      out[k] = scrubValue(rec[k], depth + 1, seen)
    }
  }
  if (value.cause !== undefined) {
    out.cause = scrubValue(value.cause, depth + 1, seen)
  }
  return out
}

export function scrubValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (depth > 6) return '[truncated]'
  if (value == null) return value
  if (typeof value === 'string') return scrubString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return String(value)
  if (typeof value === 'symbol' || typeof value === 'function') return String(value)
  if (typeof value === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    if (Array.isArray(value)) return value.map((v) => scrubValue(v, depth + 1, seen))
    if (isErrorLike(value)) {
      return scrubErrorLike(value, depth, seen)
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const lower = k.toLowerCase()
      if (SENSITIVE_KEYS.has(k) || isSensitiveKey(lower)) {
        out[k] = '[redacted]'
        continue
      }
      if (PATH_KEYS.has(lower)) {
        out[k] = typeof v === 'string' ? scrubPath(v) : scrubValue(v, depth + 1, seen)
        continue
      }
      if (SEMANTIC_PATH_KEYS.has(lower) && typeof v === 'string') {
        out[k] = v.replace(/\\/g, '/').replace(/^.*\/vyotiq\//i, 'vyotiq/')
        continue
      }
      out[k] = scrubValue(v, depth + 1, seen)
    }
    return out
  }
  return String(value)
}

/** Deep-clone + scrub an event-like object for Sentry beforeSend. */
export function scrubEventLike<T extends Record<string, unknown>>(event: T): T {
  return scrubValue(event) as T
}
