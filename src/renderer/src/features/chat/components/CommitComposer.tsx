import { useEffect, useRef } from 'react'
import { cn } from '@renderer/lib/ui'
import type { GitChangedFile, GitStatus } from '@shared/ipc'

const PILL =
  'inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-caption vy-transition'

/** Shared default commit message for Changes panel (and any legacy callers). */
export function defaultCommitMessage(
  files: Array<Pick<GitChangedFile, 'path'> | { path: string }>,
  fileCount = files.length
): string {
  const first = files[0]
  if (fileCount === 1 && first) {
    const base = first.path.includes('/') ? first.path.slice(first.path.lastIndexOf('/') + 1) : first.path
    return `Update ${base}`
  }
  return `Update ${fileCount} files`
}

export function defaultCommitMessageFromStatus(status: GitStatus): string {
  return defaultCommitMessage(status.files, status.fileCount)
}

/**
 * Shared commit message field + Commit / Commit & Push actions.
 * Canonical home is the Changes panel toolbar.
 */
export function CommitComposer({
  message,
  onMessageChange,
  busy,
  generating = false,
  generationNotice = null,
  hasRemote,
  onCommit,
  onCreatePr,
  onCancel,
  className,
  inputClassName,
  compact = false
}: {
  message: string
  onMessageChange: (value: string) => void
  busy: boolean
  generating?: boolean
  generationNotice?: string | null
  hasRemote: boolean
  onCommit: (push: boolean) => void
  onCreatePr?: () => void
  onCancel?: () => void
  className?: string
  inputClassName?: string
  compact?: boolean
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  return (
    <div className={cn('flex min-w-0 items-center gap-1.5', className)}>
      <input
        ref={inputRef}
        type="text"
        value={message}
        className={
          inputClassName ??
          'min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-1 text-xs text-fg outline-none focus-visible:vy-focus-ring'
        }
        placeholder={generating ? 'Generating commit message…' : 'Commit message'}
        aria-label="Commit message"
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            // Ctrl/Cmd+Enter commits and pushes when a remote exists (VS Code style).
            if (event.metaKey || event.ctrlKey) onCommit(hasRemote)
            else onCommit(false)
          }
          if (event.key === 'Escape') {
            // Esc here cancels the commit field only — never the running agent.
            event.preventDefault()
            event.stopPropagation()
            onCancel?.()
          }
        }}
      />
      {generating ? (
        <span className="shrink-0 text-2xs text-muted" aria-live="polite">
          Agent suggestion…
        </span>
      ) : null}
      {generationNotice ? (
        <span
          className="shrink-0 max-w-[48ch] truncate text-2xs text-muted"
          title={generationNotice}
          aria-live="polite"
        >
          Generation unavailable: {generationNotice} — using fallback
        </span>
      ) : null}
      <button
        type="button"
        className={cn(
          compact
            ? 'h-6 rounded-md px-2 text-caption text-fg hover:bg-surface-2'
            : cn(PILL, 'text-fg hover:bg-surface-2'),
          'disabled:vy-disabled-state'
        )}
        disabled={busy || !message.trim()}
        onClick={() => onCommit(false)}
      >
        Commit
      </button>
      {hasRemote ? (
        <button
          type="button"
          className={cn(
            compact
              ? 'h-6 rounded-md px-2 text-caption text-fg hover:bg-surface-2'
              : cn(PILL, 'text-fg hover:bg-surface-2'),
            'disabled:vy-disabled-state'
          )}
          disabled={busy || !message.trim()}
          onClick={() => onCommit(true)}
        >
          Commit &amp; Push
        </button>
      ) : null}
      {onCreatePr ? (
        <button
          type="button"
          className={cn(
            compact
              ? 'h-6 rounded-md px-2 text-caption text-fg hover:bg-surface-2'
              : cn(PILL, 'text-fg hover:bg-surface-2'),
            'disabled:vy-disabled-state'
          )}
          disabled={busy || !message.trim()}
          onClick={onCreatePr}
        >
          Commit &amp; Create PR
        </button>
      ) : null}
    </div>
  )
}
