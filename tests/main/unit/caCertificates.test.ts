import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import * as tls from 'tls'
import { tmpdir } from 'os'
import { join } from 'path'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }))
vi.mock('@shared/logger', () => ({ logger: { ...log, error: vi.fn(), debug: vi.fn() } }))

import {
  addDefaultCaCertificates,
  installNodeCaCertificates,
  parseRegQueryValue,
  pemCertificatesIn,
  readCaFile,
  recoverFuseStrippedExtraCaCerts
} from '@main/net/caCertificates'

// Public halves of two throwaway self-signed CAs (keys discarded), valid to 2126.
const CA_A = `-----BEGIN CERTIFICATE-----
MIIBjTCCATOgAwIBAgIUSz3FJFvi/5Hl+CwfW73zcC3OsIQwCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQVnlvdGlxIFRlc3QgQ0EgQTAgFw0yNjEwMDIxMTI5NDVaGA8y
MTI2MDkwODExMjk0NVowGzEZMBcGA1UEAwwQVnlvdGlxIFRlc3QgQ0EgQTBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABAxRwOnxgLcjFjTkHT7FO320rpa/F7smAjuR
xLQ8pANxAhmFn/8keGUdYiJXFtUZP/OpI+yY0bhRpAukhx1C0kyjUzBRMB0GA1Ud
DgQWBBRfvUajSVQ/PrKvJUG5pvJA9nIn8jAfBgNVHSMEGDAWgBRfvUajSVQ/PrKv
JUG5pvJA9nIn8jAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0gAMEUCIDE6
ITxXAtrhUDNeom16NgNTeHDuzWN1VrsN2H0pXdjcAiEAnJ+qdKTFe9cKiTGySeeg
6buzFy9rtUWI6va/04aHWXY=
-----END CERTIFICATE-----`

const CA_B = `-----BEGIN CERTIFICATE-----
MIIBjjCCATOgAwIBAgIUVIGx3VOhHcs/VTYT+EmONg4bTh4wCgYIKoZIzj0EAwIw
GzEZMBcGA1UEAwwQVnlvdGlxIFRlc3QgQ0EgQjAgFw0yNjEwMDIxMTI5NDZaGA8y
MTI2MDkwODExMjk0NlowGzEZMBcGA1UEAwwQVnlvdGlxIFRlc3QgQ0EgQjBZMBMG
ByqGSM49AgEGCCqGSM49AwEHA0IABMoBWDMUFQoinLPMc6/P4uHZZzFfP7skBl4w
e452iApMXagXlktyaU48yK+QaG/LdUaQwAFdXvcfEVmmHqJLnH+jUzBRMB0GA1Ud
DgQWBBTHuP36huhOCzQMIRN/ixF1PSWvOjAfBgNVHSMEGDAWgBTHuP36huhOCzQM
IRN/ixF1PSWvOjAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0kAMEYCIQC1
dydX+zmzmukCOLMoH4umDVlG24el1a4JKKHBpyG5HgIhAI8zjNmEXyz6glVjzEOg
R00jHp0kxEheLrWhg+3n4Sfq
-----END CERTIFICATE-----`

const BROKEN = `-----BEGIN CERTIFICATE-----
bm90IGEgY2VydGlmaWNhdGU=
-----END CERTIFICATE-----`

/** In-memory stand-in for Node's default store. */
function fakeStore(initial: string[] = [], system: string[] = [], extra: string[] = []) {
  let current = [...initial]
  const api = {
    getCACertificates: (type?: string) =>
      type === 'system' ? system : type === 'extra' ? extra : [...current],
    setDefaultCACertificates: vi.fn((certs: ReadonlyArray<string>) => {
      current = [...certs]
    })
  }
  return { api, current: () => current }
}

const dirs: string[] = []
function tempFile(name: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vyotiq-ca-test-'))
  dirs.push(dir)
  const path = join(dir, name)
  writeFileSync(path, text)
  return path
}

afterEach(() => {
  log.info.mockClear()
  log.warn.mockClear()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('pemCertificatesIn', () => {
  it('finds every certificate in a bundle and counts the ones that do not parse', () => {
    const text = `# corp bundle\r\n${CA_A}\r\n\r\n${BROKEN}\n${CA_B}\n`
    const { certs, invalid } = pemCertificatesIn(text)
    expect(certs).toHaveLength(2)
    expect(invalid).toBe(1)
  })

  it('returns nothing for text with no PEM blocks', () => {
    expect(pemCertificatesIn('hello')).toEqual({ certs: [], invalid: 0 })
  })
})

describe('readCaFile', () => {
  it('reads a multi-certificate file', () => {
    const file = readCaFile(tempFile('bundle.pem', `${CA_A}\n${CA_B}\n`))
    expect(file.error).toBeUndefined()
    expect(file.certs).toHaveLength(2)
  })

  it('reports a missing file instead of throwing', () => {
    expect(readCaFile(join(tmpdir(), 'vyotiq-no-such-ca-file.pem')).error).toBe('ENOENT')
  })

  it('reports a file with no certificates', () => {
    expect(readCaFile(tempFile('empty.pem', 'nothing here')).error).toBe('no certificates')
  })
})

describe('addDefaultCaCertificates', () => {
  it('appends only certificates not already trusted', () => {
    const store = fakeStore([CA_A])
    expect(addDefaultCaCertificates([CA_A.replace(/\n/g, '\r\n'), CA_B], store.api)).toBe(1)
    expect(store.current()).toEqual([CA_A, CA_B])
  })

  it('does not touch the store when nothing is new', () => {
    const store = fakeStore([CA_A])
    expect(addDefaultCaCertificates([CA_A], store.api)).toBe(0)
    expect(store.api.setDefaultCACertificates).not.toHaveBeenCalled()
  })

  it("is accepted by this runtime's own store", () => {
    expect(addDefaultCaCertificates([CA_A, CA_B])).toBeGreaterThanOrEqual(0)
    const trusted = tls.getCACertificates('default').map((c) => c.replace(/\s+/g, ''))
    expect(trusted).toContain(CA_A.replace(/\s+/g, ''))
    expect(trusted).toContain(CA_B.replace(/\s+/g, ''))
  })
})

describe('installNodeCaCertificates', () => {
  it('adds the OS store and an extra file Node did not load', () => {
    const store = fakeStore([], [CA_A])
    installNodeCaCertificates(
      { NODE_EXTRA_CA_CERTS: tempFile('extra.pem', `${CA_B}\n${BROKEN}`) },
      store.api
    )
    expect(store.current()).toEqual([CA_A, CA_B])
    expect(log.info).toHaveBeenCalledWith(
      'Loaded NODE_EXTRA_CA_CERTS',
      expect.objectContaining({ count: 1, dropped: 1, source: 'environment' })
    )
  })

  it('honours NODE_USE_SYSTEM_CA=0', () => {
    const store = fakeStore([], [CA_A])
    installNodeCaCertificates({ NODE_USE_SYSTEM_CA: '0' }, store.api)
    expect(store.current()).toEqual([])
  })

  it('leaves NODE_EXTRA_CA_CERTS alone when Node already loaded it', () => {
    const store = fakeStore([], [], [CA_B])
    installNodeCaCertificates(
      { NODE_USE_SYSTEM_CA: '0', NODE_EXTRA_CA_CERTS: tempFile('extra.pem', CA_B) },
      store.api
    )
    expect(store.api.setDefaultCACertificates).not.toHaveBeenCalled()
  })

  it('logs a bad file and carries on', () => {
    const store = fakeStore([], [CA_A])
    expect(() =>
      installNodeCaCertificates(
        { NODE_EXTRA_CA_CERTS: join(tmpdir(), 'vyotiq-no-such-ca-file.pem') },
        store.api
      )
    ).not.toThrow()
    expect(store.current()).toEqual([CA_A])
    expect(log.warn).toHaveBeenCalledWith(
      'NODE_EXTRA_CA_CERTS not loaded: ENOENT',
      expect.objectContaining({ reason: 'ENOENT' })
    )
  })

  it('survives a store that cannot be read', () => {
    const api = {
      getCACertificates: (type?: string) => {
        if (type === 'system') throw new Error('no store')
        return []
      },
      setDefaultCACertificates: vi.fn()
    }
    expect(() => installNodeCaCertificates({}, api)).not.toThrow()
    expect(log.warn).toHaveBeenCalled()
  })
})

describe('parseRegQueryValue', () => {
  const out = (type: string, value: string): string =>
    `\r\nHKEY_CURRENT_USER\\Environment\r\n    NODE_EXTRA_CA_CERTS    ${type}    ${value}\r\n\r\n`

  it('reads REG_SZ', () => {
    expect(parseRegQueryValue(out('REG_SZ', 'C:\\certs\\corp.pem'), 'NODE_EXTRA_CA_CERTS')).toBe(
      'C:\\certs\\corp.pem'
    )
  })

  it('expands REG_EXPAND_SZ and keeps unknown variables', () => {
    const env = { USERPROFILE: 'C:\\Users\\me' }
    expect(
      parseRegQueryValue(out('REG_EXPAND_SZ', '%USERPROFILE%\\%NOPE%\\ca.pem'), 'NODE_EXTRA_CA_CERTS', env)
    ).toBe('C:\\Users\\me\\%NOPE%\\ca.pem')
  })

  it('returns null when the value is absent', () => {
    expect(parseRegQueryValue('\r\nHKEY_CURRENT_USER\\Environment\r\n', 'NODE_EXTRA_CA_CERTS')).toBeNull()
  })
})

describe('recoverFuseStrippedExtraCaCerts', () => {
  const reply = (value: string): string => `\r\nX\r\n    NODE_EXTRA_CA_CERTS    REG_SZ    ${value}\r\n`

  it('prefers the user value, loads it and restores the variable for children', async () => {
    const path = tempFile('corp.pem', CA_A)
    const env: NodeJS.ProcessEnv = {}
    const store = fakeStore()
    const query = vi.fn(async (key: string) => (key.startsWith('HKCU') ? reply(path) : reply('C:\\other.pem')))
    await expect(
      recoverFuseStrippedExtraCaCerts({ packaged: true, platform: 'win32', env, query, api: store.api })
    ).resolves.toBe(path)
    expect(query).toHaveBeenCalledTimes(1)
    expect(env.NODE_EXTRA_CA_CERTS).toBe(path)
    expect(store.current()).toEqual([CA_A])
  })

  it('falls back to the machine value', async () => {
    const path = tempFile('corp.pem', CA_B)
    const store = fakeStore()
    const query = vi.fn(async (key: string) => (key.startsWith('HKLM') ? reply(path) : null))
    await recoverFuseStrippedExtraCaCerts({ packaged: true, platform: 'win32', env: {}, query, api: store.api })
    expect(store.current()).toEqual([CA_B])
  })

  it('does nothing in dev, off Windows, or when the variable survived', async () => {
    const query = vi.fn(async () => reply('C:\\x.pem'))
    await recoverFuseStrippedExtraCaCerts({ packaged: false, platform: 'win32', env: {}, query })
    await recoverFuseStrippedExtraCaCerts({ packaged: true, platform: 'darwin', env: {}, query })
    await recoverFuseStrippedExtraCaCerts({
      packaged: true,
      platform: 'win32',
      env: { NODE_EXTRA_CA_CERTS: 'C:\\set.pem' },
      query
    })
    expect(query).not.toHaveBeenCalled()
  })

  it('returns null when neither scope has it', async () => {
    const env: NodeJS.ProcessEnv = {}
    await expect(
      recoverFuseStrippedExtraCaCerts({ packaged: true, platform: 'win32', env, query: async () => null })
    ).resolves.toBeNull()
    expect(env.NODE_EXTRA_CA_CERTS).toBeUndefined()
  })
})
