import { useEffect, useRef, useState } from 'react'
import type { UiToolRow } from '@shared/transcript'

export type FullToolContentState = {
  loading: boolean
  failed: boolean
}

/**
 * Pull the untruncated tool output across IPC once the reader actually asks for
 * it. The loader writes the text back into the transcript item, so this hook
 * only has to report progress.
 */
export function useFullToolContent(
  tool: UiToolRow,
  enabled: boolean,
  load?: (toolCallId: string) => Promise<string | null>
): FullToolContentState {
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const truncated = Boolean(tool.contentTruncated)
  // Keep the latest loader in a ref: an unstable (freshly-inlined) `load`
  // identity must not retrigger this effect and its setState calls every
  // render, or the component hits React's nested-update cap.
  const loadRef = useRef(load)
  loadRef.current = load

  useEffect(() => {
    const loader = loadRef.current
    if (!truncated || !enabled || !loader) return undefined
    let cancelled = false
    setLoading(true)
    setFailed(false)
    void loader(tool.id)
      .then((text) => {
        if (!cancelled && text == null) setFailed(true)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [truncated, enabled, tool.id])

  useEffect(() => {
    if (!truncated) {
      setFailed(false)
      setLoading(false)
    }
  }, [truncated])

  return { loading, failed }
}
