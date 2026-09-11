import { logger } from '../../shared/logger'

export type CircuitState = 'closed' | 'open' | 'half_open'

export type CircuitPolicy = {
  failureThreshold: number
  openMs: number
  halfOpenMax: number
}

export const DEFAULT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 3,
  openMs: 60_000,
  halfOpenMax: 1
}

/** MCP connect is expensive (up to 120s). One failure opens the breaker — same as the old cooldown. */
export const MCP_CONNECT_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 1,
  openMs: 60_000,
  halfOpenMax: 1
}

/**
 * The codeindex embed utility is a forked `utilityProcess` that loads ONNX.
 * When it crashes it was re-forked on demand with no backoff and no breaker —
 * during a run that is every 1500 ms mutation debounce plus 2 s/5 s/30 s paging
 * re-warms. Three consecutive failed spawns stop the fork storm for a minute.
 */
export const EMBED_UTILITY_CIRCUIT_POLICY: CircuitPolicy = {
  failureThreshold: 3,
  openMs: 60_000,
  halfOpenMax: 1
}

export const CIRCUIT_FAILURE_THRESHOLD = DEFAULT_CIRCUIT_POLICY.failureThreshold
export const CIRCUIT_OPEN_MS = DEFAULT_CIRCUIT_POLICY.openMs

export class CircuitOpenError extends Error {
  readonly key: string
  readonly retryAfterMs: number

  constructor(key: string, retryAfterMs: number) {
    const secs = Math.max(1, Math.ceil(retryAfterMs / 1000))
    super(`Circuit open for ${key}; retry in ${secs}s`)
    this.name = 'CircuitOpenError'
    this.key = key
    this.retryAfterMs = retryAfterMs
  }
}

export function isCircuitOpenError(err: unknown): err is CircuitOpenError {
  return err instanceof CircuitOpenError
}

/**
 * Extract the retry horizon from a CircuitOpenError-shaped message
 * ("Circuit open for http:opencode.ai; retry in 58s" -> 58000ms).
 * Returns null when no shape matches. Used by callers that persisted the
 * error text (status.json) and lost the structured error — the relaunch
 * path must honor the circuit's backoff instead of re-firing immediately.
 */
export function parseCircuitRetryAfterMs(message: string): number | null {
  const m = message.match(/circuit open for .+?; retry in (\d+)s/i)
  return m ? Number(m[1]) * 1000 : null
}

export function circuitKeyProvider(providerId: string, endpoint?: string | null): string {
  const trimmed = endpoint?.trim()
  const authority = trimmed ? circuitKeyHttp(trimmed) : 'http:default'
  return `provider:${providerId}:${authority}`
}

export function circuitKeyHttp(url: string | URL): string {
  try {
    const host = (typeof url === 'string' ? new URL(url) : url).host.toLowerCase()
    return host ? `http:${host}` : 'http:unknown'
  } catch {
    return 'http:unknown'
  }
}

export function circuitKeyMcpConnect(sessionKey: string): string {
  return `mcp-connect:${sessionKey}`
}

export function circuitKeyMcpInvoke(sessionKey: string): string {
  return `mcp-invoke:${sessionKey}`
}

export function circuitKeyEmbedUtility(): string {
  return 'utility:codeindex-embed'
}

type Breaker = {
  state: CircuitState
  consecutiveFailures: number
  openedAt: number
  halfOpenProbes: number
  policy: CircuitPolicy
}

const breakers = new Map<string, Breaker>()
let nowFn = (): number => Date.now()

function now(): number {
  return nowFn()
}

function getOrCreate(key: string, policy?: CircuitPolicy): Breaker {
  let breaker = breakers.get(key)
  if (!breaker) {
    breaker = {
      state: 'closed',
      consecutiveFailures: 0,
      openedAt: 0,
      halfOpenProbes: 0,
      policy: policy ?? DEFAULT_CIRCUIT_POLICY
    }
    breakers.set(key, breaker)
  } else if (policy) {
    breaker.policy = policy
  }
  return breaker
}

function retryAfterMs(breaker: Breaker, at: number): number {
  return Math.max(0, breaker.openedAt + breaker.policy.openMs - at)
}

/**
 * Throw CircuitOpenError when the destination is open.
 * After openMs, the next caller is the half-open probe.
 */
export function assertCircuitClosed(key: string, policy?: CircuitPolicy): void {
  const breaker = getOrCreate(key, policy)
  const at = now()
  if (breaker.state === 'closed') return

  if (breaker.state === 'open') {
    if (at - breaker.openedAt >= breaker.policy.openMs) {
      breaker.state = 'half_open'
      breaker.halfOpenProbes = 0
    } else {
      throw new CircuitOpenError(key, retryAfterMs(breaker, at))
    }
  }

  if (breaker.state === 'half_open') {
    if (breaker.halfOpenProbes >= breaker.policy.halfOpenMax) {
      throw new CircuitOpenError(key, retryAfterMs(breaker, at))
    }
    breaker.halfOpenProbes += 1
  }
}

export function recordCircuitSuccess(key: string): void {
  const breaker = breakers.get(key)
  if (!breaker) return
  breaker.state = 'closed'
  breaker.consecutiveFailures = 0
  breaker.openedAt = 0
  breaker.halfOpenProbes = 0
  // A fully-closed, zero-failure breaker is semantically identical to an
  // absent one — evict so per-session keys (mcp-connect:<sessionKey>) cannot
  // accumulate for process lifetime (audit L-13). Policies are re-applied by
  // assertCircuitClosed/recordCircuitFailure call sites on re-creation.
  breakers.delete(key)
}

/** Abort (or other unfinished probe) must not consume the half-open slot. */
export function releaseCircuitProbe(key: string): void {
  const breaker = breakers.get(key)
  if (!breaker || breaker.state !== 'half_open') return
  breaker.halfOpenProbes = Math.max(0, breaker.halfOpenProbes - 1)
}

export function recordCircuitFailure(key: string, policy?: CircuitPolicy): void {
  const breaker = getOrCreate(key, policy)
  const at = now()
  if (breaker.state === 'half_open') {
    openBreaker(key, breaker, at)
    return
  }
  breaker.consecutiveFailures += 1
  if (breaker.consecutiveFailures >= breaker.policy.failureThreshold) {
    openBreaker(key, breaker, at)
  }
}

function openBreaker(key: string, breaker: Breaker, at: number): void {
  const alreadyOpen = breaker.state === 'open'
  breaker.state = 'open'
  breaker.openedAt = at
  breaker.halfOpenProbes = 0
  breaker.consecutiveFailures = Math.max(
    breaker.consecutiveFailures,
    breaker.policy.failureThreshold
  )
  if (alreadyOpen) return
  logger.warn('Circuit opened', {
    scope: 'agent',
    code: 'CIRCUIT_OPEN',
    circuitKey: key,
    retryAfterMs: breaker.policy.openMs,
    kind: 'open'
  })
}

export function resetCircuit(key: string): void {
  breakers.delete(key)
}

export function resetCircuitsByPrefix(prefix: string): void {
  for (const key of [...breakers.keys()]) {
    if (key.startsWith(prefix)) breakers.delete(key)
  }
}

export function inspectCircuit(key: string): {
  state: CircuitState
  consecutiveFailures: number
  retryAfterMs: number
} {
  const breaker = breakers.get(key)
  if (!breaker) {
    return { state: 'closed', consecutiveFailures: 0, retryAfterMs: 0 }
  }
  return {
    state: breaker.state,
    consecutiveFailures: breaker.consecutiveFailures,
    retryAfterMs: breaker.state === 'open' ? retryAfterMs(breaker, now()) : 0
  }
}

/** Test helper — isolate breaker state across tests. */
export function resetCircuitBreakersForTests(): void {
  breakers.clear()
  nowFn = () => Date.now()
}

/** Test helper — freeze or override the breaker clock. */
export function setCircuitNowForTests(at: number | (() => number)): void {
  nowFn = typeof at === 'number' ? () => at : at
}
