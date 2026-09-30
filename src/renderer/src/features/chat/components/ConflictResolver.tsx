import { useEffect, useState } from 'react'
import { Button, Textarea } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'

type Sides = { ours: string; theirs: string; base: string; working: string }

/**
 * One conflicted file: both sides and the base to compare, the working copy
 * to edit, and the three ways to settle it. It reads the sides itself, so a
 * column of files can show one under each conflicted header.
 */
export function ConflictResolver({
  workspacePath,
  path,
  onResolved,
  onError
}: {
  workspacePath: string
  path: string
  /** Git has the file settled: refresh what depends on it. */
  onResolved: () => void
  onError: (message: string) => void
}) {
  const [sides, setSides] = useState<(Sides & { path: string }) | null>(null)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    let cancelled = false
    void window.vyotiq.gitConflictFile({ workspacePath, path }).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        onError(res.error)
        return
      }
      setSides({ path, ...res.data })
      setDraft(res.data.working)
    })
    return () => {
      cancelled = true
    }
    // onError is a notice sink; a new identity is not a reason to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, path])

  const resolve = (pick: (sides: { ours: string; theirs: string }) => string): void => {
    const apply = (content: string): void => {
      void window.vyotiq.gitResolveConflict({ workspacePath, path, content }).then((resolved) => {
        if (!resolved.ok) {
          onError(resolved.error)
          return
        }
        onResolved()
      })
    }
    if (sides?.path === path) {
      apply(pick(sides))
      return
    }
    void window.vyotiq.gitConflictFile({ workspacePath, path }).then((res) => {
      if (!res.ok) {
        onError(res.error)
        return
      }
      apply(pick(res.data))
    })
  }

  const shown = sides?.path === path ? sides : null
  return (
    <div className="@container shrink-0 space-y-2 border-b border-border bg-warning-soft px-3 py-2 text-xs" data-changes-conflict>
      <div className="flex flex-wrap items-center gap-1.5">
        <Icon name="warning" size={13} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-fg">Both sides changed this file</span>
        <Button size="xs" onClick={() => resolve((s) => s.ours)}>
          Keep ours
        </Button>
        <Button size="xs" onClick={() => resolve((s) => s.theirs)}>
          Keep theirs
        </Button>
        {/* The working text is this file's only once it has loaded: before, it is empty or another file's. */}
        <Button size="xs" disabled={!shown} onClick={() => resolve(() => draft)}>
          Save working
        </Button>
      </div>
      {shown ? (
        // Three columns only when the block itself is wide (the review), not the window.
        <div className="grid max-h-56 grid-cols-1 gap-1 overflow-auto @xl:grid-cols-3">
          {(['ours', 'theirs', 'base'] as const).map((side) => (
            <pre
              key={side}
              className="m-0 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-sunken p-1.5 font-mono text-xs text-fg"
            >
              <span className="block font-sans text-caption font-medium text-muted">
                {side === 'ours' ? 'Ours' : side === 'theirs' ? 'Theirs' : 'Base'}
              </span>
              {shown[side] || '∅'}
            </pre>
          ))}
        </div>
      ) : null}
      <label className="m-0 block text-muted">
        Working copy
        <Textarea
          size="sm"
          rows={4}
          className="mt-1 max-h-36 font-mono"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </label>
    </div>
  )
}
