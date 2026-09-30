import { createSign } from 'crypto'
import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { fetchWithRetry } from '../fetchWithRetry'
import { formatProviderHttpError } from '../httpErrors'
import { VERTEX_ADC_MARKER } from '../../../../shared/domain/cloudProviders'

export { VERTEX_ADC_MARKER }

/**
 * Google Cloud access tokens for Vertex AI, minted from what a person
 * already has: a service-account key file, or the Application Default
 * Credentials `gcloud auth application-default login` writes. No Google SDK —
 * a service account signs an RS256 JWT and trades it for a token; a gcloud
 * login trades its refresh token.
 */

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform'
/** Refresh this long before the token's stated expiry. */
const EXPIRY_MARGIN_MS = 5 * 60_000

export type GoogleServiceAccount = {
  type: 'service_account'
  client_email: string
  private_key: string
  private_key_id?: string
  project_id?: string
}

export type GoogleAuthorizedUser = {
  type: 'authorized_user'
  client_id: string
  client_secret: string
  refresh_token: string
  quota_project_id?: string
}

export type GoogleCredentials = GoogleServiceAccount | GoogleAuthorizedUser


/** Parse credential JSON, or return why it can't be used. */
export function parseGoogleCredentials(raw: string): GoogleCredentials | { error: string } {
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    return { error: 'The credentials are not valid JSON.' }
  }
  if (!json || typeof json !== 'object') return { error: 'The credentials are not a JSON object.' }
  const o = json as Record<string, unknown>
  const str = (k: string) => (typeof o[k] === 'string' && (o[k] as string).trim() ? (o[k] as string) : null)
  if (o.type === 'service_account') {
    const email = str('client_email')
    const key = str('private_key')
    if (!email || !key) return { error: 'The service-account key is missing client_email or private_key.' }
    return {
      type: 'service_account',
      client_email: email,
      private_key: key,
      ...(str('private_key_id') ? { private_key_id: str('private_key_id')! } : {}),
      ...(str('project_id') ? { project_id: str('project_id')! } : {})
    }
  }
  if (o.type === 'authorized_user') {
    const id = str('client_id')
    const secret = str('client_secret')
    const refresh = str('refresh_token')
    if (!id || !secret || !refresh) {
      return { error: 'The gcloud login is missing client_id, client_secret or refresh_token.' }
    }
    return {
      type: 'authorized_user',
      client_id: id,
      client_secret: secret,
      refresh_token: refresh,
      ...(str('quota_project_id') ? { quota_project_id: str('quota_project_id')! } : {})
    }
  }
  if (o.type === 'external_account' || o.type === 'impersonated_service_account') {
    return { error: `${String(o.type)} credentials are not supported yet — use a service-account key or a gcloud login.` }
  }
  return { error: 'This is not a Google service-account key or gcloud login.' }
}

/** Where gcloud keeps Application Default Credentials on this computer. */
export function adcCredentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.GOOGLE_APPLICATION_CREDENTIALS?.trim()
  if (explicit) return explicit
  if (process.platform === 'win32') {
    const appData = env.APPDATA?.trim() || join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'gcloud', 'application_default_credentials.json')
  }
  const configHome = env.CLOUDSDK_CONFIG?.trim() || join(homedir(), '.config', 'gcloud')
  return join(configHome, 'application_default_credentials.json')
}

/** Read this computer's ADC file, or say why it can't be used. */
export function readAdcCredentials(
  env: NodeJS.ProcessEnv = process.env
): { credentials: GoogleCredentials; path: string } | { error: string; path: string } {
  const path = adcCredentialsPath(env)
  if (!existsSync(path)) {
    return { path, error: 'No Google Cloud login on this computer. Run `gcloud auth application-default login`, or paste a service-account key.' }
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    return { path, error: `Couldn't read ${path}: ${(err as Error).message}` }
  }
  const parsed = parseGoogleCredentials(raw)
  return 'error' in parsed ? { path, error: parsed.error } : { path, credentials: parsed }
}

/** Resolve the Vertex secret (key JSON or the ADC marker) to credentials. */
export function resolveVertexCredentials(secret: string | null | undefined): GoogleCredentials | { error: string } {
  const raw = secret?.trim()
  if (!raw) return { error: 'Vertex AI is not set up.' }
  if (raw === VERTEX_ADC_MARKER) {
    const adc = readAdcCredentials()
    return 'error' in adc ? { error: adc.error } : adc.credentials
  }
  return parseGoogleCredentials(raw)
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
}

/** An RS256-signed assertion a service account trades for an access token. */
export function signServiceAccountJwt(
  sa: GoogleServiceAccount,
  audience: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = { alg: 'RS256', typ: 'JWT', ...(sa.private_key_id ? { kid: sa.private_key_id } : {}) }
  const claims = {
    iss: sa.client_email,
    scope: CLOUD_PLATFORM_SCOPE,
    aud: audience,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  }
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`
  const signature = createSign('RSA-SHA256').update(unsigned).sign(sa.private_key)
  return `${unsigned}.${base64url(signature)}`
}

type CachedToken = { token: string; expiresAt: number }
const tokenCache = new Map<string, CachedToken>()
const inFlight = new Map<string, Promise<string>>()

function cacheKey(creds: GoogleCredentials): string {
  return creds.type === 'service_account'
    ? `sa:${creds.client_email}:${creds.private_key_id ?? ''}`
    : `user:${creds.client_id}:${creds.refresh_token.slice(-12)}`
}

export type GoogleTokenOptions = {
  signal?: AbortSignal
  /** Tests point this at a local server; production always uses Google's. */
  tokenUrl?: string
  now?: () => number
}

/** A cached or freshly minted cloud-platform access token. */
export async function googleAccessToken(
  creds: GoogleCredentials,
  opts: GoogleTokenOptions = {}
): Promise<string> {
  const now = opts.now ?? Date.now
  const key = cacheKey(creds)
  const cached = tokenCache.get(key)
  if (cached && cached.expiresAt - EXPIRY_MARGIN_MS > now()) return cached.token
  const pending = inFlight.get(key)
  if (pending) return pending
  const tokenUrl = opts.tokenUrl ?? GOOGLE_TOKEN_URL
  const job = (async () => {
    const form = new URLSearchParams(
      creds.type === 'service_account'
        ? {
            grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
            assertion: signServiceAccountJwt(creds, GOOGLE_TOKEN_URL, Math.floor(now() / 1000))
          }
        : {
            grant_type: 'refresh_token',
            client_id: creds.client_id,
            client_secret: creds.client_secret,
            refresh_token: creds.refresh_token
          }
    )
    const res = await fetchWithRetry(
      tokenUrl,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: opts.signal
      },
      { circuitKey: false }
    )
    const text = await res.text().catch(() => '')
    if (!res.ok) {
      throw new Error(`Google sign-in failed: ${formatProviderHttpError(res.status, text)}`)
    }
    let body: { access_token?: unknown; expires_in?: unknown }
    try {
      body = JSON.parse(text) as typeof body
    } catch {
      throw new Error('Google sign-in returned something that is not JSON.')
    }
    if (typeof body.access_token !== 'string' || !body.access_token) {
      throw new Error('Google sign-in returned no access token.')
    }
    const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
    tokenCache.set(key, { token: body.access_token, expiresAt: now() + ttl * 1000 })
    return body.access_token
  })()
  inFlight.set(key, job)
  try {
    return await job
  } finally {
    inFlight.delete(key)
  }
}

/** Forget a token Google rejected (401), so the next call mints a new one. */
export function dropGoogleAccessToken(creds: GoogleCredentials): void {
  tokenCache.delete(cacheKey(creds))
}

export function resetGoogleAuthForTests(): void {
  tokenCache.clear()
  inFlight.clear()
}
