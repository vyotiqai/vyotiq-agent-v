import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = join(tmpdir(), `vyotiq-secrets-${process.pid}-${Date.now()}`)

const counters = vi.hoisted(() => ({ decryptCalls: 0 }))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`),
    decryptString: (buf: Buffer) => {
      counters.decryptCalls++
      const text = buf.toString()
      return text.startsWith('enc:') ? text.slice(4) : text
    }
  }
}))

import {
  clearGoogleMcpClientSecret,
  clearMcpOAuthClientSecret,
  clearSecret,
  getGoogleMcpClientSecret,
  getMcpOAuthClientSecret,
  hasGoogleMcpClientSecret,
  hasMcpOAuthClientSecret,
  secretStatus,
  setGoogleMcpClientSecret,
  setMcpOAuthClientSecret,
  setSecret
} from '@main/settings/secrets'

const secretsFile = join(userData, 'secrets.json')

beforeEach(() => {
  mkdirSync(userData, { recursive: true })
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('secrets store', () => {
  it('refuses mutations and keeps a malformed on-disk file', () => {
    const malformed = '{not-json'
    writeFileSync(secretsFile, malformed, 'utf8')

    expect(() => setSecret('openai', 'sk-test')).toThrow(/on-disk file was left unchanged/)
    expect(readFileSync(secretsFile, 'utf8')).toBe(malformed)
    expect(secretStatus().loadError).toBe(true)

    expect(() => clearSecret('openai')).toThrow(/on-disk file was left unchanged/)
    expect(readFileSync(secretsFile, 'utf8')).toBe(malformed)
  })

  it('refuses mutations when JSON is not a string-to-string record', () => {
    const invalid = JSON.stringify({ openai: 123 })
    writeFileSync(secretsFile, invalid, 'utf8')

    expect(() => setSecret('openai', 'sk-test')).toThrow(/on-disk file was left unchanged/)
    expect(readFileSync(secretsFile, 'utf8')).toBe(invalid)
    expect(secretStatus().loadError).toBe(true)
  })

  it('writes a valid string-to-string record', () => {
    setSecret('openai', 'sk-test')
    const parsed = JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>
    expect(typeof parsed.openai).toBe('string')
    expect(parsed.openai.length).toBeGreaterThan(0)
    expect(secretStatus().loadError).toBeUndefined()
  })

  it('stores MCP OAuth client secrets without writing plaintext', () => {
    setMcpOAuthClientSecret('gmail', 'google-secret')
    expect(hasMcpOAuthClientSecret('gmail')).toBe(true)
    expect(getMcpOAuthClientSecret('gmail')).toBe('google-secret')
    const parsedSecrets = JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>
    expect(JSON.stringify(parsedSecrets)).not.toContain('google-secret')
    clearMcpOAuthClientSecret('gmail')
    expect(hasMcpOAuthClientSecret('gmail')).toBe(false)

    setGoogleMcpClientSecret('shared-google-secret')
    expect(hasGoogleMcpClientSecret()).toBe(true)
    expect(getGoogleMcpClientSecret()).toBe('shared-google-secret')
    const after = JSON.parse(readFileSync(secretsFile, 'utf8')) as Record<string, string>
    expect(JSON.stringify(after)).not.toContain('shared-google-secret')
    clearGoogleMcpClientSecret()
    expect(hasGoogleMcpClientSecret()).toBe(false)
  })

  it('decrypts a stored blob once across repeated reads', () => {
    setGoogleMcpClientSecret('cache-once-secret')
    counters.decryptCalls = 0
    expect(getGoogleMcpClientSecret()).toBe('cache-once-secret')
    expect(counters.decryptCalls).toBe(1)
    expect(getGoogleMcpClientSecret()).toBe('cache-once-secret')
    expect(counters.decryptCalls).toBe(1)
  })
})
