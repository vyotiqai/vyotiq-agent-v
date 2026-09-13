import { useCallback, useEffect, useRef, useState } from 'react'
import type { WorkspaceLspStatus } from '@shared/ipc'
import type { LspDiagnosticItem } from '@shared/utils/lspDiagnostics'

const LSP_DIAGNOSTICS_DEBOUNCE_MS = 400

export function useWorkspaceLsp({
  workspacePath,
  path,
  content,
  enabled
}: {
  workspacePath: string | null | undefined
  path: string | null | undefined
  content: string
  enabled: boolean
}): {
  status: WorkspaceLspStatus | null
  diagnostics: LspDiagnosticItem[]
  fetchHover: (line: number, character: number) => Promise<string | null>
} {
  const [status, setStatus] = useState<WorkspaceLspStatus | null>(null)
  const [diagnostics, setDiagnostics] = useState<LspDiagnosticItem[]>([])
  const requestIdRef = useRef(0)
  const contentRef = useRef(content)
  contentRef.current = content

  useEffect(() => {
    if (!enabled || !workspacePath || !path || !window.vyotiq?.workspaceLspStatus) {
      setStatus(null)
      setDiagnostics([])
      return undefined
    }
    setDiagnostics([])
    let cancelled = false
    void window.vyotiq.workspaceLspStatus({ workspacePath, path }).then((result) => {
      if (cancelled) return
      if (result.ok) {
        setStatus(result.data)
        if (result.data.kind !== 'available') setDiagnostics([])
      } else {
        setStatus({ kind: 'unavailable', detail: result.error })
        setDiagnostics([])
      }
    })
    return () => {
      cancelled = true
    }
  }, [enabled, path, workspacePath])

  useEffect(() => {
    if (!enabled || !workspacePath || !path || !window.vyotiq?.workspaceLspRequest) {
      return undefined
    }
    if (status?.kind !== 'available') return undefined

    const requestId = ++requestIdRef.current
    const timer = window.setTimeout(() => {
      void window.vyotiq
        .workspaceLspRequest({
          workspacePath,
          path,
          content: contentRef.current,
          action: 'diagnostics',
          line: 0,
          character: 0
        })
        .then((response) => {
          if (requestId !== requestIdRef.current) return
          if (response.ok && response.data.kind === 'diagnostics') {
            setDiagnostics(response.data.items)
          }
        })
        .catch(() => {
          if (requestId !== requestIdRef.current) return
          setDiagnostics([])
        })
    }, LSP_DIAGNOSTICS_DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
    }
  }, [content, enabled, path, status, workspacePath])

  const fetchHover = useCallback(
    async (line: number, character: number): Promise<string | null> => {
      if (!workspacePath || !path || !window.vyotiq?.workspaceLspRequest) return null
      if (status?.kind !== 'available') return null
      try {
        const response = await window.vyotiq.workspaceLspRequest({
          workspacePath,
          path,
          content: contentRef.current,
          action: 'hover',
          line,
          character
        })
        if (response.ok && response.data.kind === 'hover') {
          return response.data.content
        }
      } catch {
        // Hover is optional; ignore failures.
      }
      return null
    },
    [path, status, workspacePath]
  )

  return { status, diagnostics, fetchHover }
}
