/**
 * secrets.json is read on hot paths (every getSettings() restores MCP secrets
 * per server). Reads must reuse the last parse until the file changes, and
 * must never serve a stale value after a write — ours or anyone else's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const USER_DATA = mkdtempSync(join(tmpdir(), 'vyotiq-secrets-cache-'))
const reads = vi.hoisted(() => ({ secrets: 0 }))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (String(path).endsWith('secrets.json')) reads.secrets++
    return (actual.readFileSync as (...args: unknown[]) => unknown)(path, ...rest)
  }) as typeof actual.readFileSync
  return { ...actual, default: { ...actual, readFileSync }, readFileSync }
})
vi.mock('electron', () => ({
  app: { getPath: () => USER_DATA, getAppPath: () => process.cwd(), isPackaged: false },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8')
  }
}))
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import {
  clearMcpAuthToken,
  getMcpAuthToken,
  hasMcpAuthToken,
  setMcpAuthToken
} from '@main/settings/secrets'

const secretsFile = join(USER_DATA, 'secrets.json')
const blob = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

describe('secrets file read cache', () => {
  beforeEach(() => {
    writeFileSync(secretsFile, JSON.stringify({ 'mcp-auth:alpha': blob('token-a') }))
    reads.secrets = 0
  })

  it('parses once for repeated lookups of an unchanged file', () => {
    for (let i = 0; i < 20; i++) {
      expect(hasMcpAuthToken('alpha')).toBe(true)
      expect(hasMcpAuthToken('beta')).toBe(false)
    }
    expect(getMcpAuthToken('alpha')).toBe('token-a')
    expect(reads.secrets).toBe(1)
  })

  it('sees its own writes immediately', () => {
    expect(hasMcpAuthToken('beta')).toBe(false)
    setMcpAuthToken('beta', 'token-b')
    expect(getMcpAuthToken('beta')).toBe('token-b')
    clearMcpAuthToken('alpha')
    expect(hasMcpAuthToken('alpha')).toBe(false)
  })

  it('sees a write from another process', async () => {
    expect(getMcpAuthToken('alpha')).toBe('token-a')
    // A different size, and a later mtime, as the other build would leave it.
    await new Promise((r) => setTimeout(r, 20))
    writeFileSync(
      secretsFile,
      JSON.stringify({ 'mcp-auth:alpha': blob('token-a2'), 'mcp-auth:gamma': blob('g') })
    )
    expect(getMcpAuthToken('alpha')).toBe('token-a2')
    expect(hasMcpAuthToken('gamma')).toBe(true)
  })
})
