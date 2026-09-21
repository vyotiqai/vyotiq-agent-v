import { isSyncBlockedUrl } from './webFetch'

/**
 * Single policy authority for outbound network requests made on the agent's
 * behalf.
 *
 * Before this module the rules lived in places that could not see each other:
 * `assertAllowedUrl` (SSRF, in webFetch), `assertDomainAllowlist` (host
 * allowlist, navigation only, in agentBrowser) and the per-tool approval gate.
 * Each was correct on its own, and none of them could answer "what did this run
 * talk to?".
 *
 * The gap that mattered: the host allowlist was enforced on *navigation* only.
 * A page loaded from an allowed host could still fetch or POST to any host in
 * the world, because subresource requests never passed a policy check.
 * `browser_subresource` closes that path.
 */

/** Where an outbound request came from. Recorded so the ledger is attributable. */
export type EgressPurpose =
  | 'browser_navigation'
  | 'browser_subresource'
  | 'web_fetch'
  | 'mcp_remote'

export type EgressDenyReason = 'unparseable' | 'scheme' | 'blocked_host' | 'not_in_allowlist'

export type EgressAllowReason = 'allowed' | 'non_network_scheme'

export type EgressDecision =
  | { allowed: true; reason: EgressAllowReason }
  | { allowed: false; reason: EgressDenyReason; detail: string }

export type EgressRequest = {
  url: string
  purpose: EgressPurpose
  method?: string
  /** Workspace the request belongs to; absent for app-level egress. */
  workspacePath?: string
  /** Run that owns the request, when one is active. */
  runId?: string
  /** When false, private/loopback hosts are refused (Ask/Plan posture). */
  allowLocal?: boolean
  /** Host allowlist in effect. Empty = no extra host filter (SSRF rules still apply). */
  allowlist?: readonly string[]
  /** Chromium resource type, when the request came from a browsed page. */
  resourceType?: string
}

/**
 * Schemes that resolve without touching the network. `onBeforeRequest` sees
 * every resource load, so refusing these would break `about:blank` frames,
 * inline `data:` assets and `blob:` media on pages that are otherwise allowed.
 *
 * Exempting them here does not widen what the agent may reach: this gate owns
 * *network* egress. Where the browser is allowed to navigate — including
 * whether a `file:` page is inside the workspace — stays with the navigation
 * guards (`isSyncBlockedNavigation`, `navigateUrlUnlocked`), which are
 * unchanged and still refuse every non-http(s) scheme.
 */
const NON_NETWORK_SCHEMES: ReadonlySet<string> = new Set([
  'about:',
  'data:',
  'blob:',
  'file:',
  'devtools:',
  'chrome:',
  'chrome-extension:',
  'chrome-error:',
  'chrome-untrusted:'
])

/**
 * Purposes that load resources for an already-admitted page. Both relaxations
 * below are scoped to these: navigation keeps its original, stricter contract
 * of http(s) only, so delegating the navigation guards to this module cannot
 * widen what the browser is allowed to open.
 */
const PAGE_RESOURCE_PURPOSES: ReadonlySet<EgressPurpose> = new Set(['browser_subresource'])

/**
 * WebSocket URLs are network egress and must face the same host rules, but
 * `isSyncBlockedUrl` only understands http(s). Map the scheme across so `wss:`
 * is judged on its host rather than refused wholesale — a blanket deny would
 * break every site that uses a live connection.
 */
const WEBSOCKET_SCHEME_EQUIVALENT: Readonly<Record<string, string>> = {
  'ws:': 'http:',
  'wss:': 'https:'
}

/** Host allowlist: exact match or `*.example.com` suffix. Empty list = unrestricted. */
export function hostAllowedByAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true
  const host = hostname.toLowerCase().replace(/\.$/, '')
  for (const raw of allowlist) {
    const entry = raw.trim().toLowerCase().replace(/\.$/, '')
    if (!entry) continue
    if (entry.startsWith('*.')) {
      const suffix = entry.slice(2)
      if (host === suffix || host.endsWith(`.${suffix}`)) return true
    } else if (host === entry) {
      return true
    }
  }
  return false
}

function allowlistDetail(hostname: string, allowlist: readonly string[]): string {
  const shown = allowlist.slice(0, 5).join(', ')
  const more = allowlist.length > 5 ? '…' : ''
  return `Host "${hostname}" is not in browserDomainAllowlist (${shown}${more})`
}

/**
 * Judge one outbound request. Total by construction — it never throws, so a
 * caller on a hot path (the per-request browser hook) can rely on getting a
 * decision back rather than having to defend against an exception.
 */
export function evaluateEgress(request: EgressRequest): EgressDecision {
  let url: URL
  try {
    url = new URL(request.url)
  } catch {
    return { allowed: false, reason: 'unparseable', detail: 'URL could not be parsed' }
  }

  const pageResource = PAGE_RESOURCE_PURPOSES.has(request.purpose)

  if (NON_NETWORK_SCHEMES.has(url.protocol)) {
    if (pageResource) {
      return { allowed: true, reason: 'non_network_scheme' }
    }
    return {
      allowed: false,
      reason: 'scheme',
      detail: `Scheme "${url.protocol}" is not allowed for ${request.purpose}`
    }
  }

  const equivalent = pageResource ? WEBSOCKET_SCHEME_EQUIVALENT[url.protocol] : undefined
  const policyUrl = equivalent
    ? `${equivalent}//${url.host}${url.pathname}${url.search}`
    : request.url

  if (isSyncBlockedUrl(policyUrl, request.allowLocal ?? false)) {
    return {
      allowed: false,
      reason: 'blocked_host',
      detail: `${url.protocol}//${url.hostname} is refused by network policy`
    }
  }

  const allowlist = request.allowlist ?? []
  if (!hostAllowedByAllowlist(url.hostname, allowlist)) {
    return {
      allowed: false,
      reason: 'not_in_allowlist',
      detail: allowlistDetail(url.hostname, allowlist)
    }
  }

  return { allowed: true, reason: 'allowed' }
}

export type EgressLedgerEntry = {
  at: number
  purpose: EgressPurpose
  method: string
  /**
   * Scheme and host only. Paths and query strings routinely carry tokens
   * (`?access_token=...`), and this ledger is meant to be safe to surface.
   */
  origin: string
  allowed: boolean
  reason: EgressAllowReason | EgressDenyReason
  workspacePath?: string
  runId?: string
  resourceType?: string
}

/**
 * Cap on retained entries. A single page can issue hundreds of requests, so an
 * unbounded ledger would grow without limit over a long browsing session.
 * Oldest entries are dropped first.
 */
export const MAX_EGRESS_LEDGER_ENTRIES = 1000

const ledger: EgressLedgerEntry[] = []

/** Scheme + host, or a placeholder when the URL never parsed. */
function originOf(raw: string): string {
  try {
    const url = new URL(raw)
    return `${url.protocol}//${url.host}`
  } catch {
    return '<unparseable>'
  }
}

export type EgressListener = (entry: EgressLedgerEntry) => void

const listeners = new Set<EgressListener>()

/**
 * Observe every recorded decision. Kept here rather than having a consumer poll
 * `listEgress()` so this module stays free of Electron and of any knowledge of
 * runs or storage — the durable per-run ledger subscribes from the outside.
 */
export function onEgressRecorded(listener: EgressListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function recordEgress(request: EgressRequest, decision: EgressDecision): EgressLedgerEntry {
  const entry: EgressLedgerEntry = {
    at: Date.now(),
    purpose: request.purpose,
    method: (request.method ?? 'GET').toUpperCase(),
    origin: originOf(request.url),
    allowed: decision.allowed,
    reason: decision.reason,
    ...(request.workspacePath ? { workspacePath: request.workspacePath } : {}),
    ...(request.runId ? { runId: request.runId } : {}),
    ...(request.resourceType ? { resourceType: request.resourceType } : {})
  }
  ledger.push(entry)
  if (ledger.length > MAX_EGRESS_LEDGER_ENTRIES) {
    ledger.splice(0, ledger.length - MAX_EGRESS_LEDGER_ENTRIES)
  }
  for (const listener of listeners) {
    try {
      listener(entry)
    } catch {
      // A failing observer must not break the request it is observing.
    }
  }
  return entry
}

/**
 * The single entry point callers use: judge the request and record the verdict
 * in one step, so nothing can be enforced without also being auditable.
 */
export function checkEgress(request: EgressRequest): EgressDecision {
  const decision = evaluateEgress(request)
  recordEgress(request, decision)
  return decision
}

export type EgressLedgerFilter = {
  runId?: string
  workspacePath?: string
  purpose?: EgressPurpose
  /** Only entries that were refused. */
  deniedOnly?: boolean
}

export function listEgress(filter: EgressLedgerFilter = {}): EgressLedgerEntry[] {
  return ledger.filter((entry) => {
    if (filter.runId && entry.runId !== filter.runId) return false
    if (filter.workspacePath && entry.workspacePath !== filter.workspacePath) return false
    if (filter.purpose && entry.purpose !== filter.purpose) return false
    if (filter.deniedOnly && entry.allowed) return false
    return true
  })
}

export function egressLedgerSize(): number {
  return ledger.length
}

export function clearEgressLedger(): void {
  ledger.length = 0
}
