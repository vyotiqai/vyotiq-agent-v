import { useSyncExternalStore } from 'react'
import type { CustomProvider } from '@shared/ipc'

/**
 * The saved custom endpoints, published from useSettings so the composer, the
 * model picker and the readiness banner can name an endpoint ("Lab vLLM", not
 * "Custom") without threading the list through every chat prop bag. The list
 * is global-only (per-workspace overrides never narrow it), so one copy is
 * right for every pane.
 */
const EMPTY: readonly CustomProvider[] = []
let customProviders: readonly CustomProvider[] = EMPTY
const listeners = new Set<() => void>()

export function setCustomProviders(next: readonly CustomProvider[] | undefined): void {
  const list = next ?? EMPTY
  if (list === customProviders) return
  customProviders = list
  for (const listener of listeners) listener()
}

export function getCustomProviders(): readonly CustomProvider[] {
  return customProviders
}

function subscribeCustomProviders(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useCustomProviders(): readonly CustomProvider[] {
  return useSyncExternalStore(subscribeCustomProviders, getCustomProviders, () => EMPTY)
}

/** Test helper — reset between cases. */
export function resetCustomProvidersStore(): void {
  customProviders = EMPTY
  listeners.clear()
}
