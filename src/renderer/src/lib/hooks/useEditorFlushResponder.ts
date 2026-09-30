import { useEffect } from 'react'

/**
 * Main asks the window to save open editors before it quits. The answer has to
 * come from the app, not from a view: when the task view isn't mounted (Home,
 * Settings, Extensions, Usage) nothing answered, main waited out its timeout
 * and then asked "still saving run data — quit anyway?" about nothing.
 *
 * Views with editors register their flush here; one responder answers for all
 * of them, and at once when none is mounted.
 */

type EditorFlush = () => Promise<boolean>

const flushes = new Set<EditorFlush>()

/** Register a view's "save what's dirty"; returns the unregister. */
export function registerEditorFlush(flush: EditorFlush): () => void {
  flushes.add(flush)
  return () => {
    flushes.delete(flush)
  }
}

/** Every registered flush, together; true only when all of them saved. */
export async function flushAllEditors(): Promise<boolean> {
  const results = await Promise.all([...flushes].map((flush) => flush().catch(() => false)))
  return results.every(Boolean)
}

/** Mount once, at the app root. */
export function useEditorFlushResponder(): void {
  useEffect(() => {
    const onFlushRequest = window.vyotiq?.onWorkspaceEditorFlushRequest
    const respond = window.vyotiq?.respondWorkspaceEditorFlush
    if (!onFlushRequest || !respond) return undefined
    return onFlushRequest((requestId) => {
      void flushAllEditors().then((ok) => respond(requestId, ok))
    })
  }, [])
}

export function resetEditorFlushesForTests(): void {
  flushes.clear()
}
