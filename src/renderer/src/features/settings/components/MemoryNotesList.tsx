import { useCallback, useEffect, useState, type JSX } from 'react'
import type { WorkspaceMemoryNote } from '@shared/ipc'
import { relativeTimeAgo } from '@shared/utils/timeFormat'
import { Icon } from '@renderer/lib/icons'
import { IconButton, cn } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { BORDER_DIVIDER } from '@renderer/lib/utils/layout'

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`
}

/**
 * The notes earlier tasks wrote, one row each: what it says first, how long
 * ago, and whether index.md points at it (a note it does not point at is one
 * tasks will not find). A row opens to read the note in full; one that is
 * wrong is deleted on its own, its index line with it.
 */
export function MemoryNotesList({
  workspacePath,
  revision,
  onChanged
}: {
  workspacePath: string
  /** Bumped when the workspace's memory count changes, to read the list again. */
  revision: number
  onChanged: () => void
}): JSX.Element | null {
  const [notes, setNotes] = useState<WorkspaceMemoryNote[] | null>(null)
  const [open, setOpen] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { confirm, dialog } = useConfirm()

  const load = useCallback(() => {
    void window.vyotiq?.workspaceMemoryNotes?.({ workspacePath }).then((res) => {
      if (res?.ok) setNotes(res.data)
      else if (res) setError(res.error)
    })
  }, [workspacePath])
  useEffect(load, [load, revision])

  useEffect(() => {
    setText(null)
    if (!open) return
    void window.vyotiq?.workspaceMemoryNoteRead?.({ workspacePath, path: open }).then((res) => {
      if (res?.ok) setText(res.data)
      else if (res) setError(res.error)
    })
  }, [open, workspacePath])

  const remove = async (note: WorkspaceMemoryNote): Promise<void> => {
    const ok = await confirm(`Delete ${note.path}? New tasks no longer see it. This can’t be undone.`, {
      title: 'Delete note?',
      confirmLabel: 'Delete',
      danger: true
    })
    if (!ok) return
    const res = await window.vyotiq.workspaceMemoryNoteDelete({ workspacePath, path: note.path })
    if (!res.ok) {
      setError(res.error)
      return
    }
    if (open === note.path) setOpen(null)
    load()
    onChanged()
  }

  if (!notes || notes.length === 0) return dialog ?? null
  return (
    <div className="w-full" data-memory-notes>
      {error ? (
        <p role="alert" className="m-0 mb-1 text-xs text-danger">
          {error}
        </p>
      ) : null}
      <ul className="m-0 list-none p-0">
        {notes.map((note) => {
          const expanded = open === note.path
          return (
            <li key={note.path} className={cn('border-b', BORDER_DIVIDER)} data-memory-note={note.path}>
              <div className="flex items-center gap-2 py-1.5">
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setOpen(expanded ? null : note.path)}
                  className="flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left text-xs focus-visible:vy-focus-ring"
                >
                  <Icon name={expanded ? 'chevron' : 'chevronRight'} size={11} className="shrink-0 text-tertiary" />
                  <span className="min-w-0 flex-1 truncate text-fg">{note.title || note.path}</span>
                  {!note.indexed ? (
                    <span className="shrink-0 text-caption text-warning" title="index.md does not point at this note, so tasks may not find it">
                      not indexed
                    </span>
                  ) : null}
                  <span className="shrink-0 font-mono text-caption text-tertiary tnum">
                    {note.path.replace(/^notes\//, '')} · {kb(note.bytes)} · {relativeTimeAgo(new Date(note.mtimeMs).toISOString())}
                  </span>
                </button>
                <IconButton
                  icon="trash"
                  label={`Delete ${note.path}`}
                  size="xs"
                  tone="muted"
                  onClick={() => void remove(note)}
                />
              </div>
              {expanded ? (
                <pre className="scroll-thin mb-2 max-h-64 overflow-auto whitespace-pre-wrap rounded-md bg-sunken px-3 py-2 font-mono text-caption text-secondary">
                  {text ?? 'Reading…'}
                </pre>
              ) : null}
            </li>
          )
        })}
      </ul>
      {dialog}
    </div>
  )
}
