import http from 'http'
import { session, type Session } from 'electron'
import type { NetworkSettings } from '../../shared/ipc'
import {
  normalizeProxyBypass,
  proxyUrlWithCredentials,
  validateProxyUrl,
  type ProxyStatus
} from '../../shared/domain/network'
import { logger } from '../../shared/logger'

export type { ProxyStatus }

/**
 * One proxy decision for the whole app. Node traffic (provider streams, MCP,
 * catalogs, downloads) goes through Node's built-in proxy support
 * (`http.setGlobalProxyFromEnv`, which covers `fetch` and `http(s).request`);
 * Chromium traffic (the updater, crash reports, the agent browser) goes
 * through each session's proxy config. Child processes (git, npm, the agent
 * terminal) get the same HTTPS_PROXY/NO_PROXY.
 */

export type ProxyEnv = { HTTP_PROXY?: string; HTTPS_PROXY?: string; NO_PROXY?: string }

/** Always direct, whatever the proxy: the app's own local services. */
const LOCAL_BYPASS = 'localhost,127.0.0.1,::1'
const UPDATER_PARTITION = 'electron-updater'

/**
 * Present in the Node that Electron 44 ships (24.21, checked at runtime). The
 * @types/node pinned to that line (24.13) predates it, so it is reached
 * through this accessor.
 */
type SetGlobalProxyFromEnv = (env: Record<string, string | undefined>) => () => void
const setGlobalProxyFromEnv = (http as unknown as { setGlobalProxyFromEnv?: SetGlobalProxyFromEnv })
  .setGlobalProxyFromEnv?.bind(http)

/**
 * `env` is what Node's own traffic uses; `childEnv`, when set, is what child
 * processes get instead — the manual proxy without its password, so a command
 * the agent runs cannot read the password out of its environment.
 */
let current: { env: ProxyEnv; childEnv?: ProxyEnv; status: ProxyStatus } = { env: {}, status: { source: 'none' } }
const trackedSessions = new Set<Session>()

export type ProxyCredentials = { username: string; password: string | null }

/** The manual proxy's user name and password; installed by main from settings and the key vault. */
let credentialsSource: () => ProxyCredentials | null = () => null

export function setProxyCredentialsSource(source: () => ProxyCredentials | null): void {
  credentialsSource = source
}

function readCredentials(): ProxyCredentials | null {
  try {
    return credentialsSource()
  } catch {
    return null
  }
}

/** Proxy variables from an environment; the lowercase spelling wins, as in curl and Node. */
export function envProxyFrom(env: NodeJS.ProcessEnv): ProxyEnv {
  const pick = (name: string): string | undefined => {
    const v = env[name.toLowerCase()] ?? env[name]
    return v && v.trim() ? v.trim() : undefined
  }
  const out: ProxyEnv = {}
  const httpProxy = pick('HTTP_PROXY')
  const httpsProxy = pick('HTTPS_PROXY')
  const noProxy = pick('NO_PROXY')
  if (httpProxy) out.HTTP_PROXY = httpProxy
  if (httpsProxy) out.HTTPS_PROXY = httpsProxy
  if (noProxy) out.NO_PROXY = noProxy
  return out
}

/**
 * The first proxy Node can use from a Chromium `resolveProxy` answer
 * (`PROXY host:port; DIRECT`). A leading DIRECT means none; SOCKS entries are
 * skipped — Node's built-in support only speaks HTTP(S) proxies.
 */
export function proxyUrlFromChromium(answer: string): { url: string | null; skippedSocks: boolean } {
  let skippedSocks = false
  for (const raw of answer.split(';')) {
    const entry = raw.trim()
    if (!entry) continue
    const [kind, hostPort] = entry.split(/\s+/, 2)
    const upper = kind?.toUpperCase()
    if (upper === 'DIRECT') return { url: null, skippedSocks }
    if (!hostPort) continue
    if (upper === 'PROXY') return { url: `http://${hostPort}`, skippedSocks }
    if (upper === 'HTTPS') return { url: `https://${hostPort}`, skippedSocks }
    if (upper?.startsWith('SOCKS')) skippedSocks = true
  }
  return { url: null, skippedSocks }
}

function redact(url: string): string {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return '(unreadable proxy address)'
  }
}

/** What Node should use for these settings, and how to describe it. */
export function resolveNodeProxy(
  net: NetworkSettings,
  env: NodeJS.ProcessEnv,
  systemProxyUrl: string | null,
  systemNote?: string,
  credentials?: ProxyCredentials | null
): { env: ProxyEnv; childEnv?: ProxyEnv; status: ProxyStatus } {
  if (net.proxyMode === 'direct') return { env: {}, status: { source: 'none' } }
  if (net.proxyMode === 'manual') {
    const parsed = validateProxyUrl(net.proxyUrl)
    if (parsed.ok) {
      const bypass = [normalizeProxyBypass(net.proxyBypass), LOCAL_BYPASS].filter(Boolean).join(',')
      const username = (credentials?.username ?? net.proxyUsername ?? '').trim()
      const authed = proxyUrlWithCredentials(parsed.url, username, credentials?.password ?? null)
      const plain: ProxyEnv = { HTTP_PROXY: parsed.url, HTTPS_PROXY: parsed.url, NO_PROXY: bypass }
      return {
        env: { HTTP_PROXY: authed, HTTPS_PROXY: authed, NO_PROXY: bypass },
        ...(authed !== parsed.url ? { childEnv: plain } : {}),
        status: {
          source: 'manual',
          url: parsed.url,
          bypass: normalizeProxyBypass(net.proxyBypass) || undefined,
          ...(username && !credentials?.password ? { note: 'A user name is set but no password is saved.' } : {})
        }
      }
    }
    return { env: {}, status: { source: 'none', note: `The manual proxy isn't usable: ${parsed.error}` } }
  }
  const fromEnv = envProxyFrom(env)
  if (fromEnv.HTTPS_PROXY || fromEnv.HTTP_PROXY) {
    return {
      env: fromEnv,
      status: {
        source: 'environment',
        url: redact(fromEnv.HTTPS_PROXY ?? fromEnv.HTTP_PROXY!),
        bypass: fromEnv.NO_PROXY
      }
    }
  }
  if (systemProxyUrl) {
    return {
      env: { HTTP_PROXY: systemProxyUrl, HTTPS_PROXY: systemProxyUrl, NO_PROXY: LOCAL_BYPASS },
      status: { source: 'system', url: redact(systemProxyUrl), ...(systemNote ? { note: systemNote } : {}) }
    }
  }
  return { env: {}, status: { source: 'none', ...(systemNote ? { note: systemNote } : {}) } }
}

function installNode(next: { env: ProxyEnv; childEnv?: ProxyEnv; status: ProxyStatus }): void {
  if (!setGlobalProxyFromEnv) {
    current = { env: {}, status: { source: 'none', note: 'This runtime has no built-in proxy support.' } }
    return
  }
  // Replaces the previous config, so switching to direct turns the proxy off.
  setGlobalProxyFromEnv({ ...next.env })
  current = next
}

/**
 * Before anything dials out: the manual and environment proxies need no
 * Chromium, so Node gets them at once. The OS proxy follows once the app is
 * ready (applyNetworkSettings).
 */
export function applyEarlyNodeProxy(net: NetworkSettings): void {
  try {
    installNode(resolveNodeProxy(net, process.env, null, undefined, readCredentials()))
  } catch (err) {
    logger.warn('Could not set the proxy at startup', { scope: 'net', err })
  }
}

function chromiumConfig(net: NetworkSettings): Electron.ProxyConfig {
  if (net.proxyMode === 'direct') return { mode: 'direct' }
  if (net.proxyMode === 'manual') {
    const parsed = validateProxyUrl(net.proxyUrl)
    if (parsed.ok) {
      return {
        mode: 'fixed_servers',
        proxyRules: parsed.url,
        proxyBypassRules: [normalizeProxyBypass(net.proxyBypass), '<local>'].filter(Boolean).join(',')
      }
    }
  }
  return { mode: 'system' }
}

let lastChromium: Electron.ProxyConfig = { mode: 'system' }
/** The manual proxy's host, for answering its sign-in challenge; null when not manual. */
let lastManualHost: string | null = null

function manualProxyHost(net: NetworkSettings): string | null {
  const parsed = validateProxyUrl(net.proxyUrl)
  if (!parsed.ok) return null
  try {
    return new URL(parsed.url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Chromium asks for proxy credentials through the app's `login` event (the
 * agent browser, the updater's session). Answered only for the manual proxy
 * set here, with the saved user name and password; anything else falls
 * through to Chromium's own handling.
 */
export function proxyLoginAnswer(authInfo: { isProxy: boolean; host: string }): ProxyCredentials | null {
  if (!authInfo.isProxy || !lastManualHost) return null
  if (authInfo.host.toLowerCase().replace(/^\[|\]$/g, '') !== lastManualHost.replace(/^\[|\]$/g, '')) return null
  const creds = readCredentials()
  return creds?.username && creds.password ? creds : null
}

/** Give a session the app's proxy — and every later change to it. */
export async function applyProxyToSession(ses: Session): Promise<void> {
  trackedSessions.add(ses)
  try {
    await ses.setProxy(lastChromium)
  } catch (err) {
    logger.warn('Could not set a session proxy', { scope: 'net', err })
  }
}

/**
 * Apply the network settings everywhere: Chromium sessions first (the OS
 * proxy is read through the default session), then Node, then children.
 */
export async function applyNetworkSettings(net: NetworkSettings): Promise<ProxyStatus> {
  lastChromium = chromiumConfig(net)
  trackedSessions.add(session.defaultSession)
  trackedSessions.add(session.fromPartition(UPDATER_PARTITION))
  await Promise.all([...trackedSessions].map((ses) => applyProxyToSession(ses)))

  let systemUrl: string | null = null
  let systemNote: string | undefined
  if (net.proxyMode === 'system' && !Object.keys(envProxyFrom(process.env)).length) {
    try {
      // One answer for all Node traffic: a PAC file that routes hosts
      // differently is followed by Chromium, not by Node.
      const answer = await session.defaultSession.resolveProxy('https://api.openai.com/')
      const picked = proxyUrlFromChromium(answer)
      systemUrl = picked.url
      if (!picked.url && picked.skippedSocks) {
        systemNote = 'The system proxy is a SOCKS proxy; provider calls go direct.'
      }
    } catch (err) {
      logger.warn('Could not read the system proxy', { scope: 'net', err })
    }
  }
  lastManualHost = net.proxyMode === 'manual' ? manualProxyHost(net) : null
  installNode(resolveNodeProxy(net, process.env, systemUrl, systemNote, readCredentials()))
  logger.info('Network proxy applied', {
    scope: 'net',
    reason: `${current.status.source}${current.status.url ? ` ${current.status.url}` : ''}`
  })
  return current.status
}

export function proxyStatus(): ProxyStatus {
  return current.status
}

/** HTTPS_PROXY/HTTP_PROXY/NO_PROXY (both spellings) for a child process, or none. */
export function childProxyEnv(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(current.childEnv ?? current.env)) {
    if (!v) continue
    out[k] = v
    out[k.toLowerCase()] = v
  }
  return out
}

function hostBypassed(host: string, port: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false
  const h = host.toLowerCase().replace(/^\[|\]$/g, '')
  for (const raw of noProxy.split(',')) {
    const entry = raw.trim().toLowerCase()
    if (!entry) continue
    if (entry === '*') return true
    const [name, entryPort] = entry.replace(/^\*\./, '.').split(/:(?=\d+$)/)
    if (entryPort && entryPort !== port) continue
    if (!name) continue
    if (name.startsWith('.') ? h === name.slice(1) || h.endsWith(name) : h === name || h.endsWith(`.${name}`)) return true
  }
  return false
}

/**
 * True when a request to `url` goes through the proxy — so a name the local
 * resolver can't find may still be one the proxy can. An approximation of
 * Node's NO_PROXY rules; when it errs, a request only fails as it would have.
 */
export function proxyAppliesTo(url: URL): boolean {
  const proxy = url.protocol === 'https:' ? current.env.HTTPS_PROXY : current.env.HTTP_PROXY
  if (!proxy) return false
  const port = url.port || (url.protocol === 'https:' ? '443' : '80')
  return !hostBypassed(url.hostname, port, current.env.NO_PROXY)
}

export function resetProxyForTests(): void {
  setGlobalProxyFromEnv?.({})
  current = { env: {}, status: { source: 'none' } }
  trackedSessions.clear()
  lastChromium = { mode: 'system' }
}
