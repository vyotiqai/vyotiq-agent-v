import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Tooltip, cn } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'
import { FileBadge } from './FileBadge'
import { DiffPreview, type DiffLayout } from './DiffPreview'
import { basename, parseUnifiedDiff, type DiffLine } from '../toolUi'
import { useRunSession } from '../RunSessionContext'
import type { WorkspaceFileOpenOptions } from './FilesPanel'

/** Normalized file entry for git or PR change lists. */
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

/** Match DiffPreview’s expanded cap so we don’t parse more than we render. */
const DIFF_PREVIEW_MAX_LINES = 1000
const MAX_CONCURRENT_DIFF_FETCHES = 2

/** Main returns these when git has no patch; do not parse them as diff text. */
function isEmptyDiffSentinel(content: string): boolean {
  const t = content.trim()
  return (
    t === '(no unstaged changes)' ||
    t === '(no staged changes)' ||
    t === '(no uncommitted changes)' ||
    t === '(no changes in commit)'
  )
}

let activeDiffFetches = 0
const pendingDiffFetches: Array<() => void> = []

function runDiffFetch<T>(task: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const start = () => {
      activeDiffFetches += 1
      task().then(resolve, reject).finally(() => {
        activeDiffFetches -= 1
        const next = pendingDiffFetches.shift()
        if (next) next()
      })
    }
    if (activeDiffFetches < MAX_CONCURRENT_DIFF_FETCHES) start()
    else pendingDiffFetches.push(start)
  })
}

function statusLetterClass(letter: BrowserFileEntry['statusLetter']): string {
  if (letter === 'A') return 'text-success'
  if (letter === 'D') return 'text-danger'
  return 'text-muted'
}

function FileDiffBody({
  path,
  binary,
  expanded,
  fetchDiff,
  layout,
  wordWrap,
  findQuery
}: {
  path: string
  binary?: boolean
  expanded: boolean
  fetchDiff: (path: string) => Promise<{ content: string } | { error: string }>
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  const [lines, setLines] = useState<DiffLine[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded) {
      setInView(false)
      return undefined
    }
    const el = rootRef.current
    if (!el || typeof IntersectionObserver === 'undefined') {
      setInView(true)
      return undefined
    }
    const scrollRoot = el.closest('[data-diff-scroll-root]')
    const root = scrollRoot instanceof HTMLElement ? scrollRoot : null
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setInView(true)
            break
          }
        }
      },
      { root, rootMargin: '160px 0px', threshold: 0 }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [expanded])

  useEffect(() => {
    if (!expanded || !inView) return
    let cancelled = false
    setLoading(true)
    setDiffError(null)
    void runDiffFetch(() => fetchDiff(path))
      .then((res) => {
        if (cancelled) return
        if ('error' in res) {
          setLines([])
          setDiffError(res.error)
          return
        }
        if (isEmptyDiffSentinel(res.content)) {
          setLines([])
          setDiffError(null)
          return
        }
        setDiffError(null)
        setLines(parseUnifiedDiff(res.content, DIFF_PREVIEW_MAX_LINES + 1))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [expanded, inView, path, fetchDiff])

  if (!expanded) return null
  return (
    <div ref={rootRef} className="bg-surface-2/20 px-3 py-1.5">
      {loading || (!inView && !lines) ? (
        <p className="m-0 py-1 text-caption text-muted">Loading diff…</p>
      ) : lines && lines.length > 0 ? (
        <DiffPreview
          lines={lines}
          path={path}
          expanded
          layout={layout}
          findQuery={findQuery}
          wordWrap={wordWrap}
        />
      ) : (
        <p className="m-0 py-1 text-caption text-muted">
          {diffError ? diffError : binary ? 'Binary file' : 'No textual diff'}
        </p>
      )}
    </div>
  )
}

function StageControls({
  file,
  busy,
  onStage,
  onUnstage,
  canStage,
  canUnstage
}: {
  file: BrowserFileEntry
  busy?: boolean
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  canStage: (file: BrowserFileEntry) => boolean
  canUnstage: (file: BrowserFileEntry) => boolean
}) {
  const showStage = canStage(file)
  const showUnstage = canUnstage(file)
  if (!showStage && !showUnstage) return null
  return (
    <span className="flex shrink-0 items-center gap-0.5">
      {showStage ? (
        <Tooltip content="Stage file">
          <button
            type="button"
            className="rounded px-1 text-2xs text-muted hover:bg-surface-2 hover:text-fg disabled:vy-disabled-state"
            disabled={busy}
            aria-label={`Stage ${file.path}`}
            onClick={(e) => {
              e.stopPropagation()
              onStage(file.path)
            }}
          >
            Stage
          </button>
        </Tooltip>
      ) : null}
      {showUnstage ? (
        <Tooltip content="Unstage file">
          <button
            type="button"
            className="rounded px-1 text-2xs text-muted hover:bg-surface-2 hover:text-fg disabled:vy-disabled-state"
            disabled={busy}
            aria-label={`Unstage ${file.path}`}
            onClick={(e) => {
              e.stopPropagation()
              onUnstage(file.path)
            }}
          >
            Unstage
          </button>
        </Tooltip>
      ) : null}
    </span>
  )
}

function pathLabel(path: string): { dir: string | null; name: string } {
  const normalized = path.replace(/\\/g, '/')
  const name = basename(normalized)
  const slash = normalized.lastIndexOf('/')
  if (slash <= 0) return { dir: null, name }
  return { dir: normalized.slice(0, slash + 1), name }
}

type StageActions = {
  busy?: boolean
  onStage: (path: string) => void
  onUnstage: (path: string) => void
  canStage: (file: BrowserFileEntry) => boolean
  canUnstage: (file: BrowserFileEntry) => boolean
}

function FileRow({
  file,
  selected,
  expanded,
  onSelect,
  onToggle,
  fetchDiff,
  layout,
  wordWrap,
  findQuery,
  stageActions,
  viewed,
  onToggleViewed,
  workspacePath,
  onOpenFile
}: {
  file: BrowserFileEntry
  selected: boolean
  expanded: boolean
  onSelect: () => void
  onToggle: () => void
  fetchDiff: (path: string) => Promise<{ content: string } | { error: string }>
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
  stageActions?: StageActions
  viewed?: boolean
  onToggleViewed?: () => void
  workspacePath?: string | null
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
}) {
  const runSession = useRunSession()
  const openWorkspaceFile =
    onOpenFile ??
    runSession.onOpenWorkspaceFile ??
    (workspacePath
      ? (path: string) => {
          void window.vyotiq?.slashCommandsOpenFile?.({ workspacePath, path })
        }
      : undefined)

  const label = pathLabel(file.path)
  return (
    <li
      className={cn(
        'min-w-0 border-b border-border/40 last:border-b-0',
        selected && 'bg-accent/10'
      )}
    >
      <div
        className={cn(
          'sticky top-0 z-sticky flex w-full min-w-0 items-center gap-1.5 border-b border-transparent bg-surface px-3 py-1.5 text-xs',
          expanded && 'border-border/40',
          selected ? 'bg-accent/10' : 'hover:bg-surface-2/80'
        )}
      >
        <button
          type="button"
          className="grid size-5 shrink-0 place-items-center rounded text-tertiary vy-transition hover:bg-surface-2 hover:text-fg"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse diff for ${file.path}` : `Show diff for ${file.path}`}
          onClick={() => {
            onSelect()
            onToggle()
          }}
        >
          <Icon
            name="chevronRight"
            size={12}
            className={cn('vy-transition', expanded && 'rotate-90')}
          />
        </button>
        <span
          className={cn(
            'w-3 shrink-0 text-center font-mono text-2xs',
            statusLetterClass(file.statusLetter)
          )}
        >
          {file.statusLetter}
        </span>
        <FileBadge path={file.path} />
        {openWorkspaceFile ? (
          <button
            type="button"
            className="min-w-0 flex-1 truncate rounded-sm text-left text-fg vy-transition hover:underline hover:underline-offset-2"
            title={file.path}
            aria-label={`Open ${file.path}`}
            onClick={(e) => {
              e.stopPropagation()
              onSelect()
              openWorkspaceFile(file.path)
            }}
          >
            {label.dir ? <span className="text-muted">{label.dir}</span> : null}
            <span className="font-medium">{label.name}</span>
          </button>
        ) : (
          <span className="min-w-0 flex-1 truncate text-fg" title={file.path}>
            {label.dir ? <span className="text-muted">{label.dir}</span> : null}
            <span className="font-medium">{label.name}</span>
          </span>
        )}
        <span className="shrink-0 tabular-nums text-caption">
          {file.added > 0 ? <span className="text-success">+{file.added}</span> : null}
          {file.removed > 0 ? (
            <span className="ml-1 text-danger">-{file.removed}</span>
          ) : null}
        </span>
        {file.statusLabel ? (
          <span
            className={cn(
              'shrink-0 rounded-sm border border-border/60 bg-surface-2/40 px-1 leading-4 text-2xs',
              file.statusTone === 'success' ? 'text-success' : 'text-muted'
            )}
          >
            {file.statusLabel}
          </span>
        ) : null}
        {openWorkspaceFile ? (
          <Tooltip content={`Open diff for ${file.path}`}>
            <button
              type="button"
              className="shrink-0 rounded px-1 text-2xs text-muted vy-transition hover:bg-surface-2 hover:text-fg"
              aria-label={`Open diff for ${file.path}`}
              onClick={(e) => {
                e.stopPropagation()
                openWorkspaceFile(file.path, { mode: 'diff' })
              }}
            >
              Diff
            </button>
          </Tooltip>
        ) : null}
        {stageActions ? <StageControls file={file} {...stageActions} /> : null}
        {onToggleViewed ? (
          <input
            type="checkbox"
            className="size-3.5 shrink-0 accent-accent"
            checked={Boolean(viewed)}
            aria-label={`Mark ${file.path} as viewed`}
            onChange={onToggleViewed}
            onClick={(e) => e.stopPropagation()}
          />
        ) : null}
      </div>
      <FileDiffBody
        path={file.path}
        binary={file.binary}
        expanded={expanded}
        fetchDiff={fetchDiff}
        layout={layout}
        wordWrap={wordWrap}
        findQuery={findQuery}
      />
    </li>
  )
}

/**
 * Single-column changed-files list: path rows with inline expandable diffs.
 */
export function ChangedFilesBrowser({
  files,
  totals,
  header,
  expanded,
  onToggleExpand,
  selectedPath,
  onSelectPath,
  fetchDiff,
  layout,
  wordWrap,
  findQuery,
  stageActions,
  viewedPaths,
  onToggleViewed,
  workspacePath,
  onOpenFile,
  /** When false, list grows with content; parent owns scrolling. */
  ownScroll = true,
  className
}: {
  files: BrowserFileEntry[]
  totals?: { added: number; removed: number }
  header?: ReactNode
  expanded: Set<string>
  onToggleExpand: (path: string) => void
  selectedPath: string | null
  onSelectPath: (path: string) => void
  fetchDiff: (path: string) => Promise<{ content: string } | { error: string }>
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
  stageActions?: StageActions
  viewedPaths?: Set<string>
  onToggleViewed?: (path: string) => void
  workspacePath?: string | null
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  ownScroll?: boolean
  className?: string
}) {
  const added = totals?.added ?? files.reduce((s, f) => s + f.added, 0)
  const removed = totals?.removed ?? files.reduce((s, f) => s + f.removed, 0)
  const sorted = useMemo(
    () =>
      [...files].sort((a, b) =>
        a.path.replace(/\\/g, '/').localeCompare(b.path.replace(/\\/g, '/'))
      ),
    [files]
  )

  return (
    <div
      className={cn(
        'flex flex-col overflow-hidden rounded-md border border-border/50 bg-surface',
        ownScroll ? 'min-h-0' : 'shrink-0',
        className
      )}
    >
      <div className="shrink-0 border-b border-border/40 px-3 py-1.5 text-caption text-fg">
        {header ?? (
          <>
            {files.length} {files.length === 1 ? 'File Changed' : 'Files Changed'}
            {added > 0 ? <span className="ml-2 text-success">+{added}</span> : null}
            {removed > 0 ? <span className="ml-1 text-danger">-{removed}</span> : null}
          </>
        )}
      </div>
      <ul
        className={cn(
          'm-0 list-none p-0',
          ownScroll ? 'min-h-0 flex-1 overflow-auto' : 'overflow-visible'
        )}
        data-diff-scroll-root={ownScroll ? '' : undefined}
      >
        {sorted.map((file) => (
          <FileRow
            key={file.path}
            file={file}
            selected={selectedPath === file.path}
            expanded={expanded.has(file.path)}
            onSelect={() => onSelectPath(file.path)}
            onToggle={() => onToggleExpand(file.path)}
            fetchDiff={fetchDiff}
            layout={layout}
            wordWrap={wordWrap}
            findQuery={findQuery}
            stageActions={stageActions}
            viewed={viewedPaths?.has(file.path)}
            onToggleViewed={onToggleViewed ? () => onToggleViewed(file.path) : undefined}
            workspacePath={workspacePath}
            onOpenFile={onOpenFile}
          />
        ))}
      </ul>
    </div>
  )
}
