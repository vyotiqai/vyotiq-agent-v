import { memo, useState } from 'react'
import { cn } from '@renderer/lib/ui'
import { TOOL_CARD_HEADER, TOOL_CARD_SURFACE } from '@renderer/lib/utils/layout'
import type { ChangedFile } from '../utils/transcriptRows'
import { basename } from '../toolUi'
import { FileBadge } from './FileBadge'
import { useRunSession } from '../RunSessionContext'
import type { WorkspaceFileOpenOptions } from './FilesPanel'

/** Transcript compact receipt: first N rows, then “… Show N more”. */
export const COMPACT_PREVIEW_COUNT = 4

function ChangeFileName({
  path,
  onOpenFile
}: {
  path: string
  /** Dock panels render outside RunSessionProvider — prefer the explicit prop. */
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const { onOpenWorkspaceFile } = useRunSession()
  const open = onOpenFile ?? onOpenWorkspaceFile
  const label = basename(path)
  if (!open) {
    return (
      <span className="min-w-0 truncate text-fg" title={path}>
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="min-w-0 truncate text-left text-fg underline-offset-2 hover:underline"
      title={path}
      onClick={() => {
        open(path)
      }}
    >
      {label}
    </button>
  )
}

function FileActionBadge({
  action
}: {
  action?: ChangedFile['action']
}) {
  if (action === 'created') {
    return <span className="text-2xs text-success">New</span>
  }
  if (action === 'deleted') {
    return <span className="text-2xs text-muted">Deleted</span>
  }
  return null
}

/**
 * The record's receipt for a turn's writes: the first few files, Review to open
 * the Changes tab. Keep and Undo live in the Changes tab, not here.
 */
export const ChangeSummary = memo(function ChangeSummary({
  files,
  onOpenChanges,
  onOpenFile
}: {
  files: ChangedFile[]
  onOpenChanges?: (path?: string) => void
  /** Open the file in the workspace editor (dock panels live outside RunSessionProvider). */
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const [showAll, setShowAll] = useState(false)

  if (files.length === 0) return null

  const allCreated = files.every((file) => file.action === 'created')
  const allDeleted = files.every((file) => file.action === 'deleted')
  const title = allCreated
    ? `${files.length} ${files.length === 1 ? 'File Created' : 'Files Created'}`
    : allDeleted
      ? `${files.length} ${files.length === 1 ? 'File Deleted' : 'Files Deleted'}`
      : `${files.length} ${files.length === 1 ? 'File Changed' : 'Files Changed'}`

  const visible = showAll ? files : files.slice(0, COMPACT_PREVIEW_COUNT)
  const hiddenCount = files.length - COMPACT_PREVIEW_COUNT
  const canToggleMore = hiddenCount > 0

  return (
    <div className={cn(TOOL_CARD_SURFACE, 'w-full')} data-change-summary="receipt">
      <div className={cn(TOOL_CARD_HEADER, 'flex items-center gap-2 border-b border-border text-fg')}>
        <span className="min-w-0 truncate font-medium">{title}</span>
        {onOpenChanges ? (
          <button
            type="button"
            className="ml-auto shrink-0 text-tertiary vy-transition hover:text-fg"
            onClick={() => onOpenChanges()}
            aria-label="Review changes"
          >
            Review
          </button>
        ) : null}
      </div>
      <ul className="m-0 list-none p-0">
        {visible.map((file) => (
          <li key={file.path} className="min-w-0 [&+&]:border-t [&+&]:border-border/60">
            <div className="flex min-w-0 items-center gap-2 px-3 py-1.5 text-xs">
              <FileBadge path={file.path} />
              {onOpenChanges ? (
                <button
                  type="button"
                  className="min-w-0 truncate text-left text-fg underline-offset-2 hover:underline"
                  title={file.path}
                  onClick={() => onOpenChanges(file.path)}
                >
                  {basename(file.path)}
                </button>
              ) : (
                <ChangeFileName path={file.path} onOpenFile={onOpenFile} />
              )}
              <span className="ml-auto flex shrink-0 items-center gap-2 tabular-nums">
                {(file.added ?? 0) > 0 ? <span className="text-success">+{file.added}</span> : null}
                {(file.removed ?? 0) > 0 ? <span className="text-danger">-{file.removed}</span> : null}
                <FileActionBadge action={file.action} />
              </span>
            </div>
          </li>
        ))}
      </ul>
      {canToggleMore ? (
        <button
          type="button"
          className="flex w-full items-center border-t border-border/60 px-3 py-1.5 text-left text-xs text-tertiary vy-transition hover:bg-surface hover:text-fg"
          onClick={() => setShowAll((prev) => !prev)}
          aria-expanded={showAll}
        >
          {showAll ? 'Show less' : `… Show ${hiddenCount} more`}
        </button>
      ) : null}
    </div>
  )
})
