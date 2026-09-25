import { useCallback, useEffect, useState } from 'react'

/**
 * Which files you have marked Viewed in the review, per task. A mark is kept
 * with the change it was made against — the file's status and counts — so a
 * file the agent edits again comes back unviewed, as on a pull request.
 *
 * It is yours alone (this browser's storage), which is what "viewed" means.
 */
const STORAGE_KEY = 'vyotiq.review.viewed'
/** Oldest reviews are forgotten past this many. */
const MAX_SCOPES = 50

type Stored = { order: string[]; scopes: Record<string, Record<string, string>> }

export function reviewSignature(file: { status: string; added?: number | null; removed?: number | null }): string {
  return `${file.status}:${file.added ?? '?'}:${file.removed ?? '?'}`
}

function read(): Stored {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return { order: [], scopes: {} }
    const parsed = JSON.parse(raw) as Partial<Stored>
    if (!parsed || !Array.isArray(parsed.order) || typeof parsed.scopes !== 'object' || !parsed.scopes) {
      return { order: [], scopes: {} }
    }
    return { order: parsed.order.filter((k): k is string => typeof k === 'string'), scopes: parsed.scopes }
  } catch {
    return { order: [], scopes: {} }
  }
}

function write(stored: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored))
  } catch {
    /* storage full or blocked: marks last for this session only */
  }
}

export function useReviewViewed(scopeKey: string | null): {
  isViewed: (path: string, signature: string) => boolean
  setViewed: (path: string, signature: string, viewed: boolean) => void
} {
  const [marks, setMarks] = useState<Record<string, string>>(() => (scopeKey ? (read().scopes[scopeKey] ?? {}) : {}))

  useEffect(() => {
    setMarks(scopeKey ? (read().scopes[scopeKey] ?? {}) : {})
  }, [scopeKey])

  const isViewed = useCallback((path: string, signature: string) => marks[path] === signature, [marks])

  const setViewed = useCallback(
    (path: string, signature: string, viewed: boolean) => {
      if (!scopeKey) return
      const stored = read()
      const next = { ...(stored.scopes[scopeKey] ?? {}) }
      if (viewed) next[path] = signature
      else delete next[path]
      stored.scopes[scopeKey] = next
      stored.order = [...stored.order.filter((k) => k !== scopeKey), scopeKey]
      while (stored.order.length > MAX_SCOPES) {
        const dropped = stored.order.shift()
        if (dropped) delete stored.scopes[dropped]
      }
      write(stored)
      setMarks(next)
    },
    [scopeKey]
  )

  return { isViewed, setViewed }
}
