import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createVerify, generateKeyPairSync } from 'crypto'
import { createServer, type Server } from 'http'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  adcCredentialsPath,
  googleAccessToken,
  parseGoogleCredentials,
  readAdcCredentials,
  resetGoogleAuthForTests,
  signServiceAccountJwt,
  type GoogleServiceAccount
} from '@main/agent/providers/google/googleAuth'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const SA: GoogleServiceAccount = {
  type: 'service_account',
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'kid-1',
  project_id: 'proj'
}

let server: Server
let tokenUrl = ''
const forms: URLSearchParams[] = []
let issued = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      forms.push(new URLSearchParams(body))
      if (body.includes('refresh_token=bad')) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end('{"error":"invalid_grant","error_description":"Token has been expired or revoked."}')
        return
      }
      issued += 1
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ access_token: `tok-${issued}`, expires_in: 3600, token_type: 'Bearer' }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const addr = server.address()
  tokenUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/token`
})

afterAll(() => server.close())

beforeEach(() => {
  resetGoogleAuthForTests()
  forms.length = 0
  issued = 0
})

describe('Google credentials', () => {
  it('parses a service-account key and a gcloud login, and names what is missing', () => {
    expect(parseGoogleCredentials(JSON.stringify(SA))).toMatchObject({ type: 'service_account', project_id: 'proj' })
    expect(
      parseGoogleCredentials('{"type":"authorized_user","client_id":"c","client_secret":"s","refresh_token":"r"}')
    ).toMatchObject({ type: 'authorized_user' })
    expect(parseGoogleCredentials('{"type":"service_account","client_email":"x"}')).toEqual({
      error: expect.stringMatching(/private_key/)
    })
    expect(parseGoogleCredentials('{"type":"external_account"}')).toEqual({ error: expect.stringMatching(/not supported/) })
    expect(parseGoogleCredentials('nope')).toEqual({ error: expect.stringMatching(/not valid JSON/) })
  })

  it('signs a JWT that verifies with the key pair and carries the right claims', () => {
    const jwt = signServiceAccountJwt(SA, 'https://oauth2.googleapis.com/token', 1_700_000_000)
    const [h, p, sig] = jwt.split('.')
    const verified = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, 'base64url'))
    expect(verified).toBe(true)
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as Record<string, unknown>
    expect(decode(h!)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' })
    expect(decode(p!)).toEqual({
      iss: SA.client_email,
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600
    })
  })

  it('trades a service-account JWT for a token, caches it, and refreshes near expiry', async () => {
    let now = 1_700_000_000_000
    const opts = { tokenUrl, now: () => now }
    expect(await googleAccessToken(SA, opts)).toBe('tok-1')
    expect(forms[0]!.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer')
    expect(forms[0]!.get('assertion')!.split('.')).toHaveLength(3)

    now += 30 * 60_000
    expect(await googleAccessToken(SA, opts)).toBe('tok-1')
    expect(forms).toHaveLength(1)

    now += 26 * 60_000 // 56 min: inside the five-minute margin
    expect(await googleAccessToken(SA, opts)).toBe('tok-2')
  })

  it('shares one request between concurrent callers', async () => {
    const [a, b] = await Promise.all([googleAccessToken(SA, { tokenUrl }), googleAccessToken(SA, { tokenUrl })])
    expect([a, b]).toEqual(['tok-1', 'tok-1'])
    expect(forms).toHaveLength(1)
  })

  it('uses a gcloud refresh token, and reports Google refusing it', async () => {
    const user = { type: 'authorized_user' as const, client_id: 'c', client_secret: 's', refresh_token: 'good' }
    expect(await googleAccessToken(user, { tokenUrl })).toBe('tok-1')
    expect(Object.fromEntries(forms[0]!)).toEqual({
      grant_type: 'refresh_token',
      client_id: 'c',
      client_secret: 's',
      refresh_token: 'good'
    })
    await expect(googleAccessToken({ ...user, refresh_token: 'bad' }, { tokenUrl })).rejects.toThrow(
      /Google sign-in failed.*(expired or revoked|invalid_grant)/
    )
  })

  it('finds the ADC file where gcloud writes it, and reports a missing one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-adc-'))
    try {
      const file = join(dir, 'adc.json')
      expect(readAdcCredentials({ GOOGLE_APPLICATION_CREDENTIALS: file })).toMatchObject({
        error: expect.stringMatching(/gcloud auth application-default login/)
      })
      writeFileSync(file, '{"type":"authorized_user","client_id":"c","client_secret":"s","refresh_token":"r"}')
      expect(readAdcCredentials({ GOOGLE_APPLICATION_CREDENTIALS: file })).toMatchObject({
        path: file,
        credentials: { type: 'authorized_user' }
      })
      if (process.platform === 'win32') {
        expect(adcCredentialsPath({ APPDATA: 'C:\\Roaming' })).toBe('C:\\Roaming\\gcloud\\application_default_credentials.json')
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
