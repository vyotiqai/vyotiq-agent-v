import { useCallback, useEffect, useState } from 'react'
import { workspacePathsEqual } from '@shared/workspacePathMatch'

const SCOPE_KEY = 'vyotiq.navigatorScope'
const SCOPE_EVENT = 'vyotiq:navigator-scope'

/** Filter the navigator to one workspace from anywhere — Home's workspace rows. */
export function requestNavigatorScope(path: string | null): void {
  window.dispatchEvent(new CustomEvent(SCOPE_EVENT, { detail: { path } }))
}

function readScope(): string | null {
  try {
    const raw = window.localStorage.getItem(SCOPE_KEY)
    return raw ? raw : null
  } catch {
    return null
  }
}

function writeScope(path: string | null): void {
  try {
    if (path) window.localStorage.setItem(SCOPE_KEY, path)
    else window.localStorage.removeItem(SCOPE_KEY)
  } catch {
    // Best effort: the filter still holds for this session.
  }
}

/**
 * Which workspace the navigator is filtered to — `null` for all of them.
 * Remembered across launches, and dropped as soon as that workspace is no
 * longer open so the list never filters to something that is not there.
 */
export function useNavigatorScope(openPaths: readonly string[]): [string | null, (path: string | null) => void] {
  const [scope, setScopeState] = useState<string | null>(() => readScope())

  const setScope = useCallback((path: string | null): void => {
    setScopeState(path)
    writeScope(path)
  }, [])

  useEffect(() => {
    const onRequest = (event: Event): void => {
      const path = (event as CustomEvent<{ path?: string | null }>).detail?.path
      setScope(typeof path === 'string' && path ? path : null)
    }
    window.addEventListener(SCOPE_EVENT, onRequest)
    return () => window.removeEventListener(SCOPE_EVENT, onRequest)
  }, [setScope])

  useEffect(() => {
    if (scope === null || openPaths.length === 0) return
    if (!openPaths.some((path) => workspacePathsEqual(path, scope))) setScope(null)
  }, [scope, openPaths, setScope])

  const openMatch = scope === null ? null : (openPaths.find((path) => workspacePathsEqual(path, scope)) ?? null)
  return [openMatch, setScope]
}
