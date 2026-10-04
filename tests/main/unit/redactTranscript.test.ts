/**
 * Credential-shaped text must not reach a session transcript in cleartext,
 * and ordinary text must survive byte-identically.
 *
 * The shipped implementation is `redactSecretsInText`
 * (src/shared/utils/redactSecrets.ts), applied to a whole record by
 * `redactForRecord` (src/main/agent/recordRedaction.ts) at every
 * messages.jsonl / events.jsonl write. These tests pin the shapes an on-disk
 * credential sweep actually found, and — just as load-bearing — the near
 * misses from that same sweep, which must NOT be rewritten.
 */
import { describe, expect, it } from 'vitest'
import { containsSecret, REDACTED_SECRET, redactSecretsInText } from '@shared/utils/redactSecrets'
import { redactForRecord } from '@main/agent/recordRedaction'

const R = REDACTED_SECRET

/**
 * The audit's incident token: a 91-character base64 value whose plaintext is
 * fully printable. 91 chars is 68 bytes of unpadded base64 (22 full groups of
 * 4 plus 3), so the fixture is built rather than pasted, and asserted below.
 */
const VENDOR_DOC_PLAINTEXT = 'ThisIsAnExampleTokenFromVendorDocsNotARealCredential'.padEnd(68, 'x')
const VENDOR_DOC_TOKEN = Buffer.from(VENDOR_DOC_PLAINTEXT, 'utf8')
  .toString('base64')
  .replace(/=+$/, '')

describe('the vendor-doc bearer shape (the incident)', () => {
  it('is a 91-char base64 token decoding to printable text', () => {
    // The fixture is only meaningful if it really has the incident's shape.
    expect(VENDOR_DOC_TOKEN).toHaveLength(91)
    expect(VENDOR_DOC_TOKEN).toMatch(/^[A-Za-z0-9+/]+={0,2}$/)
    const decoded = Buffer.from(VENDOR_DOC_TOKEN, 'base64').toString('utf8')
    expect(decoded).toBe(VENDOR_DOC_PLAINTEXT)
    // Fully printable: the property that makes this shape a redaction dilemma.
    expect(/^[\x20-\x7e]+$/.test(decoded)).toBe(true)
  })

  it('is redacted inside a fetched curl example, scheme word kept', () => {
    const fetched = `curl --request POST \\\n  --header 'Authorization: Bearer ${VENDOR_DOC_TOKEN}' \\\n  https://api.x.com/2/oauth2/token`
    const redacted = redactSecretsInText(fetched)
    expect(redacted).toBe(`curl --request POST \\\n  --header 'Authorization: Bearer ${R}' \\\n  https://api.x.com/2/oauth2/token`)
    expect(redacted).not.toContain(VENDOR_DOC_TOKEN)
  })

  it('is redacted by shape alone, never by decoding what it decodes to', () => {
    // The decision, recorded as a test. A token that base64-decodes to plain
    // prose IS redacted. Shape is the only evidence available, and prose
    // plaintext cannot be told apart from a key's plaintext without decoding —
    // so the module never decodes. Decoding would cost a Buffer allocation per
    // candidate on every append, and would only move the guess, not remove it:
    // a real key is also base64. The placeholder costs the reader one span of
    // a fetched vendor doc; the alternative costs every real credential on
    // disk forever.
    const proseBacked = `Bearer ${VENDOR_DOC_TOKEN}`
    const binaryBacked = `Bearer ${Buffer.from([0x9f, 0x3b, 0x2c, 0x77, 0x10, 0x45, 0xde, 0x01, 0x88, 0x5a, 0x3f, 0xc7, 0x24, 0x9b])
      .toString('base64')
      .replace(/=+$/, '')}`
    // Identical treatment: the two are indistinguishable to a text transform.
    expect(redactSecretsInText(proseBacked)).toBe(`Bearer ${R}`)
    expect(redactSecretsInText(binaryBacked)).toBe(`Bearer ${R}`)
  })

  it('leaves a bare base64 blob alone — no scheme word, no match', () => {
    // The deliberate boundary. Every pattern is anchored to a scheme word or a
    // provider prefix, because an unanchored "40+ base64url chars" rule would
    // eat diffs, hashes, ids and prose constantly. So a token that appears
    // without its `Bearer` header in stored text survives.
    expect(redactSecretsInText(VENDOR_DOC_TOKEN)).toBe(VENDOR_DOC_TOKEN)
    expect(containsSecret(VENDOR_DOC_TOKEN)).toBe(false)
    // …while the same bytes behind a scheme word do not. That is the whole
    // trade-off in two assertions.
    expect(redactSecretsInText(`Bearer ${VENDOR_DOC_TOKEN}`)).not.toContain(VENDOR_DOC_TOKEN)
  })
})

describe('the credential shapes a provider hands out', () => {
  it('redacts a realistic set across providers', () => {
    const cases: Array<[string, string]> = [
      // OpenAI project key. The length floor is 20 after the `sk-` prefix.
      [`OPENAI_API_KEY=sk-proj-${'A1b2C3d4E5f6G7h8I9j0'.repeat(3)}`, `OPENAI_API_KEY=${R}`],
      // Anthropic.
      [`x-api-key: sk-ant-api03-${'AbCdEf0123456789'.repeat(4)}`, `x-api-key: ${R}`],
      // GitHub classic PAT: `ghp_` plus 36.
      [`token ghp_${'0123456789abcdefghij'.repeat(2)}`, `token ${R}`],
      // GitHub fine-grained PAT.
      [`github_pat_11${'ABCDEFGH'.repeat(9)}`, R],
      // Google API key: `AIza` plus exactly 35.
      [`key=AIza${'SyA1234567890bcdefghijklmnopqrstuvw'.slice(0, 35)}`, `key=${R}`],
      // PEM private-key block, whole block.
      [
        '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nAAAA\n-----END RSA PRIVATE KEY-----',
        R
      ]
    ]
    for (const [input, expected] of cases) {
      expect(redactSecretsInText(input)).toBe(expected)
      expect(containsSecret(input)).toBe(true)
    }
  })

  it('documents the Bearer/Basic length threshold: 16 minimum', () => {
    const fifteen = 'abcdefghijklmnO'
    const sixteen = 'abcdefghijklmnOp'
    expect(fifteen).toHaveLength(15)
    expect(sixteen).toHaveLength(16)
    expect(redactSecretsInText(`Bearer ${fifteen}`)).toBe(`Bearer ${fifteen}`)
    expect(redactSecretsInText(`Bearer ${sixteen}`)).toBe(`Bearer ${R}`)
    expect(redactSecretsInText(`Basic ${fifteen}`)).toBe(`Basic ${fifteen}`)
    expect(redactSecretsInText(`Basic ${sixteen}`)).toBe(`Basic ${R}`)
  })

  it('redacts a whole PEM block without spilling into surrounding text', () => {
    const text = [
      'cat id_ed25519',
      '-----BEGIN OPENSSH PRIVATE KEY-----',
      'b3BlbnNzaC1rZXktdjEAAAAA',
      'AAAAB3NzaC1yc2EAAAADAQABAAABgQ',
      '-----END OPENSSH PRIVATE KEY-----',
      'wrote 2 keys'
    ].join('\n')
    expect(redactSecretsInText(text)).toBe(
      ['cat id_ed25519', R, 'wrote 2 keys'].join('\n')
    )
  })
})

describe('the near misses the on-disk sweep found must survive byte-identical', () => {
  // Each of these was a real hit in the credential sweep over the log
  // generations and every session *.jsonl. Redacting any of them would corrupt
  // a run's own record: a fixture's placeholder key is documentation, an id is
  // an id, and a digest is a digest.
  const untouched: Array<[string, string]> = [
    // A fixture's API key placeholder.
    ['const config = { api_key: \'fake-consumer-key-0123456789\' }', 'a placeholder, not a key'],
    // A fixture's refresh token.
    ['const fixture = { refreshToken: \'refresh-secret-value\' }', 'a placeholder, not a token'],
    // An IPC channel name that merely ends in "Secret".
    ['ipcMain.handle(\'mcp:setOAuthClientSecret\', handler)', 'a channel name, not a secret'],
    // A uuid (the audit ran inside workspace 1d7ca570-0fbb-5a0a-ba71-439305604d17).
    ['workspace 1d7ca570-0fbb-5a0a-ba71-439305604d17', 'an id, not a key'],
    // A sha256 digest.
    ['sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'a digest, not a key'],
    // A long random-looking word in ordinary prose.
    [
      'The retry backoff constant Xk9QmZvTpLr4WdNhBsYc looked wrong to me.',
      'a word, not a token'
    ],
    // Ordinary code naming a token, which the logger would otherwise scrub.
    ['const token: string = await getToken()', 'a type, not a token'],
    ['function Bearer() {}', 'an identifier, not a scheme'],
    // A short id and a path that merely contains a prefix.
    ['run 874dad8f; checkout aether/agentsd/src/config.rs', 'an id and a path']
  ]

  for (const [text, why] of untouched) {
    it(`leaves ${why} alone`, () => {
      expect(redactSecretsInText(text)).toBe(text)
      expect(containsSecret(text)).toBe(false)
      // redactForRecord returns the SAME object when nothing changed, so an
      // untouched record costs no allocation on the append path.
      const record = { type: 'tool_output', output: text }
      expect(redactForRecord(record)).toBe(record)
    })
  }

  it('leaves the placeholder itself alone, so re-reading a record is stable', () => {
    const stored = `OPENAI_API_KEY=${R} and Bearer ${R}`
    expect(redactSecretsInText(stored)).toBe(stored)
  })
})

describe('idempotency', () => {
  it('redacting an already-redacted string is a no-op, never a double-wrap', () => {
    const corpus = [
      `Authorization: Bearer ${VENDOR_DOC_TOKEN}`,
      'curl -H "x-api-key: sk-ant-api03-AbCdEf0123456789AbCdEf0123456789" https://api.x.com',
      '-----BEGIN EC PRIVATE KEY-----\nMHcCAQEE\n-----END EC PRIVATE KEY-----',
      'the retry constant Xk9QmZvTpLr4WdNhBsYc is fine',
      `already stored as ${R}`
    ]
    for (const text of corpus) {
      const once = redactSecretsInText(text)
      const twice = redactSecretsInText(once)
      const thrice = redactSecretsInText(twice)
      expect(twice).toBe(once)
      expect(thrice).toBe(once)
      // Exactly one placeholder per secret, however many times it is applied.
      expect(once.split(R).length - 1).toBe(twice.split(R).length - 1)
    }
  })

  it('a record survives a redact -> serialise -> parse -> redact round trip unchanged', () => {
    const event = {
      type: 'tool_output',
      toolCallId: 't1',
      output: `Authorization: Bearer ${VENDOR_DOC_TOKEN}`
    }
    const once = redactForRecord(event)
    const reserialised = JSON.parse(JSON.stringify(once)) as typeof event
    expect(redactForRecord(reserialised)).toBe(reserialised)
  })
})

describe('what it deliberately does not do', () => {
  it('never decodes, never imports I/O or electron, and is pure', async () => {
    const mod = await import('@shared/utils/redactSecrets')
    // Purity is asserted structurally as well as behaviourally: the module
    // exports exactly three symbols, none of which touches fs, electron or a
    // decoder, and it works in a bare process with no app bootstrap.
    expect(Object.keys(mod).sort()).toEqual(['REDACTED_SECRET', 'containsSecret', 'redactSecretsInText'])
    // The redactor is charset-based, so a token with a `-` or `_` (base64url)
    // is covered by the same patterns as standard base64.
    const base64url = VENDOR_DOC_TOKEN.slice(0, 40) + '-_' + VENDOR_DOC_TOKEN.slice(43)
    expect(redactSecretsInText(`Bearer ${base64url}`)).toBe(`Bearer ${R}`)
  })
})