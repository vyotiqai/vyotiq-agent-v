import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { extraRootFor, extraRootLabel, isAbsolutePathLike, relativeToExtraRoot } from '@shared/extraRoots'
import { Icon } from '@renderer/lib/icons'
import { DiffStat, cn } from '@renderer/lib/ui'
import { BORDER_DIVIDER, ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { FileBadge } from '@renderer/features/chat/components/FileBadge'
import type { DiffLayout } from '@renderer/features/chat/components/DiffPreview'
import type { DiffLine } from '@renderer/features/chat/toolUi'
import {
  FileDiffBody,
  STATUS_TONE,
  STATUS_WORD,
  splitPath,
  useFileDiff,
  type ChangesListFile,
  type FileDiffSource
} from './ChangesList'
import type { AskTarget, HunkActions } from './ReviewDiffTable'

/**
 * Where one file's diff comes from: lines already in hand, or a source to ask.
 * `hunks`, when this file's hunks can be undone one at a time.
 */
export type ColumnDiffSource = {
  lines?: DiffLine[] | null
  fetchDiff?: FileDiffSource
  binary?: boolean
  hunks?: HunkActions
}

/** How far ahead of the visible part of the column a file's diff is asked for. */
const PRELOAD_MARGIN = '600px 0px'

/**
 * Whether an element has come near its scroll root yet. Once it has, it stays
 * true: a diff read once is kept, not asked for again on every scroll. Where
 * nothing can observe (tests), everything counts as near.
 */
function useSeen(ref: RefObject<HTMLElement | null>, root: RefObject<HTMLElement | null>): boolean {
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined')
  useEffect(() => {
    if (seen) return undefined
    const el = ref.current
    if (!el) return undefined
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        setSeen(true)
        observer.disconnect()
      },
      { root: root.current, rootMargin: PRELOAD_MARGIN }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [seen, ref, root])
  return seen
}

/** Files keyed by an absolute path in no listed added folder. */
const OUTSIDE = 'Outside the workspace'

type FileGroup = { root: string | null; files: ChangesListFile[] }

/**
 * Workspace files first, then one group per added folder (extraRoots.ts),
 * whose files the task's checkpoints key by absolute path. A list with no
 * such file is one group, drawn exactly as before.
 */
export function groupFilesByRoot(files: readonly ChangesListFile[], extraRoots: readonly string[] = []): FileGroup[] {
  if (!files.some((f) => isAbsolutePathLike(f.path))) return [{ root: null, files: [...files] }]
  const byRoot = new Map<string | null, ChangesListFile[]>([[null, []]])
  for (const file of files) {
    const root = isAbsolutePathLike(file.path) ? (extraRootFor(file.path, extraRoots) ?? OUTSIDE) : null
    const list = byRoot.get(root) ?? []
    list.push(file)
    byRoot.set(root, list)
  }
  return [...byRoot].filter(([, list]) => list.length > 0).map(([root, list]) => ({ root, files: list }))
}

/**
 * The changed files as one scrolling column: each file's header — status,
 * name, its counts or what was decided — sticks while its diff scrolls under
 * it, and folds the diff away. The headers are the file list; there is no
 * second one to keep in step. An undone file starts folded: it is back as it
 * was, so there is nothing left to read.
 */
export function ChangesColumn({
  files,
  selectedPath,
  revealToken = 0,
  onSelect,
  actions,
  source,
  layout,
  wordWrap,
  findQuery,
  onAsk,
  slot,
  className,
  extraRoots
}: {
  files: readonly ChangesListFile[]
  /** The task's added folders: files in one are grouped under it, paths shown relative to it. */
  extraRoots?: readonly string[]
  /** The file you are on: the one last opened, folded, or sent here from elsewhere. */
  selectedPath: string | null
  /** Bumped to bring the selected file into view and open it (Open in Changes). */
  revealToken?: number
  onSelect: (path: string) => void
  /** Revealed on hover and focus, in place of the counts. */
  actions?: (file: ChangesListFile) => ReactNode
  source: (file: ChangesListFile) => ColumnDiffSource
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
  onAsk?: (target: AskTarget, question: string) => void
  /** Anything that belongs between a file's header and its diff (a conflict). */
  slot?: (file: ChangesListFile) => ReactNode
  className?: string
}) {
  const rootRef = useRef<HTMLDivElement>(null)
  const groups = useMemo(() => groupFilesByRoot(files, extraRoots), [files, extraRoots])
  const block = (file: ChangesListFile, root: string | null): ReactNode => (
          <FileBlock
            key={file.path}
            file={file}
            root={root && root !== OUTSIDE ? root : undefined}
            on={file.path === selectedPath}
            revealToken={revealToken}
            onSelect={onSelect}
            actions={actions?.(file) ?? null}
            source={source(file)}
            layout={layout}
            wordWrap={wordWrap}
            findQuery={findQuery}
            onAsk={onAsk}
            slot={slot?.(file) ?? null}
            rootRef={rootRef}
          />
  )
  return (
    <div ref={rootRef} className={cn('scroll-thin min-h-0 flex-1 overflow-y-auto', className)} data-changes-column>
      <ul className="m-0 list-none p-0" aria-label="Changed files" data-changes-list>
        {groups.map((group) =>
          group.root === null ? (
            group.files.map((file) => block(file, null))
          ) : (
            <Fragment key={group.root}>
              {/* An added folder's files, under its name: not part of the workspace's git. */}
              <li
                className={cn('flex h-8 min-w-0 items-center gap-2 border-b pl-3 pr-3', BORDER_DIVIDER)}
                title={group.root === OUTSIDE ? undefined : group.root}
                data-change-root={group.root}
              >
                <Icon name="folder" size={13} className="shrink-0 text-tertiary" />
                <span className="shrink-0 text-xs font-semibold text-fg">
                  {group.root === OUTSIDE ? OUTSIDE : extraRootLabel(group.root)}
                </span>
                {group.root === OUTSIDE ? null : (
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-tertiary">{group.root}</span>
                )}
              </li>
              {group.files.map((file) => block(file, group.root))}
            </Fragment>
          )
        )}
      </ul>
    </div>
  )
}

function FileBlock({
  file,
  on,
  revealToken,
  onSelect,
  actions,
  source,
  layout,
  wordWrap,
  findQuery,
  onAsk,
  slot,
  rootRef,
  root
}: {
  file: ChangesListFile
  /** The added folder this file is in: its folder is shown relative to it. */
  root?: string
  on: boolean
  revealToken: number
  onSelect: (path: string) => void
  actions: ReactNode
  source: ColumnDiffSource
  layout: DiffLayout
  wordWrap: boolean
  findQuery: string
  onAsk?: (target: AskTarget, question: string) => void
  slot: ReactNode
  rootRef: RefObject<HTMLElement | null>
}) {
  const undone = file.resolution === 'undone'
  const [open, setOpen] = useState(!undone)
  // Undoing a file folds it; bringing nothing back unfolds nothing.
  useEffect(() => {
    if (undone) setOpen(false)
  }, [undone])

  const ref = useRef<HTMLLIElement>(null)
  // A reveal is for the file selected when it is asked for, once: selecting
  // another file later must not hand it an old one. Mounted as the selected
  // file with a reveal pending (the column opening on it), it takes that one.
  const handledRef = useRef(on ? 0 : revealToken)
  useEffect(() => {
    if (revealToken <= 0 || revealToken === handledRef.current) return
    handledRef.current = revealToken
    if (!on) return
    setOpen(true)
    ref.current?.scrollIntoView?.({ block: 'start' })
    // `on` is read at the moment of the reveal, not watched: selecting is not revealing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealToken])

  const seen = useSeen(ref, rootRef)
  const diff = useFileDiff(file.path, source.lines, seen && open ? source.fetchDiff : undefined, source.binary)
  const { name, dir } = splitPath(root ? relativeToExtraRoot(file.path, root) : file.path)
  const trailing = actions ? 'shrink-0 pr-3 group-focus-within:hidden group-hover:hidden' : 'shrink-0 pr-3'

  return (
    <li ref={ref} className={cn('border-b', BORDER_DIVIDER)} data-change-file={file.path}>
      <div
        className={cn(
          'group sticky top-0 z-sticky flex h-9 min-w-0 items-center vy-transition',
          on ? SELECTED : cn('bg-bg', ROW_HOVER)
        )}
        data-change-row={file.path}
      >
        <button
          type="button"
          aria-expanded={open}
          aria-current={on || undefined}
          aria-label={`${file.path}, ${STATUS_WORD[file.status].toLowerCase()}`}
          title={file.path}
          className="flex h-full min-w-0 flex-1 items-center gap-2 pl-3 pr-2 text-left focus-visible:vy-focus-ring"
          onClick={() => {
            onSelect(file.path)
            setOpen((value) => !value)
          }}
        >
          <Icon name={open ? 'chevron' : 'chevronRight'} size={11} className="shrink-0 text-tertiary" />
          <span
            className={cn('w-3 shrink-0 font-mono text-caption font-semibold', STATUS_TONE[file.status])}
            title={STATUS_WORD[file.status]}
          >
            {file.status}
          </span>
          <FileBadge path={file.path} />
          <span
            className={cn(
              'shrink-0 text-xs',
              file.status === 'D' || undone ? 'text-muted line-through decoration-tertiary' : 'text-fg'
            )}
          >
            {name}
          </span>
          <span className="min-w-0 flex-1 truncate text-caption text-tertiary">{dir}</span>
        </button>
        {file.note ? (
          <span className={cn(trailing, 'text-caption', file.noteTone === 'warning' ? 'text-warning' : 'text-tertiary')}>
            {file.note}
          </span>
        ) : file.added != null && file.removed != null ? (
          <DiffStat add={file.added} del={file.removed} className={trailing} />
        ) : null}
        {actions ? (
          <span className="hidden shrink-0 items-center gap-1 pr-2 group-focus-within:flex group-hover:flex">{actions}</span>
        ) : null}
      </div>
      {open ? (
        <>
          {slot}
          <div
            className="scroll-thin overflow-x-auto bg-sunken py-1 font-mono text-xs leading-[18px]"
            data-change-diff={file.path}
            data-diff-scroll-root
          >
            {seen ? (
              <FileDiffBody
                path={file.path}
                diff={diff}
                layout={layout}
                wordWrap={wordWrap}
                findQuery={findQuery}
                added={file.status === 'A' || file.status === '?'}
                onAsk={onAsk}
                hunkActions={source.hunks}
              />
            ) : (
              <div className="h-16" aria-hidden />
            )}
          </div>
        </>
      ) : null}
    </li>
  )
}
