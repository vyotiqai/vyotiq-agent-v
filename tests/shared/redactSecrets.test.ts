import { describe, expect, it } from 'vitest'
import { containsSecret, REDACTED_SECRET, redactSecretsInText } from '@shared/utils/redactSecrets'

const R = REDACTED_SECRET

describe('redactSecretsInText', () => {
  it('replaces provider, platform and cloud keys', () => {
    const cases: Array<[string, string]> = [
      ['OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz0123', `OPENAI_API_KEY=${R}`],
      ['key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA end', `key ${R} end`],
      ['AIzaSyA1234567890abcdefghijklmnopqrstuv', R],
      ['ghp_0123456789abcdefghijklmnopqrstuvwxyzAB', R],
      ['github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ', R],
      ['xoxb-1234567890-abcdefghij', R],
      ['aws_access_key_id = AKIAIOSFODNN7EXAMPLE', `aws_access_key_id = ${R}`],
      ['glpat-abcdefghijklmnopqrst', R],
      // Joined at run time so secret scanning does not take it for a live Stripe key.
      [['sk', 'live', 'abcdefghijklmnopqrstuvwx'].join('_'), R],
      ['Authorization: Bearer abcdefghijklmnop.qrstuv', `Authorization: Bearer ${R}`],
      ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', R]
    ]
    for (const [input, expected] of cases) expect(redactSecretsInText(input)).toBe(expected)
  })

  it('removes a whole private-key block', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAA\n-----END OPENSSH PRIVATE KEY-----'
    expect(redactSecretsInText(`key:\n${pem}\ndone`)).toBe(`key:\n${R}\ndone`)
  })

  it('leaves ordinary code, paths, short ids and attachments alone', () => {
    const plain = [
      'const token: string = getToken()',
      'C:\\Users\\me\\project\\src\\sk-helpers.ts',
      'task-list sk-short',
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB',
      'function Bearer() {}',
      'eyJhbGci only one part'
    ]
    for (const text of plain) {
      expect(redactSecretsInText(text)).toBe(text)
      expect(containsSecret(text)).toBe(false)
    }
  })

  it('keeps JSON parseable when redacting inside a string value', () => {
    const args = JSON.stringify({ command: 'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" https://api.example.com' })
    const redacted = redactSecretsInText(args)
    expect(() => JSON.parse(redacted)).not.toThrow()
    expect((JSON.parse(redacted) as { command: string }).command).toContain(`Bearer ${R}`)
  })
})
