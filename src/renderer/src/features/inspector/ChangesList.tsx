import { useEffect, useState, type ReactNode } from 'react'
import { DiffStat, IconButton, cn } from '@renderer/lib/ui'
import { FileBadge } from '@renderer/features/chat/components/FileBadge'
import { DiffPreview, type DiffLayout } from '@renderer/features/chat/components/DiffPreview'
import { basename, parseUnifiedDiff, type DiffLine } from '@renderer/features/chat/toolUi'

/** Match DiffPreview's expanded cap so we don't parse more than we render. */
const DIFF_MAX_LINES = 1000

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | '?'

const STATUS_TONE: Record<ChangeStatus, string> = {
  M: 'text-muted',
  A: 'text-success',
  D: 'text-danger',
  R: 'text-accent',
  C: 'text-warning',
  '?': 'text-muted'
}

const STATUS_WORD: Record<ChangeStatus, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Conflicted',
  '?': 'Changed'
}

/** A git or PR change as the panels normalise it before listing. */
export type BrowserFileEntry = {
  path: string
  /** Letter status (A / M / D / …). */
  statusLetter: 'A' | 'M' | 'D' | 'R' | 'C' | '?'
  /** Badge text (New / Deleted / Modified / …). */
  statusLabel: string | null
  statusTone?: 'success' | 'muted'
  added: number
  removed: number
  binary?: boolean
  staged?: boolean
  unstaged?: boolean
}

export type ChangesListFile = {
  path: string
  status: ChangeStatus
  added: number
  removed: number
  /** Said where the counts go once there is nothing left to decide ("Kept"). */
  note?: string
  noteTone?: 'quiet' | 'warning'
}

/** Git answers these when it has no patch; they are not diff text. */
export function isEmptyDiffSentinel(content: string): boolean {
  const t = content.trim()
  return (
    t === '(no unstaged changes)' ||
    t === '(no staged changes)' ||
    t === '(no uncommitted changes)' ||
    t === '(no changes in commit)'
  )
}

function splitPath(path: string): { name: string; dir: string } {
  const normalized = path.replace(/\\/g, '/')
  const slash = normalized.lastIndexOf('/')
  return slash >= 0 ? { name: normalized.slice(slash + 1), dir: normalized.slice(0, slash) } : { name: normalized, dir: '' }
}

/**
 * The changed files, one 28px row each: status letter, file icon, name, then
 * its folder quiet. The counts give way to the row's actions on hover.
 */
export function ChangesList({
  files,
  selectedPath,
  onSelect,
  actions,
  className
}: {
  files: readonly ChangesListFile[]
  selectedPath: string | null
  onSelect: (path: string) => void
  /** Revealed on hover and focus, in place of the counts. */
  actions?: (file: ChangesListFile) => ReactNode
  className?: string
}) {
  return (
    <ul className={cn('m-0 list-none py-1', className)} aria-label="Changed files" data-changes-list>
      {files.map((file) => {
        const { name, dir } = splitPath(file.path)
        const on = file.path === selectedPath
        const rowActions = actions?.(file) ?? null
        const trailing = rowActions ? 'shrink-0 pr-3 group-focus-within:hidden group-hover:hidden' : 'shrink-0 pr-3'
        return (
          <li
            key={file.path}
            className={cn('group flex h-7 min-w-0 items-center vy-transition', on ? 'bg-surface-2' : 'hover:bg-surface')}
            data-change-row={file.path}
          >
            <button
              type="button"
              aria-current={on || undefined}
              aria-label={`${file.path}, ${STATUS_WORD[file.status].toLowerCase()}`}
              title={file.path}
              className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-2 text-left focus-visible:vy-focus-ring"
              onClick={() => onSelect(file.path)}
            >
              <span
                className={cn('w-3 shrink-0 font-mono text-caption font-semibold', STATUS_TONE[file.status])}
                title={STATUS_WORD[file.status]}
              >
                {file.status}
              </span>
              <FileBadge path={file.path} />
              <span className={cn('shrink-0 text-xs', file.status === 'D' ? 'text-muted line-through' : 'text-fg')}>
                {name}
              </span>
              <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{dir}</span>
            </button>
            {file.note ? (
              <span className={cn(trailing, 'text-caption', file.noteTone === 'warning' ? 'text-warning' : 'text-tertiary')}>
                {file.note}
              </span>
            ) : (
              <DiffStat add={file.added} del={file.removed} className={trailing} />
            )}
            {rowActions ? (
              <span className="hidden shrink-0 items-center gap-0.5 pr-2 group-focus-within:flex group-hover:flex">
                {rowActions}
              </span>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The selected file's diff under a 32px header that names it and steps to the
 * previous or next file. Lines come either ready (the agent's own edit) or
 * from `fetchDiff` (git's view of the file).
 */
export function ChangeDiff({
  path,
  lines,
  fetchDiff,
  binary = false,
  layout,
  wordWrap,
  findQuery,
  onOpen,
  onPrev,
  onNext,
  children
}: {
  path: string
  lines?: DiffLine[] | null
  fetchDiff?: (path: string) => Promise<{ content: string } | { error: string }>
  binary?: boolean
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
  onOpen?: () => void
  onPrev?: () => void
  onNext?: () => void
  /** Anything that belongs between the header and the diff (a conflict). */
  children?: ReactNode
}) {
  const [fetched, setFetched] = useState<{ path: string; lines: DiffLine[]; error: string | null } | null>(null)
  const needsFetch = !(lines && lines.length > 0) && Boolean(fetchDiff)

  useEffect(() => {
    if (!needsFetch || !fetchDiff) return undefined
    let cancelled = false
    setFetched(null)
    void fetchDiff(path).then((res) => {
      if (cancelled) return
      if ('error' in res) {
        setFetched({ path, lines: [], error: res.error })
        return
      }
      setFetched({
        path,
        lines: isEmptyDiffSentinel(res.content) ? [] : parseUnifiedDiff(res.content, DIFF_MAX_LINES + 1),
        error: null
      })
    })
    return () => {
      cancelled = true
    }
  }, [fetchDiff, needsFetch, path])

  const ready = lines && lines.length > 0 ? lines : fetched?.path === path ? fetched.lines : null
  const loading = needsFetch && fetched?.path !== path
  const error = fetched?.path === path ? fetched.error : null

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-change-diff>
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2 text-xs">
        <FileBadge path={path} size={13} />
        <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg" title={path}>
          {path}
        </span>
        {onOpen ? <IconButton icon="external" label={`Open ${basename(path)}`} size="xs" tone="muted" onClick={onOpen} /> : null}
        <IconButton icon="chevronUp" label="Previous file" size="xs" tone="muted" disabled={!onPrev} onClick={onPrev} />
        <IconButton icon="chevron" label="Next file" size="xs" tone="muted" disabled={!onNext} onClick={onNext} />
      </div>
      {children}
      <div className="scroll-thin min-h-0 flex-1 overflow-auto bg-sunken py-1" data-diff-scroll-root>
        {loading ? (
          <p className="m-0 px-3 py-2 text-xs text-muted">Loading diff…</p>
        ) : ready && ready.length > 0 ? (
          <DiffPreview lines={ready} path={path} expanded layout={layout} findQuery={findQuery} wordWrap={wordWrap} />
        ) : (
          <p className="m-0 px-3 py-2 text-xs text-muted">{error ?? (binary ? 'Binary file' : 'No textual diff')}</p>
        )}
      </div>
    </div>
  )
}
