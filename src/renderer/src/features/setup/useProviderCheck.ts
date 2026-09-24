import { useCallback, useEffect, useState } from 'react'
import type { Settings } from '@shared/ipc'
import { providerCheckFrom, type ProviderCheck } from './setupModel'

/**
 * Asks main for the provider's models — the call the composer's model picker
 * makes — and reads the answer as a connection check. Asks again when the
 * provider, its host or its key changes, and on `recheck`. Null while the
 * provider has nothing to connect with yet (no key, where one is needed).
 */
export function useProviderCheck(
  provider: Settings['provider'],
  configured: boolean,
  /** Anything that changes what the check would find: the host, whether a key is saved. */
  connectionKey: string
): { check: ProviderCheck | null; recheck: () => void } {
  const [check, setCheck] = useState<ProviderCheck | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!configured) {
      setCheck(null)
      return
    }
    const listModels = window.vyotiq?.listModels
    if (!listModels) {
      setCheck({ state: 'failed', reason: 'The model list is unavailable in this window.' })
      return
    }
    let cancelled = false
    setCheck({ state: 'checking' })
    // Always a fresh ask: a list cached from before would say nothing about now.
    listModels({ provider, forceRefresh: true }).then(
      (res) => {
        if (!cancelled) setCheck(providerCheckFrom(res))
      },
      (err: unknown) => {
        if (!cancelled) setCheck({ state: 'failed', reason: err instanceof Error ? err.message : String(err) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [provider, configured, connectionKey, attempt])

  const recheck = useCallback(() => setAttempt((n) => n + 1), [])
  return { check, recheck }
}
