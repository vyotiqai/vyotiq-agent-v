import { createHash, createHmac } from 'crypto'

/** Static AWS credentials: an access key pair, plus a session token for temporary keys. */
export type AwsCredentials = {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export type AwsSignInput = {
  method: string
  url: string
  /** Headers the request will carry; all of them are signed. */
  headers: Record<string, string>
  body: string
  region: string
  service: string
  credentials: AwsCredentials
  /** Signing time; the default is now. */
  now?: Date
}

const ALGORITHM = 'AWS4-HMAC-SHA256'

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** RFC 3986 encoding: everything but unreserved characters, `~` kept. */
function rfc3986(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

/**
 * Canonical path for every service but S3: each segment of the path as sent
 * (already percent-encoded once) is encoded again, which is what AWS and its
 * SDKs sign. A Bedrock model id `anthropic.claude-v2:1` travels as `%3A` and
 * is signed as `%253A`.
 */
function canonicalPath(pathname: string): string {
  if (!pathname || pathname === '/') return '/'
  return pathname
    .split('/')
    .map((segment) => rfc3986(segment))
    .join('/')
}

function canonicalQuery(search: URLSearchParams): string {
  const pairs: Array<[string, string]> = []
  for (const [k, v] of search) pairs.push([rfc3986(k), rfc3986(v)])
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

function amzTimestamps(now: Date): { amzDate: string; dateStamp: string } {
  const iso = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
  return { amzDate: iso, dateStamp: iso.slice(0, 8) }
}

/**
 * Sign a request with AWS Signature Version 4 and return the headers to send:
 * the input headers plus `host`, `x-amz-date`, `x-amz-security-token` (for
 * temporary keys) and `authorization`. Sign once per attempt — a signature is
 * only accepted for five minutes around its `x-amz-date`.
 */
export function signAwsRequest(input: AwsSignInput): Record<string, string> {
  const url = new URL(input.url)
  const { amzDate, dateStamp } = amzTimestamps(input.now ?? new Date())

  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value
  headers.host = url.host
  headers['x-amz-date'] = amzDate
  if (input.credentials.sessionToken) {
    headers['x-amz-security-token'] = input.credentials.sessionToken
  }
  delete headers.authorization

  const names = Object.keys(headers).sort()
  const canonicalHeaders = names
    .map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`)
    .join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    input.method.toUpperCase(),
    canonicalPath(url.pathname),
    canonicalQuery(url.searchParams),
    canonicalHeaders,
    signedHeaders,
    sha256Hex(input.body)
  ].join('\n')

  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`
  const stringToSign = [ALGORITHM, amzDate, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${input.credentials.secretAccessKey}`, dateStamp)
  const kRegion = hmac(kDate, input.region)
  const kService = hmac(kRegion, input.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  headers.authorization =
    `${ALGORITHM} Credential=${input.credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`
  return headers
}
