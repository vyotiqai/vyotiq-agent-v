import * as tls from 'tls'
import { X509Certificate } from 'crypto'
import { readFileSync } from 'fs'
import { execFile } from 'child_process'
import { logger } from '../../shared/logger'

/**
 * Node's trust store for the main process: provider streams, MCP over HTTP,
 * catalogs and downloads all use Node's `fetch` / `https` with no `ca` of
 * their own, so whatever is in the default store is what they trust.
 *
 * Two things feed it here that Node would otherwise miss:
 *
 * - The OS store. Chromium (the updater, crash reports, the agent browser)
 *   already trusts it; Node by default trusts only its bundled Mozilla list.
 *   A proxy that re-signs TLS usually has its root deployed to the OS store,
 *   so without this the app's own windows load while every provider call
 *   fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. `NODE_USE_SYSTEM_CA=0` opts out.
 * - `NODE_EXTRA_CA_CERTS`. The packaged app has the NodeOptions fuse off, and
 *   Electron then strips this variable before Node starts, so Node never reads
 *   it. On Windows the value is recovered from the registry (where a desktop
 *   launch gets it from) and loaded here; the variable is put back for child
 *   processes too.
 */

type CaApi = {
  getCACertificates: (type?: 'default' | 'system' | 'bundled' | 'extra') => string[]
  setDefaultCACertificates: (certs: ReadonlyArray<string>) => void
}

const PEM_CERTIFICATE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

/** Every parseable certificate in a PEM bundle, plus a count of blocks that did not parse. */
export function pemCertificatesIn(text: string): { certs: string[]; invalid: number } {
  const certs: string[] = []
  let invalid = 0
  for (const block of text.match(PEM_CERTIFICATE) ?? []) {
    try {
      new X509Certificate(block)
      certs.push(block)
    } catch {
      invalid += 1
    }
  }
  return { certs, invalid }
}

/** Read a PEM file; a missing or unreadable file is a reason, never a throw. */
export function readCaFile(
  path: string,
  read: (p: string) => string = (p) => readFileSync(p, 'utf8')
): { certs: string[]; invalid: number; error?: string } {
  let text: string
  try {
    text = read(path)
  } catch (err) {
    const code = (err as { code?: unknown }).code
    return { certs: [], invalid: 0, error: typeof code === 'string' ? code : 'unreadable' }
  }
  const parsed = pemCertificatesIn(text)
  if (parsed.certs.length === 0) return { ...parsed, error: 'no certificates' }
  return parsed
}

function pemKey(pem: string): string {
  return pem.replace(/\s+/g, '')
}

/** Add certificates to Node's default store; returns how many were new. */
export function addDefaultCaCertificates(extra: readonly string[], api: CaApi = tls): number {
  if (extra.length === 0) return 0
  const current = api.getCACertificates('default')
  const seen = new Set(current.map(pemKey))
  const added: string[] = []
  for (const pem of extra) {
    const key = pemKey(pem)
    if (seen.has(key)) continue
    seen.add(key)
    added.push(pem)
  }
  if (added.length === 0) return 0
  api.setDefaultCACertificates([...current, ...added])
  return added.length
}

function loadExtraCaFile(path: string, origin: string, api: CaApi): void {
  const file = readCaFile(path)
  if (file.error) {
    logger.warn(`NODE_EXTRA_CA_CERTS not loaded: ${file.error}`, {
      scope: 'net',
      source: origin,
      reason: file.error
    })
    return
  }
  const added = addDefaultCaCertificates(file.certs, api)
  logger.info('Loaded NODE_EXTRA_CA_CERTS', {
    scope: 'net',
    source: origin,
    count: added,
    ...(file.invalid ? { dropped: file.invalid } : {})
  })
}

/**
 * Synchronous part, before anything dials out: the OS store, and
 * NODE_EXTRA_CA_CERTS when it is in the environment but Node did not load it.
 */
export function installNodeCaCertificates(
  env: NodeJS.ProcessEnv = process.env,
  api: CaApi = tls
): void {
  try {
    if (env.NODE_USE_SYSTEM_CA !== '0') {
      const added = addDefaultCaCertificates(api.getCACertificates('system'), api)
      if (added > 0) logger.info('Trusting the OS certificate store', { scope: 'net', count: added })
    }
  } catch (err) {
    logger.warn('Could not read the OS certificate store', { scope: 'net', err })
  }
  const extraPath = env.NODE_EXTRA_CA_CERTS?.trim()
  // Node loaded it itself at startup (dev, or the fuse on): nothing to do.
  if (!extraPath || api.getCACertificates('extra').length > 0) return
  loadExtraCaFile(extraPath, 'environment', api)
}

/** `NAME  REG_SZ  value` from `reg query`; REG_EXPAND_SZ gets %VAR% expanded. */
export function parseRegQueryValue(
  stdout: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env
): string | null {
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/.exec(line)
    if (!m || m[1].toUpperCase() !== name.toUpperCase()) continue
    const raw = m[3].trim()
    if (!raw) return null
    if (m[2] !== 'REG_EXPAND_SZ') return raw
    return raw.replace(/%([^%]+)%/g, (whole, key: string) => env[key] ?? whole)
  }
  return null
}

type RegQuery = (key: string, name: string) => Promise<string | null>

const ENV_KEYS = [
  'HKCU\\Environment',
  'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment'
]

const regQuery: RegQuery = (key, name) =>
  new Promise((resolve) => {
    execFile(
      'reg.exe',
      ['query', key, '/v', name],
      { windowsHide: true, timeout: 5_000, encoding: 'utf8' },
      // Exit 1 just means the value is not there.
      (err, stdout) => resolve(err ? null : stdout)
    )
  })

/**
 * Windows, packaged only: a desktop launch inherits NODE_EXTRA_CA_CERTS from
 * the registry, and the fuse stripped it. User scope wins over machine scope,
 * as in Windows' own merge. Async (one reg.exe each), so a request made in
 * the first few hundred ms can still miss it.
 */
export async function recoverFuseStrippedExtraCaCerts(opts: {
  packaged: boolean
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  query?: RegQuery
  api?: CaApi
}): Promise<string | null> {
  const env = opts.env ?? process.env
  if (!opts.packaged || (opts.platform ?? process.platform) !== 'win32') return null
  if (env.NODE_EXTRA_CA_CERTS?.trim()) return null
  const query = opts.query ?? regQuery
  for (const key of ENV_KEYS) {
    const out = await query(key, 'NODE_EXTRA_CA_CERTS')
    const value = out ? parseRegQueryValue(out, 'NODE_EXTRA_CA_CERTS', env) : null
    if (!value) continue
    // Children (git, gh, npm) inherit process.env, as they did before the fuse.
    env.NODE_EXTRA_CA_CERTS = value
    loadExtraCaFile(value, 'registry', opts.api ?? tls)
    return value
  }
  return null
}
