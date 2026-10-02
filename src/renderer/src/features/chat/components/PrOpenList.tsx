import { useCallback, useEffect, useState } from 'react'
import { Button, IconButton, cn } from '@renderer/lib/ui'
import { ROW_HOVER, SECTION_LABEL } from '@renderer/lib/utils/layout'
import type { PrListItem } from '@shared/ipc'

/**
 * The repository's recent open pull requests, for a branch that has none of
 * its own: check one out to review or continue it here. Main refuses the
 * checkout while tracked files have changes or a task runs in this checkout.
 */
export function PrOpenList({
  workspacePath,
  revision = 0,
  running = false,
  onCheckedOut,
  onOpenExternal,
  onNotice
}: {
  workspacePath: string
  /** Reloads with the panel. */
  revision?: number
  /** The task on screen is working here: a checkout would swap its files. */
  running?: boolean
  onCheckedOut: () => void
  onOpenExternal: (url: string) => void
  onNotice: (message: string, failed: boolean) => void
}) {
  const [prs, setPrs] = useState<PrListItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  useEffect(() => {
    const list = window.vyotiq?.prList
    if (!list) return undefined
    let cancelled = false
    list(workspacePath)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setPrs(res.data.prs)
          setError(null)
        } else {
          setPrs(null)
          setError(res.error)
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => {
      cancelled = true
    }
  }, [workspacePath, revision])

  const checkout = useCallback(
    async (number: number) => {
      if (!window.vyotiq?.prCheckout || busy != null) return
      setBusy(number)
      try {
        const res = await window.vyotiq.prCheckout(workspacePath, number)
        if (!res.ok) {
          onNotice(res.error, true)
          return
        }
        onNotice(res.data.detail, false)
        onCheckedOut()
      } finally {
        setBusy(null)
      }
    },
    [workspacePath, busy, onCheckedOut, onNotice]
  )

  // Nothing to offer, or gh could not list them: the empty state above already says why.
  if (error || !prs || prs.length === 0) return null
  return (
    <section
      className="scroll-thin max-h-[45%] min-h-0 shrink-0 overflow-y-auto border-t border-border px-4 py-3"
      aria-label="Open pull requests"
      data-pr-open-list
    >
      <h4 className={cn('mb-1', SECTION_LABEL)}>Open pull requests</h4>
      <ul className="-mx-2 m-0 list-none p-0">
        {prs.map((pr) => (
          <li key={pr.number} className={cn('flex h-8 items-center gap-2 rounded-md px-2 text-xs', ROW_HOVER)}>
            <span className="shrink-0 font-mono text-caption text-tertiary tnum">#{pr.number}</span>
            <span className="min-w-0 flex-1 truncate text-fg" title={`${pr.title}\n${pr.headRefName} · ${pr.author}`}>
              {pr.title}
              {pr.isDraft ? <span className="text-tertiary"> · draft</span> : null}
            </span>
            <span className="min-w-0 max-w-[30%] shrink truncate font-mono text-caption text-muted" title={pr.headRefName}>
              {pr.headRefName}
            </span>
            {pr.url ? (
              <IconButton
                icon="external"
                label={`Open #${pr.number} on GitHub`}
                size="xs"
                tone="muted"
                onClick={() => onOpenExternal(pr.url!)}
              />
            ) : null}
            <Button
              size="xs"
              pending={busy === pr.number}
              disabled={busy != null || running}
              title={running ? 'The task is working in this checkout' : undefined}
              onClick={() => void checkout(pr.number)}
            >
              Check out
            </Button>
          </li>
        ))}
      </ul>
    </section>
  )
}
