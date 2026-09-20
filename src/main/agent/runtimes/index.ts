import type { RunRuntime, RuntimeKind } from './types'
import { localRuntime } from './local'

/**
 * Registered execution substrates. A runtime appears here only once it is
 * implemented and tested — an unregistered kind must fail loudly rather than
 * quietly running the user's work somewhere they did not choose.
 */
const runtimes = new Map<RuntimeKind, RunRuntime>([['local', localRuntime]])

/** @internal — register an additional runtime (cloud adapter, tests). */
export function registerRuntime(runtime: RunRuntime): void {
  runtimes.set(runtime.kind, runtime)
}

export function isRuntimeRegistered(kind: RuntimeKind): boolean {
  return runtimes.has(kind)
}

export function listRegisteredRuntimes(): RuntimeKind[] {
  return [...runtimes.keys()]
}

/** Resolve an execution substrate; local is the default and always present. */
export function getRuntime(kind: RuntimeKind = 'local'): RunRuntime {
  const runtime = runtimes.get(kind)
  if (!runtime) {
    throw new Error(
      `Runtime "${kind}" is not configured (available: ${[...runtimes.keys()].join(', ')})`
    )
  }
  return runtime
}

/**
 * Resolve a runtime and confirm it can accept work.
 *
 * Callers run this BEFORE a run is marked running. There is deliberately no
 * fallback to local: a run bound to cloud that quietly executed in-process
 * would put the user's code somewhere they did not agree to, on a machine they
 * may have chosen it to avoid.
 */
export async function resolveAvailableRuntime(
  kind: RuntimeKind = 'local'
): Promise<{ ok: true; runtime: RunRuntime } | { ok: false; error: string }> {
  let runtime: RunRuntime
  try {
    runtime = getRuntime(kind)
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  const available = await runtime.isAvailable()
  if (!available.ok) {
    return { ok: false, error: `Runtime "${kind}" is unavailable: ${available.reason}` }
  }
  return { ok: true, runtime }
}

export type { RunHandle, RunRuntime, RuntimeCapabilities, RuntimeKind, RuntimeRecord } from './types'
