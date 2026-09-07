import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import {
  WORKSPACE_FILE_BINARY_MAX_BYTES,
  type GitBlameResult,
  type WorkspaceEditorRecoverySnapshot,
  type WorkspaceEditorRecoveryLoadResult,
  type WorkspaceFileEncoding,
  type WorkspaceFileEntry,
  type WorkspaceFileEol,
  type WorkspaceFileListResult,
  type WorkspaceFileReadResult,
  type WorkspaceFormatterStatus,
  type WorkspaceLspResponse,
  type WorkspaceLspStatus,
  type WorkspaceEditorSelection
} from '@shared/ipc'
import { useAppVirtualizer } from '@renderer/lib/hooks/useAppVirtualizer'
import { FileTypeIcon } from '@renderer/lib/fileIcons'
import { Icon } from '@renderer/lib/icons'
import { isIgnoredWorkspaceEntryName } from '@shared/utils/workspaceIgnores'
import {
  ActionMenu,
  IconButton,
  PanelResizeHandle,
  SearchInput,
  cn,
  type ActionMenuItem
} from '@renderer/lib/ui'
import { usePersistedNumber } from '@renderer/lib/hooks/usePersistedNumber'
import { setFocusedFile } from '@renderer/lib/focusedFile'
import { handleTabListKeyDown } from '@renderer/lib/utils/tabListKeyboard'
import { HexEditor } from './HexEditor'
import { TextCodeEditor } from './TextCodeEditor'
import { FilePreview } from './FilePreview'
import { defaultPreviewOpen, filePreviewKind } from './filePreviewKind'
import { type InlineCompleteRequestFn } from './tabAutocomplete'
import { DiffPreview } from './DiffPreview'
import { useWorkspaceLsp } from '../hooks/useWorkspaceLsp'
import { parseUnifiedDiff } from '../toolUi/parsers/edit'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { ContextMenu, type ContextMenuAnchor, type ContextMenuItem } from '@renderer/lib/ui/ContextMenu'
import {
  getFileSession,
  MAX_FILE_SESSION_CONTENT_CHARS,
  MAX_FILE_SESSION_TABS,
  setFileSession,
  useFileSession,
  type FileSession,
  type FileSessionPatch,
  type FileTab
} from './fileSessionStore'
import { DOCK_TOOLBAR_BTN, PANEL_SUBTAB_BAR, dockPanelTabButtonClass, dockPanelTabCloseClass, dockPanelTabShellClass } from './PanelChrome'

type DirectoryState = {
  entries: WorkspaceFileEntry[]
  total: number
  nextOffset: number | null
  truncated: boolean
  loading: boolean
  error: string | null
}

type VisibleEntry =
  | { kind: 'entry'; entry: WorkspaceFileEntry; level: number }
  | {
      kind: 'loadMore'
      parentPath: string
      level: number
      loaded: number
      total: number
    }

function isVisibleTreeEntry(
  item: VisibleEntry
): item is Extract<VisibleEntry, { kind: 'entry' }> {
  return item.kind === 'entry'
}

function findVisibleTreeEntry(
  entries: VisibleEntry[],
  path: string
): WorkspaceFileEntry | undefined {
  for (const item of entries) {
    if (isVisibleTreeEntry(item) && item.entry.path === path) {
      return item.entry
    }
  }
  return undefined
}

function findTreeEntry(
  directories: Record<string, DirectoryState>,
  path: string
): WorkspaceFileEntry | undefined {
  const parent = parentPath(path)
  const entries = directories[parent]?.entries ?? directories['']?.entries
  return entries?.find((entry) => entry.path === path)
}

function lspOffset(text: string, line: number, character: number): number {
  let remaining = line
  let i = 0
  while (remaining > 0 && i < text.length) {
    if (text.charCodeAt(i) === 10) remaining -= 1
    i += 1
  }
  return Math.min(text.length, i + Math.max(0, character))
}

function applyLspTextEdits(
  text: string,
  edits: Array<{
    startLine: number
    startCharacter: number
    endLine: number
    endCharacter: number
    newText: string
  }>
): string {
  const ordered = [...edits].sort(
    (a, b) => b.startLine - a.startLine || b.startCharacter - a.startCharacter
  )
  let next = text
  for (const edit of ordered) {
    const start = lspOffset(next, edit.startLine, edit.startCharacter)
    const end = lspOffset(next, edit.endLine, edit.endCharacter)
    next = next.slice(0, start) + edit.newText + next.slice(Math.max(start, end))
  }
  return next
}

type FilesContextTarget =
  | { kind: 'tree'; path: string; entryKind: WorkspaceFileEntry['kind'] }
  | { kind: 'tab'; tabId: string }
  | { kind: 'surface' }

type FilesContextState = {
  anchor: ContextMenuAnchor
  target: FilesContextTarget
}

type EditorSurfaceMode = 'editor' | 'diff' | 'blame' | 'lsp'

export type WorkspaceFileOpenOptions = {
  line?: number
  column?: number
  mode?: 'editor' | 'diff'
}

export type WorkspaceFileOpenRequest = {
  workspacePath: string
  path: string
} & WorkspaceFileOpenOptions

type WorkspaceOperation = {
  path: string
  epoch: number
}

type FileSaveState = 'saved' | 'pending' | 'saving' | 'error' | 'conflict'
type SaveMode = 'manual' | 'auto' | 'overwrite'

const PAGE_SIZE = 200
const FILES_EXPLORER_WIDTH_KEY = 'vyotiq.files.explorerWidthPx'
const FILES_EXPLORER_WIDTH_MIN = 176
const FILES_EXPLORER_WIDTH_MAX = 360
const FILES_EXPLORER_WIDTH_DEFAULT = 260
const TREE_INDENT_REM = 0.75
const TREE_ROW_HEIGHT_PX = 28
const TREE_ROW_ACTIVE_FILE =
  'bg-accent/15 text-fg ring-1 ring-inset ring-accent/35'
const TREE_ROW_FOCUSED =
  'bg-surface/60 text-fg ring-1 ring-inset ring-border/70'
const FILTER_REVEAL_MAX_DIRS = 120
const FILES_PANEL_ALERT =
  'flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5 text-caption'
const DOCK_TOOLBAR_BTN_PRESSED = 'border-accent/60 bg-accent/10 text-fg'
const TREE_KIND_ORDER: Record<WorkspaceFileEntry['kind'], number> = {
  directory: 0,
  file: 1,
  symlink: 2,
  other: 3
}

function saveStateLabel(state: FileSaveState | undefined): string {
  switch (state) {
    case 'pending':
      return 'Autosave pending'
    case 'saving':
      return 'Saving…'
    case 'error':
      return 'Save failed'
    case 'conflict':
      return 'Changed externally'
    case 'saved':
      return 'Saved'
    case undefined:
      return 'Saved'
    default: {
      const exhaustive: never = state
      return exhaustive
    }
  }
}

function emptyDirectoryState(): DirectoryState {
  return {
    entries: [],
    total: 0,
    nextOffset: 0,
    truncated: false,
    loading: false,
    error: null
  }
}

function isDirectoryEntry(entry: WorkspaceFileEntry): boolean {
  return entry.kind === 'directory'
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '' : path.slice(0, slash)
}

function fileName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? path : path.slice(slash + 1)
}

function workspaceName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).pop() || normalized
}

function pathSegments(path: string): string[] {
  return path.split('/').filter(Boolean)
}

function nestedWorkspaceHint(
  workspacePath: string,
  entries: WorkspaceFileEntry[]
): string | null {
  const name = workspaceName(workspacePath)
  if (!entries.some((entry) => entry.kind === 'directory' && entry.name === name)) {
    return null
  }
  return `Project files may be inside the nested "${name}" folder. Expand it or open that folder as the workspace root.`
}

function EditorBreadcrumb({ path }: { path: string }) {
  const segments = pathSegments(path)
  if (segments.length === 0) {
    return <span className="truncate">Workspace root</span>
  }
  if (segments.length > 3) {
    const middle = segments.slice(1, -1).join('/')
    return (
      <nav
        aria-label="File path"
        className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
        title={path}
      >
        <span className="shrink-0 truncate">{segments[0]}</span>
        <span className="shrink-0 text-muted/70">/</span>
        <span className="shrink-0 text-muted/70" title={middle}>
          …
        </span>
        <span className="shrink-0 text-muted/70">/</span>
        <span className="min-w-0 truncate font-medium text-fg/90">{segments.at(-1)}</span>
      </nav>
    )
  }
  return (
    <nav
      aria-label="File path"
      className="flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden"
      title={path}
    >
      {segments.map((segment, index) => (
        <Fragment key={`${segment}-${index}`}>
          {index > 0 ? <span className="shrink-0 text-muted/70">/</span> : null}
          <span
            className={cn(
              'truncate',
              index === segments.length - 1 ? 'font-medium text-fg/90' : undefined
            )}
          >
            {segment}
          </span>
        </Fragment>
      ))}
    </nav>
  )
}

function absoluteWorkspacePath(workspacePath: string, path: string): string {
  const root = workspacePath.replace(/[\\/]+$/, '')
  return path ? `${root}/${path}` : root
}

function treeElementId(path: string): string {
  return `workspace-file-${encodeURIComponent(path)}`
}

function treeLoadMoreElementId(parentPath: string): string {
  return `workspace-file-load-more-${encodeURIComponent(parentPath)}`
}

/** Pixel x-offset of the nesting guide for ancestor level `ancestor` (1-based). */
function treeGuideOffsetPx(ancestor: number): number {
  return Math.round(ancestor * 16 * TREE_INDENT_REM) - 7
}

function treeIndentStyle(level: number): CSSProperties {
  const paddingLeft = `${Math.max(0, level - 1) * TREE_INDENT_REM + 0.25}rem`
  if (level < 2) return { paddingLeft }
  // One vertical guide per ancestor level, drawn as background layers so the
  // hierarchy stays readable without wrapping the tree in nested containers.
  const guides = Array.from({ length: level - 1 }, (_, index) => index + 1)
  return {
    paddingLeft,
    backgroundImage: guides
      .map(() => 'linear-gradient(to bottom, var(--vy-tree-guide), var(--vy-tree-guide))')
      .join(', '),
    backgroundSize: guides.map(() => '1px 100%').join(', '),
    backgroundPosition: guides.map((ancestor) => `${treeGuideOffsetPx(ancestor)}px 0`).join(', '),
    backgroundRepeat: 'no-repeat'
  }
}

function tabElementId(id: string): string {
  return `workspace-file-tab-${encodeURIComponent(id)}`
}

function fileTabFromRecovery(tab: WorkspaceEditorRecoverySnapshot['tabs'][number]): FileTab {
  return {
    ...tab,
    savedContent: tab.dirty ? null : tab.content,
    conflict: false,
    scrollTop: tab.scrollTop ?? 0,
    revision: 0
  }
}

function recoveryFromSession(
  session: FileSession
): WorkspaceEditorRecoverySnapshot {
  return {
    version: 1,
    activeTabId: session.activeTabId,
    selectedPath: session.selectedPath,
    expandedPaths: session.expandedPaths,
    treeSort: session.treeSort,
    showLineNumbers: session.showLineNumbers,
    wordWrap: session.wordWrap,
    autoSave: session.autoSave,
    formatOnSave: session.formatOnSave,
    showIgnoredFiles: session.showIgnoredFiles,
    savedAt: new Date().toISOString(),
    tabs: session.tabs.map(
      ({ conflict: _conflict, savedContent: _savedContent, revision: _revision, ...tab }) => tab
    )
  }
}

function sameFileVersion(
  left: FileTab['version'],
  right: WorkspaceFileReadResult['version']
): boolean {
  return left != null && left.sha256 === right.sha256 && left.size === right.size
}

/** Cheap probe comparison: stat fields only — no hash, no content transfer needed. */
function versionMatchesStat(
  left: FileTab['version'],
  size: number,
  mtimeMs: number
): boolean {
  return left != null && left.size === size && left.mtimeMs === mtimeMs
}

function sameFileContent(tab: FileTab, data: WorkspaceFileReadResult): boolean {
  return (
    tab.kind === data.kind &&
    tab.content === data.content &&
    tab.encoding === data.encoding &&
    tab.eol === data.eol &&
    tab.bom === data.bom
  )
}

function textBytes(
  content: string,
  encoding: WorkspaceFileEncoding,
  eol: WorkspaceFileEol,
  bom: boolean
): number {
  const body =
    eol === 'crlf'
      ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n')
      : eol === 'cr'
        ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r')
        : eol === 'lf'
          ? content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
          : content
  if (encoding === 'utf16le' || encoding === 'utf16be') {
    return body.length * 2 + (bom ? 2 : 0)
  }
  return new TextEncoder().encode(`${bom ? '\ufeff' : ''}${body}`).byteLength
}

function binaryBytes(content: string): number {
  if (!content) return 0
  const padding = content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0
  return Math.floor((content.length * 3) / 4) - padding
}

function textPosition(content: string, cursor: number): { line: number; column: number } {
  const bounded = Math.max(0, Math.min(cursor, content.length))
  const before = content.slice(0, bounded)
  const lineBreak = before.lastIndexOf('\n')
  return {
    line: before.split('\n').length,
    column: bounded - lineBreak
  }
}

function contentLimit(kind: FileTab['kind'], content: string, tab: FileTab): number {
  return kind === 'binary'
    ? binaryBytes(content)
    : textBytes(content, tab.encoding, tab.eol, tab.bom)
}

function cursorAtLine(content: string, line: number, column = 1): number {
  const lines = content.split('\n')
  const lineIndex = Math.max(1, Math.min(line, lines.length || 1)) - 1
  let offset = 0
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i]!.length + 1
  }
  return Math.min(offset + Math.max(0, column - 1), content.length)
}

function parentChain(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  if (parts.length <= 1) return []
  const parents: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    parents.push(parts.slice(0, i + 1).join('/'))
  }
  return parents
}

function isUnderPath(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`)
}

export const FilesPanel = memo(function FilesPanel({
  workspacePath,
  active,
  tabAutocompleteEnabled = true,
  gitRevision = 0,
  onGitMutated,
  onFlushReady,
  openPath,
  onOpenPathHandled,
  recoveryData,
  onRecoveryDataConsumed,
  findInFilesNonce = 0
}: {
  workspacePath: string | null
  active: boolean
  tabAutocompleteEnabled?: boolean
  gitRevision?: number
  onGitMutated?: () => void
  onFlushReady?: (flush: (() => Promise<boolean>) | null) => void
  openPath?: WorkspaceFileOpenRequest | null
  onOpenPathHandled?: (request: WorkspaceFileOpenRequest) => void
  findInFilesNonce?: number
  recoveryData?: WorkspaceEditorRecoveryLoadResult
  onRecoveryDataConsumed?: (workspacePath: string) => void
}) {
  const sessionRef = useRef<FileSession | null>(null)
  const wasActiveRef = useRef(false)
  const workspacePathRef = useRef(workspacePath)
  const workspaceEpochRef = useRef(0)
  const directoryRequestRef = useRef(new Map<string, number>())
  const fileRequestRef = useRef(0)
  const saveQueuesRef = useRef(new Map<string, Promise<boolean>>())
  const autosaveTimersRef = useRef(new Map<string, number>())
  const gitMutationTimerRef = useRef<number | null>(null)
  const typeaheadRef = useRef('')
  const typeaheadTimerRef = useRef<number | null>(null)
  const recoveryTimerRef = useRef<number | null>(null)
  const recoveryLoadPromiseRef = useRef<Promise<void> | null>(null)
  const recoveryGenerationRef = useRef(0)
  const recoverySessionTokenRef = useRef<string | null>(null)
  const flushesByWorkspaceRef = useRef(new Map<string, () => Promise<boolean>>())
  const panelRootRef = useRef<HTMLDivElement | null>(null)
  const treeScrollRef = useRef<HTMLDivElement | null>(null)
  const selectedPathRef = useRef<string | null>(null)
  const pendingTreeScrollPathRef = useRef<string | null>(null)
  const revealPathInTreeRef = useRef<(path: string) => Promise<void>>(async () => undefined)
  const filterRevealTokenRef = useRef(0)
  const treeFocusPathRef = useRef<string | null>(null)
  const contextReturnFocusRef = useRef<HTMLElement | null>(null)
  const editorActionsButtonRef = useRef<HTMLButtonElement | null>(null)
  const editorMenuReturnFocusRef = useRef<HTMLElement | null>(null)
  const selectTreePathRef = useRef<(path: string) => Promise<void>>(
    async () => undefined
  )
  const openPathRef = useRef<string | null>(null)
  const skipEditorModeResetRef = useRef(false)
  const [scrollToLine, setScrollToLine] = useState<number | null>(null)
  const recoveryDataRef = useRef(recoveryData)
  workspacePathRef.current = workspacePath
  recoveryDataRef.current = recoveryData
  const [treeFilter, setTreeFilter] = useState('')
  const [treeFocusPath, setTreeFocusPath] = useState<string | null>(null)
  const [explorerWidthPx, setExplorerWidthPx] = usePersistedNumber(
    FILES_EXPLORER_WIDTH_KEY,
    FILES_EXPLORER_WIDTH_DEFAULT,
    (value) =>
      Math.min(FILES_EXPLORER_WIDTH_MAX, Math.max(FILES_EXPLORER_WIDTH_MIN, value))
  )
  const [directories, setDirectories] = useState<Record<string, DirectoryState>>({})
  const [loadingPath, setLoadingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [saveStates, setSaveStates] = useState<Record<string, FileSaveState>>({})
  const [error, setError] = useState<string | null>(null)
  const [failedOpenPath, setFailedOpenPath] = useState<string | null>(null)
  const [recoveryError, setRecoveryError] = useState<string | null>(null)
  const [recoveryLoaded, setRecoveryLoaded] = useState(false)
  const [contextMenu, setContextMenu] = useState<FilesContextState | null>(null)
  const [workspaceActionsOpen, setWorkspaceActionsOpen] = useState(false)
  const [treeSortOpen, setTreeSortOpen] = useState(false)
  const [editorActionsAnchor, setEditorActionsAnchor] = useState<ContextMenuAnchor | null>(null)
  const [surfaceWidth, setSurfaceWidth] = useState(0)
  const [editorMode, setEditorMode] = useState<EditorSurfaceMode>('editor')
  const [diffContent, setDiffContent] = useState<string | null>(null)
  const [blameResult, setBlameResult] = useState<GitBlameResult | null>(null)
  const [lspStatus, setLspStatus] = useState<WorkspaceLspStatus | null>(null)
  const [lspResponse, setLspResponse] = useState<WorkspaceLspResponse | null>(null)
  const [formatterStatus, setFormatterStatus] = useState<WorkspaceFormatterStatus | null>(null)
  const [integrationBusy, setIntegrationBusy] = useState(false)
  const saveStatesRef = useRef<Record<string, FileSaveState>>({})
  const session = useFileSession(workspacePath)
  const {
    tabs,
    activeTabId,
    selectedPath,
    expandedPaths,
    treeSort,
    showLineNumbers,
    wordWrap,
    autoSave,
    formatOnSave,
    showIgnoredFiles
  } = session
  selectedPathRef.current = selectedPath
  treeFocusPathRef.current = treeFocusPath
  const directoriesRef = useRef<Record<string, DirectoryState>>({})
  directoriesRef.current = directories
  const prevGitRevisionRef = useRef(gitRevision)
  const { prompt: requestPrompt, dialog: promptDialog } = usePrompt()
  const { confirm: requestConfirm, dialog: confirmDialog } = useConfirm()
  sessionRef.current = workspacePath ? session : null

  useEffect(() => {
    const element = panelRootRef.current
    if (!element) return undefined
    const measure = (): void => {
      setSurfaceWidth(Math.max(0, Math.round(element.getBoundingClientRect().width)))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [workspacePath])

  useEffect(() => {
    if (skipEditorModeResetRef.current) {
      skipEditorModeResetRef.current = false
      return
    }
    setEditorMode('editor')
    setDiffContent(null)
    setBlameResult(null)
    setLspStatus(null)
    setLspResponse(null)
    setFormatterStatus(null)
  }, [activeTabId, workspacePath])

  const setTabSaveState = useCallback((id: string, state: FileSaveState): void => {
    saveStatesRef.current = { ...saveStatesRef.current, [id]: state }
    setSaveStates((previous) =>
      previous[id] === state ? previous : { ...previous, [id]: state }
    )
  }, [])

  const clearAutosaveTimers = useCallback((ids?: string[]): void => {
    const targets = ids ?? [...autosaveTimersRef.current.keys()]
    for (const id of targets) {
      const timer = autosaveTimersRef.current.get(id)
      if (timer != null) {
        window.clearTimeout(timer)
        autosaveTimersRef.current.delete(id)
      }
    }
  }, [])

  const notifyGitMutatedCoalesced = useCallback((): void => {
    if (gitMutationTimerRef.current != null) return
    gitMutationTimerRef.current = window.setTimeout(() => {
      gitMutationTimerRef.current = null
      onGitMutated?.()
    }, 250)
  }, [onGitMutated])

  const openContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>, target: FilesContextTarget): void => {
      event.preventDefault()
      event.stopPropagation()
      contextReturnFocusRef.current = event.currentTarget
      setEditorActionsAnchor(null)
      setContextMenu({
        anchor: { x: event.clientX, y: event.clientY },
        target
      })
    },
    []
  )

  const openContextMenuFromKeyboard = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>, target: FilesContextTarget): void => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return
      event.preventDefault()
      const rect = event.currentTarget.getBoundingClientRect()
      contextReturnFocusRef.current = event.currentTarget
      setEditorActionsAnchor(null)
      setContextMenu({
        anchor: { x: rect.left, y: rect.bottom },
        target
      })
    },
    []
  )

  const captureWorkspaceOperation = useCallback((): WorkspaceOperation | null => {
    if (!workspacePath) return null
    return { path: workspacePath, epoch: workspaceEpochRef.current }
  }, [workspacePath])

  const isCurrentWorkspaceOperation = useCallback((operation: WorkspaceOperation): boolean => {
    return (
      workspacePathRef.current === operation.path &&
      workspaceEpochRef.current === operation.epoch
    )
  }, [])

  useEffect(
    () => () => {
      if (typeaheadTimerRef.current) window.clearTimeout(typeaheadTimerRef.current)
      if (gitMutationTimerRef.current != null) {
        window.clearTimeout(gitMutationTimerRef.current)
        gitMutationTimerRef.current = null
      }
    },
    []
  )

  const updateSession = useCallback(
    (patch: FileSessionPatch): boolean => {
      if (!workspacePath) return false
      const current = sessionRef.current ?? getFileSession(workspacePath)
      const next = {
        ...current,
        ...patch,
        revision: current.revision + 1
      }
      if (next.tabs.length > MAX_FILE_SESSION_TABS) {
        setError(`Only ${MAX_FILE_SESSION_TABS} file tabs can be open at once.`)
        return false
      }
      const contentChars = next.tabs.reduce(
        (total, tab) => total + tab.content.length + (tab.savedContent?.length ?? 0),
        0
      )
      if (contentChars > MAX_FILE_SESSION_CONTENT_CHARS) {
        setError('Open file buffers exceed the in-memory session limit.')
        return false
      }
      sessionRef.current = next
      setFileSession(workspacePath, next)
      return true
    },
    [workspacePath]
  )

  const mutateTab = useCallback(
    (id: string, update: (tab: FileTab) => FileTab): boolean => {
      const current = sessionRef.current
      if (!current) return false
      return updateSession({
        tabs: current.tabs.map((tab) => (tab.id === id ? update(tab) : tab))
      })
    },
    [updateSession]
  )

  const loadDirectory = useCallback(
    async (path: string, append = false): Promise<void> => {
      const operation = captureWorkspaceOperation()
      if (!operation || !window.vyotiq?.workspaceFileList) return
      const current = directoriesRef.current[path] ?? emptyDirectoryState()
      const offset = append ? (current.nextOffset ?? 0) : 0
      if (append && current.nextOffset == null) return
      const requestKey = `${operation.path}\0${path}`
      const requestId = (directoryRequestRef.current.get(requestKey) ?? 0) + 1
      directoryRequestRef.current.set(requestKey, requestId)
      setDirectories((previous) => {
        const next = {
          ...previous,
          [path]: {
            ...(previous[path] ?? emptyDirectoryState()),
            loading: true,
            error: null
          }
        }
        directoriesRef.current = next
        return next
      })
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileList>>
      try {
        result = await window.vyotiq.workspaceFileList({
          workspacePath: operation.path,
          path,
          offset,
          limit: PAGE_SIZE
        })
      } catch (err) {
        if (
          !isCurrentWorkspaceOperation(operation) ||
          directoryRequestRef.current.get(requestKey) !== requestId
        ) {
          return
        }
        const message = err instanceof Error ? err.message : String(err)
        setDirectories((previous) => {
          const next = {
            ...previous,
            [path]: {
              ...(previous[path] ?? emptyDirectoryState()),
              loading: false,
              error: message
            }
          }
          directoriesRef.current = next
          return next
        })
        return
      }
      if (
        !isCurrentWorkspaceOperation(operation) ||
        directoryRequestRef.current.get(requestKey) !== requestId
      ) {
        return
      }
      if (result == null) {
        setDirectories((previous) => {
          const next = {
            ...previous,
            [path]: {
              ...(previous[path] ?? emptyDirectoryState()),
              loading: false,
              error: 'Directory listing failed'
            }
          }
          directoriesRef.current = next
          return next
        })
        return
      }
      if (!result.ok) {
        setDirectories((previous) => {
          const next = {
            ...previous,
            [path]: {
              ...(previous[path] ?? emptyDirectoryState()),
              loading: false,
              error: result.error
            }
          }
          directoriesRef.current = next
          return next
        })
        return
      }
      const data: WorkspaceFileListResult = result.data
      setDirectories((previous) => {
        const before = append ? previous[path]?.entries ?? [] : []
        const next = {
          ...previous,
          [path]: {
            entries: [...before, ...data.entries],
            total: data.total,
            nextOffset: data.nextOffset,
            truncated: data.truncated,
            loading: false,
            error: null
          }
        }
        directoriesRef.current = next
        return next
      })
    },
    [captureWorkspaceOperation, isCurrentWorkspaceOperation]
  )

  const invalidateDirectoryRequests = useCallback((operation: WorkspaceOperation): void => {
    const prefix = `${operation.path}\0`
    for (const [key, requestId] of directoryRequestRef.current.entries()) {
      if (key.startsWith(prefix)) {
        directoryRequestRef.current.set(key, requestId + 1)
      }
    }
  }, [])

  useEffect(() => {
    const epoch = ++workspaceEpochRef.current
    if (!workspacePath) {
      sessionRef.current = null
      fileRequestRef.current += 1
      recoveryGenerationRef.current = 0
      recoverySessionTokenRef.current = null
      clearAutosaveTimers()
      setTreeFilter('')
      setTreeFocusPath(null)
      setDirectories({})
      setContextMenu(null)
      setSaveStates({})
      saveStatesRef.current = {}
      setRecoveryLoaded(false)
      setLoadingPath(null)
      setBusy(false)
      setFailedOpenPath(null)
      return
    }
    sessionRef.current = getFileSession(workspacePath)
    fileRequestRef.current += 1
    recoveryGenerationRef.current = 0
    recoverySessionTokenRef.current = null
    clearAutosaveTimers()
    setSaveStates({})
    saveStatesRef.current = {}
    setTreeFilter('')
    setTreeFocusPath(null)
    setContextMenu(null)
    directoriesRef.current = {}
    setDirectories({})
    setError(null)
    setRecoveryError(null)
    setRecoveryLoaded(false)
    setLoadingPath(null)
    setBusy(false)
    setFailedOpenPath(null)
    let cancelled = false
    const providedRecoveryData = recoveryDataRef.current
    void loadDirectory('')
    const loadRecovery = async (): Promise<void> => {
      if (!providedRecoveryData && !window.vyotiq?.workspaceEditorRecoveryLoad) {
        if (!cancelled && isCurrentWorkspaceOperation({ path: workspacePath, epoch })) {
          setRecoveryLoaded(true)
        }
        return
      }
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceEditorRecoveryLoad>>
      if (providedRecoveryData) {
        result = { ok: true, data: providedRecoveryData }
      } else {
        try {
          result = await window.vyotiq.workspaceEditorRecoveryLoad({ workspacePath })
        } catch (err) {
          if (!cancelled && isCurrentWorkspaceOperation({ path: workspacePath, epoch })) {
            setRecoveryError(err instanceof Error ? err.message : String(err))
            setRecoveryLoaded(false)
          }
          return
        }
      }
      if (cancelled || !isCurrentWorkspaceOperation({ path: workspacePath, epoch })) return
      if (!result.ok) {
        setRecoveryError(result.error)
        setRecoveryLoaded(false)
        return
      }
      if (providedRecoveryData) onRecoveryDataConsumed?.(workspacePath)
      recoverySessionTokenRef.current = result.data.sessionToken
      recoveryGenerationRef.current = result.data.generation
      const hydrationSession = getFileSession(workspacePath)
      const hydrationRevision = hydrationSession.revision
      if (hydrationSession.tabs.length === 0 && result.data.snapshot) {
        let recoveredTabs = result.data.snapshot.tabs.map(fileTabFromRecovery)
        if (window.vyotiq.workspaceFileRead) {
          recoveredTabs = await Promise.all(
            recoveredTabs.map(async (tab) => {
              let current: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
              try {
                current = await window.vyotiq.workspaceFileRead({
                  workspacePath,
                  path: tab.path
                })
              } catch {
                return { ...tab, savedContent: null, dirty: true, conflict: true }
              }
              if (!current.ok) {
                return { ...tab, savedContent: null, dirty: true, conflict: true }
              }
              if (sameFileContent(tab, current.data)) {
                return {
                  ...tab,
                  kind: current.data.kind,
                  content: current.data.content,
                  encoding: current.data.encoding,
                  eol: current.data.eol,
                  bom: current.data.bom,
                  version: current.data.version,
                  savedContent: current.data.content,
                  dirty: false,
                  conflict: false
                }
              }
              if (sameFileVersion(tab.version, current.data.version)) {
                return {
                  ...tab,
                  version: current.data.version,
                  savedContent: current.data.content,
                  dirty: true,
                  conflict: false
                }
              }
              if (tab.dirty) {
                return { ...tab, savedContent: current.data.content, conflict: true }
              }
              return {
                ...tab,
                kind: current.data.kind,
                content: current.data.content,
                encoding: current.data.encoding,
                eol: current.data.eol,
                bom: current.data.bom,
                version: current.data.version,
                savedContent: current.data.content,
                dirty: false,
                conflict: false
              }
            })
          )
        }
        if (cancelled || !isCurrentWorkspaceOperation({ path: workspacePath, epoch })) return
        const currentSession = getFileSession(workspacePath)
        if (
          currentSession.revision !== hydrationRevision ||
          currentSession.tabs.length !== 0
        ) {
          setRecoveryLoaded(true)
          return
        }
        const snapshotActiveId = result.data.snapshot.activeTabId
        const recoveredActiveId =
          snapshotActiveId && recoveredTabs.some((tab) => tab.id === snapshotActiveId)
            ? snapshotActiveId
            : recoveredTabs[0]?.id ?? null
        updateSession({
          tabs: recoveredTabs,
          activeTabId: recoveredActiveId,
          selectedPath:
            result.data.snapshot.selectedPath ??
            recoveredTabs.find((tab) => tab.id === recoveredActiveId)?.path ??
            null,
          expandedPaths: [...new Set(['', ...(result.data.snapshot.expandedPaths ?? [])])],
          treeSort: result.data.snapshot.treeSort ?? 'name',
          showLineNumbers: result.data.snapshot.showLineNumbers ?? true,
          wordWrap: result.data.snapshot.wordWrap ?? false,
          autoSave: result.data.snapshot.autoSave ?? true,
          formatOnSave: result.data.snapshot.formatOnSave ?? false,
          showIgnoredFiles: result.data.snapshot.showIgnoredFiles ?? false
        })
        const recoveredActivePath = recoveredTabs.find((tab) => tab.id === recoveredActiveId)?.path
        if (recoveredActivePath) {
          setTreeFocusPath(recoveredActivePath)
          void revealPathInTreeRef.current(recoveredActivePath)
        }
        for (const tab of recoveredTabs) {
          setTabSaveState(
            tab.id,
            tab.conflict ? 'conflict' : tab.dirty ? 'pending' : 'saved'
          )
        }
      }
      setRecoveryLoaded(true)
    }
    const recoveryLoad = loadRecovery()
    recoveryLoadPromiseRef.current = recoveryLoad
    void recoveryLoad.then(
      () => {
        if (recoveryLoadPromiseRef.current === recoveryLoad) {
          recoveryLoadPromiseRef.current = null
        }
      },
      () => {
        if (recoveryLoadPromiseRef.current === recoveryLoad) {
          recoveryLoadPromiseRef.current = null
        }
      }
    )
    const directoryRequests = directoryRequestRef.current
    return () => {
      cancelled = true
      if (providedRecoveryData) onRecoveryDataConsumed?.(workspacePath)
      if (recoveryTimerRef.current) {
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      const current = getFileSession(workspacePath)
      const sessionToken = recoverySessionTokenRef.current
      const recoveryApi = window.vyotiq
      if (current && sessionToken && recoveryApi) {
        const generation = ++recoveryGenerationRef.current
        const request =
          current.tabs.length === 0
            ? recoveryApi.workspaceEditorRecoveryClear?.({
                workspacePath,
                sessionToken,
                generation
              })
            : recoveryApi.workspaceEditorRecoverySave?.({
                workspacePath,
                sessionToken,
                generation,
                snapshot: recoveryFromSession(current)
              })
        if (request) void request.catch(() => undefined)
      }
      directoryRequests.clear()
      clearAutosaveTimers()
      fileRequestRef.current += 1
      if (workspaceEpochRef.current === epoch) workspaceEpochRef.current += 1
    }
  }, [
    clearAutosaveTimers,
    isCurrentWorkspaceOperation,
    loadDirectory,
    onRecoveryDataConsumed,
    setTabSaveState,
    updateSession,
    workspacePath
  ])

  useEffect(() => {
    if (!workspacePath || !recoveryLoaded) return
    for (const path of expandedPaths) {
      if (path && !directoriesRef.current[path]) void loadDirectory(path)
    }
  }, [expandedPaths, loadDirectory, recoveryLoaded, workspacePath])

  const flushRecoverySnapshot = useCallback(
    async (requestedOperation?: WorkspaceOperation): Promise<boolean> => {
      const api = window.vyotiq
      if (!workspacePath || !api) return true
      const pendingLoad = recoveryLoadPromiseRef.current
      if (pendingLoad) await pendingLoad
      if (!api.workspaceEditorRecoverySave && !api.workspaceEditorRecoveryClear) return true
      const sessionToken = recoverySessionTokenRef.current
      if (!sessionToken) return false
      const operation = requestedOperation ?? captureWorkspaceOperation()
      if (!operation || !isCurrentWorkspaceOperation(operation)) return false
      if (recoveryTimerRef.current != null) {
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
      const current = getFileSession(operation.path)
      const generation = ++recoveryGenerationRef.current
      const request =
        current.tabs.length === 0
          ? api.workspaceEditorRecoveryClear?.({
              workspacePath: operation.path,
              sessionToken,
              generation
            })
          : api.workspaceEditorRecoverySave?.({
              workspacePath: operation.path,
              sessionToken,
              generation,
              snapshot: recoveryFromSession(current)
            })
      if (!request) return current.tabs.length === 0
      try {
        const result = await request
        if (!result.ok && isCurrentWorkspaceOperation(operation)) {
          setRecoveryError(result.error)
        }
        return result.ok
      } catch (err) {
        if (isCurrentWorkspaceOperation(operation)) {
          setRecoveryError(err instanceof Error ? err.message : String(err))
        }
        return false
      }
    },
    [captureWorkspaceOperation, isCurrentWorkspaceOperation, workspacePath]
  )

  const recoveryRevision = session.revision

  useEffect(() => {
    if (
      !workspacePath ||
      !recoveryLoaded ||
      !window.vyotiq
    ) {
      return undefined
    }
    const operation = captureWorkspaceOperation()
    if (!operation) return undefined
    if (recoveryTimerRef.current != null) {
      window.clearTimeout(recoveryTimerRef.current)
    }
    recoveryTimerRef.current = window.setTimeout(() => {
      void flushRecoverySnapshot(operation)
    }, 700)
    return () => {
      if (recoveryTimerRef.current != null) {
        window.clearTimeout(recoveryTimerRef.current)
        recoveryTimerRef.current = null
      }
    }
  }, [
    captureWorkspaceOperation,
    flushRecoverySnapshot,
    isCurrentWorkspaceOperation,
    recoveryRevision,
    recoveryLoaded,
    workspacePath
  ])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  useEffect(() => {
    setFocusedFile(activeTab?.path ?? null)
    return () => setFocusedFile(null)
  }, [activeTab?.path])

  const [findInFilesOpen, setFindInFilesOpen] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const [findQuery, setFindQuery] = useState('')
  const [findHits, setFindHits] = useState<Array<{ path: string; line: number; text: string }>>([])
  const [findError, setFindError] = useState<string | null>(null)
  const [findBusy, setFindBusy] = useState(false)
  const [previewOpen, setPreviewOpen] = useState(false)
  const previewKind = activeTab ? filePreviewKind(activeTab.path) : null

  useEffect(() => {
    setPreviewOpen(defaultPreviewOpen(previewKind))
  }, [activeTab?.id, previewKind])

  useEffect(() => {
    if (findInFilesNonce > 0) setFindInFilesOpen(true)
  }, [findInFilesNonce])

  useEffect(() => {
    if (findInFilesOpen) findInputRef.current?.focus()
  }, [findInFilesOpen])
  const activeDirty = activeTab?.dirty ?? false
  const activeSaveState = activeTab
    ? saveStates[activeTab.id] ?? (activeTab.dirty ? 'pending' : 'saved')
    : undefined
  const activeTextPosition =
    activeTab?.kind === 'text' ? textPosition(activeTab.content, activeTab.cursor) : null
  const inlineLspEnabled =
    editorMode === 'editor' && activeTab?.kind === 'text' && Boolean(workspacePath)
  const inlineLsp = useWorkspaceLsp({
    workspacePath,
    path: activeTab?.kind === 'text' ? activeTab.path : null,
    content: activeTab?.kind === 'text' ? activeTab.content : '',
    enabled: inlineLspEnabled
  })
  const dirtyTabCount = tabs.filter((tab) => tab.dirty).length
  const savingTabCount = tabs.filter(
    (tab) => saveStates[tab.id] === 'saving' || saveStates[tab.id] === 'pending'
  ).length
  const diffLines = useMemo(
    () => (diffContent ? parseUnifiedDiff(diffContent, 200) : []),
    [diffContent]
  )

  const saveTabOnce = useCallback(
    async (id: string, mode: SaveMode = 'manual'): Promise<boolean> => {
      const operation = captureWorkspaceOperation()
      if (!operation || !window.vyotiq?.workspaceFileSave) return false
      const current = getFileSession(operation.path).tabs.find((tab) => tab.id === id)
      if (!current) return false
      if (current.conflict && mode !== 'overwrite') {
        setTabSaveState(id, 'conflict')
        return false
      }
      if (mode === 'auto' && !current.dirty) {
        setTabSaveState(id, 'saved')
        return true
      }
      const revision = current.revision
      const isBackground = mode === 'auto'
      setTabSaveState(id, 'saving')
      if (!isBackground) setBusy(true)
      setError(null)
      let expectedVersion = current.version
      if (mode === 'overwrite') {
        if (!window.vyotiq.workspaceFileRead) {
          if (!isBackground) setBusy(false)
          setTabSaveState(id, 'error')
          return false
        }
        let latest: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
        try {
          latest = await window.vyotiq.workspaceFileRead({
            workspacePath: operation.path,
            path: current.path
          })
        } catch (err) {
          if (isCurrentWorkspaceOperation(operation)) {
            if (!isBackground) setBusy(false)
            setTabSaveState(id, 'error')
            setError(err instanceof Error ? err.message : String(err))
          }
          return false
        }
        if (!isCurrentWorkspaceOperation(operation)) return false
        const afterRead = getFileSession(operation.path).tabs.find((tab) => tab.id === id)
        if (!afterRead || afterRead.revision !== revision) return false
        if (!latest.ok) {
          if (!isBackground) setBusy(false)
          setTabSaveState(id, 'error')
          setError(latest.error)
          return false
        }
        expectedVersion = latest.data.version
      }
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileSave>>
      let contentToSave = current.content
      if (formatOnSave && current.kind === 'text') {
        const formatter = window.vyotiq.workspaceFormatFile
        if (!formatter) {
          if (!isBackground) setBusy(false)
          setTabSaveState(id, 'error')
          setError('Format on Save is unavailable because no formatter is configured.')
          return false
        }
        let formatted: Awaited<ReturnType<typeof formatter>>
        try {
          formatted = await formatter({
            workspacePath: operation.path,
            path: current.path,
            content: current.content
          })
        } catch (err) {
          if (isCurrentWorkspaceOperation(operation)) {
            if (!isBackground) setBusy(false)
            setTabSaveState(id, 'error')
            setError(err instanceof Error ? err.message : String(err))
          }
          return false
        }
        if (!isCurrentWorkspaceOperation(operation)) return false
        const afterFormat = getFileSession(operation.path).tabs.find((tab) => tab.id === id)
        if (!afterFormat || afterFormat.revision !== revision) return false
        if (!formatted.ok) {
          if (!isBackground) setBusy(false)
          setTabSaveState(id, 'error')
          setError(formatted.error)
          return false
        }
        if (formatted.data.kind === 'unavailable') {
          setError(`Format on Save skipped: ${formatted.data.detail}`)
        } else {
          contentToSave = formatted.data.content
        }
      }
      try {
        result = await window.vyotiq.workspaceFileSave({
          workspacePath: operation.path,
          path: current.path,
          kind: current.kind,
          content: contentToSave,
          encoding: current.encoding,
          eol: current.eol,
          bom: current.bom,
          expectedVersion,
          replaceExisting: false
        })
      } catch (err) {
        if (!isCurrentWorkspaceOperation(operation)) return false
        if (!isBackground) setBusy(false)
        setTabSaveState(id, 'error')
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
      if (!isCurrentWorkspaceOperation(operation)) return false
      if (!isBackground) setBusy(false)
      if (!result.ok) {
        if (result.code === 'FILE_CONFLICT') {
          mutateTab(id, (tab) =>
            tab.revision === revision ? { ...tab, conflict: true } : tab
          )
          setTabSaveState(id, 'conflict')
        } else {
          setTabSaveState(id, 'error')
        }
        setError(result.error)
        return false
      }
      mutateTab(id, (tab) =>
        tab.revision === revision
          ? {
              ...tab,
              version: result.data.version,
              content: contentToSave,
              savedContent: contentToSave,
              dirty: false,
              conflict: false
            }
          : {
              ...tab,
              version: result.data.version
            }
      )
      const latest = sessionRef.current?.tabs.find((tab) => tab.id === id)
      setTabSaveState(
        id,
        latest?.conflict ? 'conflict' : latest?.dirty ? 'pending' : 'saved'
      )
      notifyGitMutatedCoalesced()
      return true
    },
    [
      captureWorkspaceOperation,
      isCurrentWorkspaceOperation,
      formatOnSave,
      mutateTab,
      notifyGitMutatedCoalesced,
      setTabSaveState
    ]
  )

  const saveTab = useCallback(
    (id: string, mode: SaveMode = 'manual'): Promise<boolean> => {
      const queueKey = `${workspacePath ?? ''}\0${id}`
      const previous = saveQueuesRef.current.get(queueKey) ?? Promise.resolve(true)
      const run = previous.catch(() => false).then(() => saveTabOnce(id, mode))
      saveQueuesRef.current.set(queueKey, run)
      void run.then(
        () => {
          if (saveQueuesRef.current.get(queueKey) === run) {
            saveQueuesRef.current.delete(queueKey)
          }
        },
        () => {
          if (saveQueuesRef.current.get(queueKey) === run) {
            saveQueuesRef.current.delete(queueKey)
          }
        }
      )
      return run
    },
    [saveTabOnce, workspacePath]
  )

  const flushDirtyTabs = useCallback(async (): Promise<boolean> => {
    const current = sessionRef.current
    if (!current) return flushRecoverySnapshot()
    clearAutosaveTimers()
    if (current.tabs.some((tab) => tab.dirty && tab.conflict)) {
      setError('Resolve external file changes before saving or committing.')
      await flushRecoverySnapshot()
      return false
    }
    const dirtyTabs = current.tabs.filter((tab) => tab.dirty && !tab.conflict)
    const results =
      dirtyTabs.length > 0
        ? await Promise.all(dirtyTabs.map((tab) => saveTab(tab.id, 'auto')))
        : []
    const recoverySaved = await flushRecoverySnapshot()
    return results.every(Boolean) && recoverySaved
  }, [clearAutosaveTimers, flushRecoverySnapshot, saveTab])

  if (workspacePath) {
    flushesByWorkspaceRef.current.set(workspacePath, flushDirtyTabs)
  }

  useEffect(() => {
    const capturedWorkspacePath = workspacePath
    const flushesByWorkspace = flushesByWorkspaceRef.current
    const registeredFlush = (): Promise<boolean> => {
      if (!capturedWorkspacePath) return Promise.resolve(true)
      return flushesByWorkspace.get(capturedWorkspacePath)?.() ?? Promise.resolve(true)
    }
    onFlushReady?.(registeredFlush)
    return () => {
      const flush = capturedWorkspacePath
        ? flushesByWorkspace.get(capturedWorkspacePath)
        : undefined
      if (!flush) {
        if (workspacePathRef.current === capturedWorkspacePath) onFlushReady?.(null)
        return
      }
      onFlushReady?.(flush)
      void flush().finally(() => {
        if (workspacePathRef.current === capturedWorkspacePath) onFlushReady?.(null)
      })
    }
  }, [onFlushReady, workspacePath])

  const autosaveKey = useMemo(
    () =>
      tabs
        .map((tab) => `${tab.id}:${tab.revision}:${tab.dirty ? '1' : '0'}:${tab.conflict ? '1' : '0'}`)
        .join('\0'),
    [tabs]
  )

  useEffect(() => {
    if (!workspacePath || !recoveryLoaded || !autoSave) {
      clearAutosaveTimers()
      return undefined
    }
    clearAutosaveTimers()
    for (const tab of sessionRef.current?.tabs ?? []) {
      if (!tab.dirty || tab.conflict) continue
      if (
        saveStatesRef.current[tab.id] === 'error' ||
        saveStatesRef.current[tab.id] === 'saving'
      ) {
        continue
      }
      const timer = window.setTimeout(() => {
        autosaveTimersRef.current.delete(tab.id)
        void saveTab(tab.id, 'auto')
      }, 1000)
      autosaveTimersRef.current.set(tab.id, timer)
      if (saveStatesRef.current[tab.id] !== 'saving') {
        setTabSaveState(tab.id, 'pending')
      }
    }
    return clearAutosaveTimers
  }, [
    autosaveKey,
    clearAutosaveTimers,
    recoveryLoaded,
    saveTab,
    saveStates,
    setTabSaveState,
    autoSave,
    workspacePath
  ])

  const checkExternalChangeForActiveTab = useCallback(async (): Promise<void> => {
    const operation = captureWorkspaceOperation()
    const watchedTabId = sessionRef.current?.activeTabId
    if (!operation || !watchedTabId || !window.vyotiq?.workspaceFileRead) return
    const current = getFileSession(operation.path).tabs.find((tab) => tab.id === watchedTabId)
    if (!current || saveStatesRef.current[current.id] === 'saving') return
    // Cheap stat probe first — only pay for a full content transfer when it changed.
    const statApi = window.vyotiq.workspaceFileStat
    if (statApi) {
      let stat: Awaited<ReturnType<typeof statApi>> | null = null
      try {
        stat = await statApi({ workspacePath: operation.path, path: current.path })
      } catch {
        return
      }
      if (!isCurrentWorkspaceOperation(operation)) return
      const probed = getFileSession(operation.path).tabs.find((tab) => tab.id === current.id)
      if (!probed || probed.revision !== current.revision) return
      if (stat.ok && stat.data.exists && versionMatchesStat(probed.version, stat.data.size, stat.data.mtimeMs)) {
        return
      }
    }
    let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
    try {
      result = await window.vyotiq.workspaceFileRead({
        workspacePath: operation.path,
        path: current.path
      })
    } catch {
      return
    }
    if (!isCurrentWorkspaceOperation(operation)) return
    const latest = getFileSession(operation.path).tabs.find((tab) => tab.id === current.id)
    if (!latest || latest.revision !== current.revision) return
    if (!result.ok) {
      if (latest.dirty && !latest.conflict) {
        mutateTab(latest.id, (tab) => ({
          ...tab,
          savedContent: null,
          conflict: true,
          revision: tab.revision + 1
        }))
        setTabSaveState(latest.id, 'conflict')
        setError(`${fileName(latest.path)} is no longer available on disk.`)
      }
      return
    }
    if (sameFileVersion(latest.version, result.data.version)) return
    if (latest.dirty) {
      mutateTab(latest.id, (tab) => ({
        ...tab,
        savedContent: result.data.content,
        version: result.data.version,
        conflict: true,
        revision: tab.revision + 1
      }))
      setTabSaveState(latest.id, 'conflict')
      return
    }
    mutateTab(latest.id, (tab) => ({
      ...tab,
      kind: result.data.kind,
      content: result.data.content,
      encoding: result.data.encoding,
      eol: result.data.eol,
      bom: result.data.bom,
      version: result.data.version,
      savedContent: result.data.content,
      dirty: false,
      conflict: false,
      revision: tab.revision + 1
    }))
    setTabSaveState(latest.id, 'saved')
  }, [
    captureWorkspaceOperation,
    isCurrentWorkspaceOperation,
    mutateTab,
    setTabSaveState
  ])

  useEffect(() => {
    const watchedTabId = activeTab?.id
    const becameActive = active && !wasActiveRef.current
    wasActiveRef.current = active
    if (!active || !workspacePath || !watchedTabId || !window.vyotiq?.workspaceFileRead) {
      return undefined
    }
    let cancelled = false
    const checkExternalChange = async (): Promise<void> => {
      if (cancelled) return
      await checkExternalChangeForActiveTab()
    }
    if (becameActive) void checkExternalChange()

    const documentVisible = (): boolean =>
      typeof document === 'undefined' || document.visibilityState === 'visible'

    const onFocusOrVisible = (): void => {
      if (documentVisible()) void checkExternalChange()
    }
    window.addEventListener('focus', onFocusOrVisible)
    document.addEventListener('visibilitychange', onFocusOrVisible)

    const dirty = Boolean(activeTab?.dirty)
    let timer: number | undefined
    if (dirty && documentVisible()) {
      timer = window.setInterval(() => {
        if (!documentVisible()) return
        void checkExternalChange()
      }, 2_000)
    }
    return () => {
      cancelled = true
      if (timer != null) window.clearInterval(timer)
      window.removeEventListener('focus', onFocusOrVisible)
      document.removeEventListener('visibilitychange', onFocusOrVisible)
    }
  }, [active, activeTab?.id, activeTab?.dirty, checkExternalChangeForActiveTab, workspacePath])

  const reloadTab = useCallback(
    async (id: string): Promise<boolean> => {
      const operation = captureWorkspaceOperation()
      if (!operation || !window.vyotiq?.workspaceFileRead) return false
      const current = sessionRef.current?.tabs.find((tab) => tab.id === id)
      if (!current) return false
      const revision = current.revision
      setBusy(true)
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
      try {
        result = await window.vyotiq.workspaceFileRead({
          workspacePath: operation.path,
          path: current.path
        })
      } catch (err) {
        if (!isCurrentWorkspaceOperation(operation)) return false
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
        return false
      }
      if (!isCurrentWorkspaceOperation(operation)) return false
      setBusy(false)
      const latest = sessionRef.current?.tabs.find((tab) => tab.id === id)
      if (!latest || latest.revision !== revision) return false
      if (!result.ok) {
        setTabSaveState(id, 'error')
        setError(result.error)
        return false
      }
      mutateTab(id, (tab) => ({
        ...tab,
        kind: result.data.kind,
        content: result.data.content,
        encoding: result.data.encoding,
        eol: result.data.eol,
        bom: result.data.bom,
        version: result.data.version,
        savedContent: result.data.content,
        dirty: false,
        conflict: false,
        revision: revision + 1
      }))
      setTabSaveState(id, 'saved')
      return true
    },
    [captureWorkspaceOperation, isCurrentWorkspaceOperation, mutateTab, setTabSaveState]
  )

  const overwriteTab = useCallback(
    async (id: string): Promise<boolean> => {
      const current = sessionRef.current?.tabs.find((tab) => tab.id === id)
      if (!current?.conflict) return false
      if (
        !(await requestConfirm(
          `Overwrite the newer disk version of ${fileName(current.path)} with your local edits?`,
          {
            title: 'Overwrite external changes',
            confirmLabel: 'Overwrite',
            danger: true
          }
        ))
      ) {
        return false
      }
      return saveTab(id, 'overwrite')
    },
    [requestConfirm, saveTab]
  )

  const allowLeaveTab = useCallback(
    async (id: string): Promise<boolean> => {
      const current = sessionRef.current?.tabs.find((tab) => tab.id === id)
      if (!current?.dirty) return true
      const save = await requestConfirm(
        `${fileName(current.path)} has unsaved changes. Save them now?`,
        { title: 'Unsaved changes', confirmLabel: 'Save' }
      )
      if (save) return saveTab(id)
      const discard = await requestConfirm(
        `Discard unsaved changes in ${fileName(current.path)}?`,
        { title: 'Discard changes', confirmLabel: 'Discard', danger: true }
      )
      return discard ? reloadTab(id) : false
    },
    [reloadTab, requestConfirm, saveTab]
  )

  const allowLeaveTabs = useCallback(
    async (ids: string[]): Promise<boolean> => {
      for (const id of ids) {
        if (!(await allowLeaveTab(id))) return false
      }
      return true
    },
    [allowLeaveTab]
  )

  const openFile = useCallback(
    async (path: string): Promise<void> => {
      const operation = captureWorkspaceOperation()
      if (!operation || !window.vyotiq?.workspaceFileRead) return
      if (activeTab && activeTab.path !== path && !(await allowLeaveTab(activeTab.id))) return
      if (!isCurrentWorkspaceOperation(operation)) return
      await revealPathInTreeRef.current(path)
      setTreeFocusPath(path)
      setFailedOpenPath(null)
      const requestId = ++fileRequestRef.current
      const existing = sessionRef.current?.tabs.find((tab) => tab.path === path)
      if (existing) {
        updateSession({ activeTabId: existing.id, selectedPath: path })
        return
      }
      setLoadingPath(path)
      setError(null)
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
      try {
        result = await window.vyotiq.workspaceFileRead({
          workspacePath: operation.path,
          path
        })
      } catch (err) {
        if (
          !isCurrentWorkspaceOperation(operation) ||
          requestId !== fileRequestRef.current
        ) {
          return
        }
        setLoadingPath(null)
        setError(err instanceof Error ? err.message : String(err))
        setFailedOpenPath(path)
        return
      }
      if (
        !isCurrentWorkspaceOperation(operation) ||
        requestId !== fileRequestRef.current
      ) {
        return
      }
      setLoadingPath(null)
      if (!result.ok) {
        setError(
          operation.path
            ? `${result.error} — searched in "${workspaceName(operation.path)}"`
            : result.error
        )
        setFailedOpenPath(path)
        return
      }
      const tab: FileTab = {
        id: `${path}:${Date.now()}`,
        path,
        kind: result.data.kind,
        content: result.data.content,
        savedContent: result.data.content,
        encoding: result.data.encoding,
        eol: result.data.eol,
        bom: result.data.bom,
        version: result.data.version,
        dirty: false,
        conflict: false,
        cursor: 0,
        selections: [{ from: 0, to: 0 }],
        bookmarks: [],
        template: null,
        scrollTop: 0,
        revision: 0
      }
      const current = sessionRef.current
      updateSession({
        tabs: [...(current?.tabs ?? []), tab],
        activeTabId: tab.id,
        selectedPath: path
      })
    },
    [
      activeTab,
      allowLeaveTab,
      captureWorkspaceOperation,
      isCurrentWorkspaceOperation,
      updateSession
    ]
  )

  const toggleDirectory = useCallback(
    (path: string): void => {
      const isOpen = expandedPaths.includes(path)
      const next = isOpen
        ? expandedPaths.filter((value) => value !== path)
        : [...expandedPaths, path]
      updateSession({ expandedPaths: next })
      if (!isOpen && !directories[path]) void loadDirectory(path)
    },
    [directories, expandedPaths, loadDirectory, updateSession]
  )

  const visibleEntries = useMemo(() => {
    const output: VisibleEntry[] = []
    const filter = treeFilter.trim().toLowerCase()
    const sortEntries = (entries: WorkspaceFileEntry[]): WorkspaceFileEntry[] =>
      [...entries].sort((left, right) => {
        if (treeSort === 'kind' && left.kind !== right.kind) {
          return TREE_KIND_ORDER[left.kind] - TREE_KIND_ORDER[right.kind]
        }
        if (treeSort === 'name' && left.kind !== right.kind) {
          return left.kind === 'directory' ? -1 : 1
        }
        return left.name.localeCompare(right.name, undefined, {
          numeric: true,
          sensitivity: 'base'
        })
      })

    if (filter) {
      const seen = new Set<string>()
      for (const dirPath of Object.keys(directories).sort((left, right) => left.localeCompare(right))) {
        const directory = directories[dirPath]
        if (!directory?.entries.length) continue
        const level = dirPath ? dirPath.split('/').filter(Boolean).length + 1 : 1
        for (const entry of sortEntries(directory.entries)) {
          if (
            (entry.name.toLowerCase().includes(filter) ||
              entry.path.toLowerCase().includes(filter)) &&
            !seen.has(entry.path)
          ) {
            seen.add(entry.path)
            output.push({ kind: 'entry', entry, level })
          }
        }
      }
      return output
    }

    const visit = (path: string, level: number): void => {
      const directory = directories[path]
      if (!directory) return
      const entries = sortEntries(directory.entries)
      for (const entry of entries) {
        if (!showIgnoredFiles && isIgnoredWorkspaceEntryName(entry.name)) continue
        output.push({ kind: 'entry', entry, level })
        if (isDirectoryEntry(entry) && expandedPaths.includes(entry.path)) {
          visit(entry.path, level + 1)
          const childDir = directories[entry.path]
          if (
            childDir?.nextOffset != null &&
            !childDir.loading &&
            !childDir.error
          ) {
            output.push({
              kind: 'loadMore',
              parentPath: entry.path,
              level: level + 1,
              loaded: childDir.entries.length,
              total: childDir.total
            })
          }
        }
      }
    }
    visit('', 1)
    return output
  }, [directories, expandedPaths, treeFilter, treeSort, showIgnoredFiles])

  const getTreeItemKey = useCallback(
    (index: number) => {
      const item = visibleEntries[index]
      if (!item) return index
      if (item.kind === 'loadMore') return `load-more:${item.parentPath}`
      return item.entry.path
    },
    [visibleEntries]
  )

  const treeVirtualizer = useAppVirtualizer({
    count: visibleEntries.length,
    getScrollElement: () => treeScrollRef.current,
    estimateSize: () => TREE_ROW_HEIGHT_PX,
    getItemKey: getTreeItemKey,
    initialRect: { width: 320, height: 600 },
    overscan: 20
  })
  const virtualEntries = treeVirtualizer.getVirtualItems()
  const treeRows =
    virtualEntries.length > 0
      ? virtualEntries
      : visibleEntries.map((_, index) => ({
          index,
          start: index * TREE_ROW_HEIGHT_PX
        }))
  const treeHighlightPath = activeTab?.path ?? selectedPath
  const treeKeyboardPath = treeFocusPath ?? treeHighlightPath
  const selectedEntry = treeKeyboardPath
    ? findVisibleTreeEntry(visibleEntries, treeKeyboardPath)
    : undefined
  const canMutateSelected =
    selectedEntry?.kind === 'file' || selectedEntry?.kind === 'directory'

  const refreshTree = useCallback((): void => {
    for (const path of expandedPaths) void loadDirectory(path)
  }, [expandedPaths, loadDirectory])

  const refreshTreeRef = useRef(refreshTree)
  refreshTreeRef.current = refreshTree
  const checkExternalChangeForActiveTabRef = useRef(checkExternalChangeForActiveTab)
  checkExternalChangeForActiveTabRef.current = checkExternalChangeForActiveTab

  useEffect(() => {
    if (!active) return
    if (prevGitRevisionRef.current === gitRevision) return
    prevGitRevisionRef.current = gitRevision
    refreshTreeRef.current()
    void checkExternalChangeForActiveTabRef.current()
  }, [active, gitRevision])

  const revealPathInTree = useCallback(
    async (path: string): Promise<void> => {
      const parents = parentChain(path)
      const nextExpanded = [...new Set([...expandedPaths, ...parents])]
      updateSession({ expandedPaths: nextExpanded, selectedPath: path })
      const loads = ['', ...parents].filter((parent) => !directoriesRef.current[parent])
      await Promise.all(loads.map((parent) => loadDirectory(parent)))
      pendingTreeScrollPathRef.current = path
    },
    [expandedPaths, loadDirectory, updateSession]
  )
  revealPathInTreeRef.current = revealPathInTree

  useEffect(() => {
    const path = pendingTreeScrollPathRef.current
    if (!path) return
    const index = visibleEntries.findIndex(
      (item) => isVisibleTreeEntry(item) && item.entry.path === path
    )
    if (index < 0) return
    pendingTreeScrollPathRef.current = null
    treeVirtualizer.scrollToIndex(index, { align: 'auto' })
    document.getElementById(treeElementId(path))?.focus({ preventScroll: true })
  }, [treeVirtualizer, visibleEntries])

  useEffect(() => {
    const filter = treeFilter.trim().toLowerCase()
    if (!filter || !workspacePath || !recoveryLoaded) return undefined
    const token = ++filterRevealTokenRef.current
    let cancelled = false
    const timer = window.setTimeout(() => {
      void (async () => {
        const toExpand = new Set<string>([''])
        const queue: string[] = ['']
        let visited = 0
        while (queue.length > 0 && !cancelled && token === filterRevealTokenRef.current) {
          const dir = queue.shift()!
          let state = directoriesRef.current[dir]
          if (!state?.entries.length && !state?.loading) {
            await loadDirectory(dir)
          }
          if (cancelled || token !== filterRevealTokenRef.current) return
          state = directoriesRef.current[dir]
          if (!state || state.error) continue
          visited += 1
          if (visited > FILTER_REVEAL_MAX_DIRS) break
          for (const entry of state.entries) {
            const matches =
              entry.name.toLowerCase().includes(filter) ||
              entry.path.toLowerCase().includes(filter)
            if (matches) {
              for (const parent of parentChain(entry.path)) {
                toExpand.add(parent)
              }
              if (entry.kind === 'directory') {
                toExpand.add(entry.path)
              }
            }
            if (entry.kind === 'directory') {
              queue.push(entry.path)
            }
          }
        }
        if (cancelled || token !== filterRevealTokenRef.current || toExpand.size <= 1) return
        const current = sessionRef.current
        if (!current) return
        const pathsToLoad = [...toExpand].filter(
          (path) => path && !directoriesRef.current[path]?.entries.length
        )
        await Promise.all(pathsToLoad.map((path) => loadDirectory(path)))
        if (cancelled || token !== filterRevealTokenRef.current) return
        updateSession({
          expandedPaths: [...new Set([...current.expandedPaths, ...toExpand])]
        })
      })()
    }, 300)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [loadDirectory, recoveryLoaded, treeFilter, updateSession, workspacePath])

  const createEntry = useCallback(
    async (kind: 'file' | 'directory'): Promise<void> => {
      const operation = captureWorkspaceOperation()
      if (!operation || !window.vyotiq?.workspaceFileCreate) return
      const currentSelectedPath =
        treeFocusPathRef.current ?? selectedPathRef.current
      const selectedEntry = currentSelectedPath
        ? findVisibleTreeEntry(visibleEntries, currentSelectedPath)
        : undefined
      const parent =
        currentSelectedPath && selectedEntry && isDirectoryEntry(selectedEntry)
          ? currentSelectedPath
          : parentPath(currentSelectedPath ?? '')
      const name = await requestPrompt(kind === 'file' ? 'New file name' : 'New folder name')
      if (!name) return
      if (!isCurrentWorkspaceOperation(operation)) return
      setBusy(true)
      setError(null)
      let replacedExisting = false
      let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileCreate>>
      try {
        result = await window.vyotiq.workspaceFileCreate({
          workspacePath: operation.path,
          parentPath: parent,
          name,
          kind,
          replaceExisting: false
        })
      } catch (err) {
        if (isCurrentWorkspaceOperation(operation)) {
          setBusy(false)
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (!isCurrentWorkspaceOperation(operation)) return
      if (!result.ok && result.code === 'FILE_COLLISION') {
        if (
          await requestConfirm(`${name} already exists. Replace it?`, {
            title: 'Replace existing entry',
            confirmLabel: 'Replace',
            danger: true
          })
        ) {
          replacedExisting = true
          const targetPath = parent ? `${parent}/${name}` : name
          const destinationTabs =
            sessionRef.current?.tabs.filter((tab) => isUnderPath(tab.path, targetPath)) ?? []
          if (!(await allowLeaveTabs(destinationTabs.map((tab) => tab.id)))) {
            setBusy(false)
            return
          }
          if (!isCurrentWorkspaceOperation(operation)) return
          try {
            result = await window.vyotiq.workspaceFileCreate({
              workspacePath: operation.path,
              parentPath: parent,
              name,
              kind,
              replaceExisting: true
            })
          } catch (err) {
            if (isCurrentWorkspaceOperation(operation)) {
              setBusy(false)
              setError(err instanceof Error ? err.message : String(err))
            }
            return
          }
          if (!isCurrentWorkspaceOperation(operation)) return
        }
      }
      invalidateDirectoryRequests(operation)
      setBusy(false)
      if (!result.ok) {
        setError(result.error)
        return
      }
      await loadDirectory(parent)
      if (!isCurrentWorkspaceOperation(operation)) return
      const current = sessionRef.current
      const nextTabs = replacedExisting
        ? (current?.tabs ?? []).filter((tab) => tab.path !== result.data.entry.path)
        : current?.tabs
      const nextActive =
        current?.activeTabId && nextTabs?.some((tab) => tab.id === current.activeTabId)
          ? current.activeTabId
          : nextTabs?.[0]?.id ?? null
      updateSession({
        tabs: nextTabs ?? [],
        activeTabId: nextActive,
        selectedPath: result.data.entry.path
      })
      onGitMutated?.()
    },
    [
      allowLeaveTabs,
      captureWorkspaceOperation,
      isCurrentWorkspaceOperation,
      invalidateDirectoryRequests,
      loadDirectory,
      onGitMutated,
      requestConfirm,
      requestPrompt,
      updateSession,
      visibleEntries
    ]
  )

  const moveSelected = useCallback(async (): Promise<void> => {
    const operation = captureWorkspaceOperation()
    const currentSelectedPath = selectedPathRef.current
    if (!operation || !currentSelectedPath || !window.vyotiq?.workspaceFileMove) return
    const name = await requestPrompt('New name', fileName(currentSelectedPath))
    if (!name || name === fileName(currentSelectedPath)) return
    if (!isCurrentWorkspaceOperation(operation)) return
    const destination = parentPath(currentSelectedPath)
      ? `${parentPath(currentSelectedPath)}/${name}`
      : name
    const affectedTabs =
      sessionRef.current?.tabs.filter(
        (tab) =>
          isUnderPath(tab.path, currentSelectedPath) ||
          isUnderPath(tab.path, destination)
      ) ?? []
    if (!(await allowLeaveTabs([...new Set(affectedTabs.map((tab) => tab.id))]))) return
    if (!isCurrentWorkspaceOperation(operation)) return
    setBusy(true)
    setError(null)
    let replacedExisting = false
    let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileMove>>
    try {
      result = await window.vyotiq.workspaceFileMove({
        workspacePath: operation.path,
        fromPath: currentSelectedPath,
        toPath: destination,
        replaceExisting: false
      })
    } catch (err) {
      if (isCurrentWorkspaceOperation(operation)) {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (!isCurrentWorkspaceOperation(operation)) return
    if (!result.ok && result.code === 'FILE_COLLISION') {
      if (
        await requestConfirm(`${destination} already exists. Replace it?`, {
          title: 'Replace existing entry',
          confirmLabel: 'Replace',
          danger: true
        })
      ) {
        replacedExisting = true
        try {
          result = await window.vyotiq.workspaceFileMove({
            workspacePath: operation.path,
            fromPath: currentSelectedPath,
            toPath: destination,
            replaceExisting: true
          })
        } catch (err) {
          if (isCurrentWorkspaceOperation(operation)) {
            setBusy(false)
            setError(err instanceof Error ? err.message : String(err))
          }
          return
        }
        if (!isCurrentWorkspaceOperation(operation)) return
      }
    }
    invalidateDirectoryRequests(operation)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const current = sessionRef.current
    const nextTabs = (current?.tabs ?? [])
      .filter((tab) => !(replacedExisting && isUnderPath(tab.path, destination)))
      .map((tab) =>
        isUnderPath(tab.path, currentSelectedPath)
          ? {
              ...tab,
              path: `${destination}${tab.path.slice(currentSelectedPath.length)}`
            }
          : tab
      )
    const nextExpanded = (current?.expandedPaths ?? []).map((path) =>
      isUnderPath(path, currentSelectedPath)
        ? `${destination}${path.slice(currentSelectedPath.length)}`
        : path
    ).filter((path) => !(replacedExisting && isUnderPath(path, destination)))
    const nextDirectories = Object.fromEntries(
      Object.entries(directories).filter(
        ([path]) =>
          !isUnderPath(path, currentSelectedPath) &&
          !(replacedExisting && isUnderPath(path, destination))
      )
    )
    directoriesRef.current = nextDirectories
    setDirectories(nextDirectories)
    updateSession({
      tabs: nextTabs,
      selectedPath: destination,
      activeTabId:
        current?.activeTabId && nextTabs.some((tab) => tab.id === current.activeTabId)
          ? current.activeTabId
          : nextTabs[0]?.id ?? null,
      expandedPaths: nextExpanded
    })
    await loadDirectory(parentPath(currentSelectedPath))
    if (!isCurrentWorkspaceOperation(operation)) return
    if (nextExpanded.includes(destination)) await loadDirectory(destination)
    if (!isCurrentWorkspaceOperation(operation)) return
    onGitMutated?.()
  }, [
    allowLeaveTabs,
    captureWorkspaceOperation,
    directories,
    isCurrentWorkspaceOperation,
    invalidateDirectoryRequests,
    loadDirectory,
    onGitMutated,
    requestConfirm,
    requestPrompt,
    updateSession
  ])

  const duplicateFile = useCallback(
    async (path: string): Promise<void> => {
      const operation = captureWorkspaceOperation()
      if (
        !operation ||
        !window.vyotiq?.workspaceFileRead ||
        !window.vyotiq.workspaceFileCreate ||
        !window.vyotiq.workspaceFileSave
      ) {
        return
      }
      let source: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
      try {
        source = await window.vyotiq.workspaceFileRead({
          workspacePath: operation.path,
          path
        })
      } catch (err) {
        if (isCurrentWorkspaceOperation(operation)) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (!isCurrentWorkspaceOperation(operation) || !source.ok) {
        if (isCurrentWorkspaceOperation(operation) && !source.ok) setError(source.error)
        return
      }
      const name = await requestPrompt('Duplicate file name', `${fileName(path)}.copy`)
      if (!name || !isCurrentWorkspaceOperation(operation)) return
      const parent = parentPath(path)
      const candidatePath = parent ? `${parent}/${name}` : name
      let created: Awaited<ReturnType<typeof window.vyotiq.workspaceFileCreate>>
      try {
        created = await window.vyotiq.workspaceFileCreate({
          workspacePath: operation.path,
          parentPath: parent,
          name,
          kind: 'file',
          replaceExisting: false
        })
      } catch (err) {
        if (isCurrentWorkspaceOperation(operation)) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (!isCurrentWorkspaceOperation(operation)) return
      if (!created.ok && created.code === 'FILE_COLLISION') {
        if (
          !(await requestConfirm(`${name} already exists. Replace it?`, {
            title: 'Replace duplicate',
            confirmLabel: 'Replace',
            danger: true
          }))
        ) {
          return
        }
        const destinationTabs =
          sessionRef.current?.tabs.filter((tab) => isUnderPath(tab.path, candidatePath)) ?? []
        if (!(await allowLeaveTabs(destinationTabs.map((tab) => tab.id)))) return
        if (!isCurrentWorkspaceOperation(operation)) return
        try {
          created = await window.vyotiq.workspaceFileCreate({
            workspacePath: operation.path,
            parentPath: parent,
            name,
            kind: 'file',
            replaceExisting: true
          })
        } catch (err) {
          if (isCurrentWorkspaceOperation(operation)) {
            setError(err instanceof Error ? err.message : String(err))
          }
          return
        }
        if (!isCurrentWorkspaceOperation(operation)) return
      }
      if (!created.ok) {
        setError(created.error)
        return
      }
      const targetPath = created.data.entry.path
      let saved: Awaited<ReturnType<typeof window.vyotiq.workspaceFileSave>>
      try {
        saved = await window.vyotiq.workspaceFileSave({
          workspacePath: operation.path,
          path: targetPath,
          kind: source.data.kind,
          content: source.data.content,
          encoding: source.data.encoding,
          eol: source.data.eol,
          bom: source.data.bom,
          expectedVersion: null,
          replaceExisting: true
        })
      } catch (err) {
        if (isCurrentWorkspaceOperation(operation)) {
          setError(err instanceof Error ? err.message : String(err))
        }
        return
      }
      if (!isCurrentWorkspaceOperation(operation)) return
      if (!saved.ok) {
        setError(saved.error)
        return
      }
      invalidateDirectoryRequests(operation)
      await loadDirectory(parent)
      if (!isCurrentWorkspaceOperation(operation)) return
      selectedPathRef.current = targetPath
      updateSession({ selectedPath: targetPath })
      onGitMutated?.()
    },
    [
      allowLeaveTabs,
      captureWorkspaceOperation,
      invalidateDirectoryRequests,
      isCurrentWorkspaceOperation,
      loadDirectory,
      onGitMutated,
      requestConfirm,
      requestPrompt,
      updateSession
    ]
  )

  const deleteSelected = useCallback(async (): Promise<void> => {
    const operation = captureWorkspaceOperation()
    const currentSelectedPath = selectedPathRef.current
    if (!operation || !currentSelectedPath || !window.vyotiq?.workspaceFileDelete) return
    if (
      !(await requestConfirm(
        `Permanently delete ${currentSelectedPath}? This cannot be undone.`,
        {
          title: 'Permanently delete',
          confirmLabel: 'Delete permanently',
          danger: true
        }
      ))
    ) {
      return
    }
    const affectedTabs =
      sessionRef.current?.tabs.filter((tab) => isUnderPath(tab.path, currentSelectedPath)) ?? []
    if (!(await allowLeaveTabs(affectedTabs.map((tab) => tab.id)))) return
    if (!isCurrentWorkspaceOperation(operation)) return
    setBusy(true)
    setError(null)
    let result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileDelete>>
    try {
      result = await window.vyotiq.workspaceFileDelete({
        workspacePath: operation.path,
        path: currentSelectedPath,
        recursive: false
      })
    } catch (err) {
      if (isCurrentWorkspaceOperation(operation)) {
        setBusy(false)
        setError(err instanceof Error ? err.message : String(err))
      }
      return
    }
    if (!isCurrentWorkspaceOperation(operation)) return
    if (!result.ok && result.code === 'DIRECTORY_NOT_EMPTY') {
      if (
        await requestConfirm(
          `${currentSelectedPath} is not empty. Delete it and everything inside?`,
          {
            title: 'Delete directory contents',
            confirmLabel: 'Delete everything',
            danger: true
          }
        )
      ) {
        try {
          result = await window.vyotiq.workspaceFileDelete({
            workspacePath: operation.path,
            path: currentSelectedPath,
            recursive: true
          })
        } catch (err) {
          if (isCurrentWorkspaceOperation(operation)) {
            setBusy(false)
            setError(err instanceof Error ? err.message : String(err))
          }
          return
        }
        if (!isCurrentWorkspaceOperation(operation)) return
      }
    }
    invalidateDirectoryRequests(operation)
    setBusy(false)
    if (!result.ok) {
      setError(result.error)
      return
    }
    const current = sessionRef.current
    const nextTabs = (current?.tabs ?? []).filter(
      (tab) => !isUnderPath(tab.path, currentSelectedPath)
    )
    const nextActive =
      current?.activeTabId && nextTabs.some((tab) => tab.id === current.activeTabId)
        ? current.activeTabId
        : nextTabs[0]?.id ?? null
    const nextExpanded = (current?.expandedPaths ?? []).filter(
      (path) => !isUnderPath(path, currentSelectedPath)
    )
    const nextDirectories = Object.fromEntries(
      Object.entries(directories).filter(
        ([path]) => !isUnderPath(path, currentSelectedPath)
      )
    )
    directoriesRef.current = nextDirectories
    setDirectories(nextDirectories)
    updateSession({
      tabs: nextTabs,
      activeTabId: nextActive,
      selectedPath: null,
      expandedPaths: nextExpanded
    })
    await loadDirectory(parentPath(currentSelectedPath))
    if (!isCurrentWorkspaceOperation(operation)) return
    onGitMutated?.()
  }, [
    allowLeaveTabs,
    captureWorkspaceOperation,
    directories,
    isCurrentWorkspaceOperation,
    invalidateDirectoryRequests,
    loadDirectory,
    onGitMutated,
    requestConfirm,
    updateSession
  ])

  const closeTab = useCallback(
    async (id: string): Promise<void> => {
      const operation = captureWorkspaceOperation()
      if (!operation) return
      if (!(await allowLeaveTab(id))) return
      if (!isCurrentWorkspaceOperation(operation)) return
      const current = sessionRef.current
      if (!current) return
      const removedIndex = current.tabs.findIndex((tab) => tab.id === id)
      const nextTabs = current.tabs.filter((tab) => tab.id !== id)
      const nextActive =
        current.activeTabId === id
          ? nextTabs[Math.min(removedIndex, Math.max(0, nextTabs.length - 1))]?.id ?? null
          : current.activeTabId
      updateSession({
        tabs: nextTabs,
        activeTabId: nextActive,
        selectedPath: nextTabs.find((tab) => tab.id === nextActive)?.path ?? null
      })
      setTreeFocusPath(nextTabs.find((tab) => tab.id === nextActive)?.path ?? null)
    },
    [
      allowLeaveTab,
      captureWorkspaceOperation,
      isCurrentWorkspaceOperation,
      updateSession
    ]
  )

  const selectTab = useCallback(
    async (id: string): Promise<void> => {
      if (activeTabId === id) return
      const operation = captureWorkspaceOperation()
      if (!operation) return
      if (activeTab && !(await allowLeaveTab(activeTab.id))) return
      if (!isCurrentWorkspaceOperation(operation)) return
      const next = sessionRef.current?.tabs.find((tab) => tab.id === id)
      if (next) {
        await revealPathInTreeRef.current(next.path)
        setTreeFocusPath(next.path)
        updateSession({ activeTabId: id, selectedPath: next.path })
      }
    },
    [
      activeTab,
      activeTabId,
      allowLeaveTab,
      captureWorkspaceOperation,
      isCurrentWorkspaceOperation,
      updateSession
    ]
  )

  const selectContextPath = useCallback((path: string): void => {
    selectedPathRef.current = path
    setTreeFocusPath(path)
    if (!activeTab) {
      updateSession({ selectedPath: path })
    }
  }, [activeTab, updateSession])

  const copyPath = useCallback((path: string): void => {
    if (!window.vyotiq?.writeClipboard?.(path)) {
      setError('Could not copy the path.')
    }
  }, [])

  const openExternally = useCallback(
    async (path: string): Promise<void> => {
      if (!workspacePath || !window.vyotiq?.slashCommandsOpenFile) return
      const result = await window.vyotiq.slashCommandsOpenFile({ workspacePath, path })
      if (!result.ok) setError(result.error)
    },
    [workspacePath]
  )

  const revealPath = useCallback(
    async (path: string): Promise<void> => {
      if (!workspacePath) return
      if (window.vyotiq?.workspaceFileReveal) {
        const result = await window.vyotiq.workspaceFileReveal({ workspacePath, path })
        if (!result.ok) setError(result.error)
        return
      }
      await openExternally(path)
    },
    [openExternally, workspacePath]
  )

  const reloadTabWithConfirm = useCallback(
    async (id: string): Promise<boolean> => {
      const tab = sessionRef.current?.tabs.find((item) => item.id === id)
      if (!tab) return false
      if (
        tab.dirty &&
        !(await requestConfirm(`Discard local edits in ${fileName(tab.path)} and reload it?`, {
          title: 'Discard and reload',
          confirmLabel: 'Discard and reload',
          danger: true
        }))
      ) {
        return false
      }
      return reloadTab(id)
    },
    [reloadTab, requestConfirm]
  )

  const showDiffForPath = useCallback(
    async (path: string): Promise<void> => {
      if (!workspacePath || !window.vyotiq?.gitDiff) return
      const tab = sessionRef.current?.tabs.find((item) => item.path === path)
      if (!tab) return
      setIntegrationBusy(true)
      setError(null)
      try {
        if (tab.dirty && !(await saveTab(tab.id))) return
        const result = await window.vyotiq.gitDiff({
          workspacePath,
          path,
          vsHead: true
        })
        if (!result.ok) {
          setError(`Diff View unavailable: ${result.error}`)
          return
        }
        setDiffContent(result.data.content)
        setBlameResult(null)
        setLspResponse(null)
        setEditorMode('diff')
      } catch (err) {
        setError(`Diff View unavailable: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setIntegrationBusy(false)
      }
    },
    [saveTab, workspacePath]
  )

  const showDiffView = useCallback(async (): Promise<void> => {
    if (!activeTab) return
    await showDiffForPath(activeTab.path)
  }, [activeTab, showDiffForPath])

  useEffect(() => {
    if (!openPath) {
      openPathRef.current = null
      return
    }
    const requestKey = [
      openPath.workspacePath,
      openPath.path,
      openPath.line ?? '',
      openPath.column ?? '',
      openPath.mode ?? ''
    ].join('\0')
    if (openPathRef.current === requestKey) return
    openPathRef.current = requestKey
    if (!workspacePath || openPath.workspacePath !== workspacePath) {
      onOpenPathHandled?.(openPath)
      return
    }
    void (async () => {
      try {
        await openFile(openPath.path)
        const tab = sessionRef.current?.tabs.find((item) => item.path === openPath.path)
        if (tab?.kind === 'text' && openPath.line != null) {
          const cursor = cursorAtLine(tab.content, openPath.line, openPath.column ?? 1)
          mutateTab(tab.id, (current) => ({
            ...current,
            cursor,
            selections: [{ from: cursor, to: cursor }]
          }))
          setScrollToLine(openPath.line)
        }
        if (openPath.mode === 'diff') {
          skipEditorModeResetRef.current = true
          await showDiffForPath(openPath.path)
        }
      } finally {
        onOpenPathHandled?.(openPath)
      }
    })()
  }, [
    mutateTab,
    onOpenPathHandled,
    openFile,
    openPath,
    showDiffForPath,
    workspacePath
  ])

  const showBlameView = useCallback(async (): Promise<void> => {
    if (!workspacePath || !activeTab || activeTab.kind !== 'text' || !window.vyotiq?.gitBlame) {
      return
    }
    setIntegrationBusy(true)
    setError(null)
    try {
      const result = await window.vyotiq.gitBlame(workspacePath, activeTab.path)
      if (!result.ok) {
        setError(`Git Blame unavailable: ${result.error}`)
        return
      }
      setBlameResult(result.data)
      setDiffContent(null)
      setLspResponse(null)
      setEditorMode('blame')
    } catch (err) {
      setError(`Git Blame unavailable: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setIntegrationBusy(false)
    }
  }, [activeTab, workspacePath])

  const showLspView = useCallback(async (): Promise<void> => {
    if (!workspacePath || !activeTab || activeTab.kind !== 'text') return
    const statusApi = window.vyotiq?.workspaceLspStatus
    if (!statusApi) {
      setLspStatus({ kind: 'unavailable', detail: 'Language-server discovery is unavailable.' })
      setEditorMode('lsp')
      return
    }
    setIntegrationBusy(true)
    setError(null)
    try {
      const status = await statusApi({ workspacePath, path: activeTab.path })
      if (!status.ok) {
        setError(`LSP unavailable: ${status.error}`)
        return
      }
      setLspStatus(status.data)
      setDiffContent(null)
      setBlameResult(null)
      setEditorMode('lsp')
      if (status.data.kind === 'available' && window.vyotiq.workspaceLspRequest) {
        const response = await window.vyotiq.workspaceLspRequest({
          workspacePath,
          path: activeTab.path,
          content: activeTab.content,
          action: 'diagnostics',
          line: Math.max(0, (activeTextPosition?.line ?? 1) - 1),
          character: Math.max(0, (activeTextPosition?.column ?? 1) - 1)
        })
        if (response.ok) setLspResponse(response.data)
      }
    } catch (err) {
      setLspStatus({
        kind: 'unavailable',
        detail: err instanceof Error ? err.message : String(err)
      })
      setEditorMode('lsp')
    } finally {
      setIntegrationBusy(false)
    }
  }, [activeTab, activeTextPosition, workspacePath])

  useEffect(() => {
    if (
      !workspacePath ||
      activeTab?.kind !== 'text' ||
      !window.vyotiq?.workspaceFormatterStatus
    ) {
      return undefined
    }
    let cancelled = false
    void window.vyotiq
      .workspaceFormatterStatus({ workspacePath, path: activeTab.path })
      .then((result) => {
        if (cancelled) return
        setFormatterStatus(
          result.ok
            ? result.data
            : { kind: 'unavailable', detail: result.error }
        )
      })
      .catch((err) => {
        if (!cancelled) {
          setFormatterStatus({
            kind: 'unavailable',
            detail: err instanceof Error ? err.message : String(err)
          })
        }
      })
    return () => {
      cancelled = true
    }
  }, [activeTab?.kind, activeTab?.path, workspacePath])

  const saveTabMenuItem = useCallback(
    (tab: FileTab): ContextMenuItem => ({
      id: 'save-tab',
      label: 'Save',
      icon: 'check',
      disabled: busy || !tab.dirty || tab.conflict,
      disabledReason: tab.conflict
        ? 'Resolve the external file change before saving.'
        : !tab.dirty
          ? 'The active file has no unsaved changes.'
          : undefined,
      onSelect: () => void saveTab(tab.id)
    }),
    [busy, saveTab]
  )

  const reloadTabMenuItem = useCallback(
    (tab: FileTab): ContextMenuItem => ({
      id: 'reload-tab',
      label: 'Discard/Reload',
      icon: 'refresh',
      disabled: busy || (!tab.dirty && !tab.conflict),
      disabledReason:
        !tab.dirty && !tab.conflict ? 'The active file is already in sync with disk.' : undefined,
      onSelect: () => void reloadTabWithConfirm(tab.id)
    }),
    [busy, reloadTabWithConfirm]
  )

  const contextMenuItems = useMemo<ContextMenuItem[]>(() => {
    const current = contextMenu
    if (!current) return []
    const target = current.target
    if (target.kind === 'surface') {
      return [
        {
          id: 'create-file',
          label: 'New file',
          icon: 'plus',
          onSelect: () => {
            selectContextPath('')
            void createEntry('file')
          }
        },
        {
          id: 'create-directory',
          label: 'New folder',
          icon: 'folderPlus',
          onSelect: () => {
            selectContextPath('')
            void createEntry('directory')
          }
        },
        { type: 'separator', id: 'surface-separator' },
        {
          id: 'refresh',
          label: 'Refresh',
          icon: 'refresh',
          onSelect: refreshTree
        }
      ]
    }
    if (target.kind === 'tab') {
      const tab = tabs.find((item) => item.id === target.tabId)
      if (!tab) return []
      return [
        saveTabMenuItem(tab),
        reloadTabMenuItem(tab),
        ...(tab.conflict
          ? [
              {
                id: 'overwrite-tab',
                label: 'Overwrite external changes',
                icon: 'warning',
                danger: true,
                onSelect: () => void overwriteTab(tab.id)
              } satisfies ContextMenuItem
            ]
          : []),
        { type: 'separator', id: 'tab-separator' },
        {
          id: 'copy-tab-path',
          label: 'Copy relative path',
          onSelect: () => copyPath(tab.path)
        },
        {
          id: 'copy-tab-absolute-path',
          label: 'Copy absolute path',
          onSelect: () => copyPath(absoluteWorkspacePath(workspacePath ?? '', tab.path))
        },
        {
          id: 'open-tab-external',
          label: 'Open externally',
          onSelect: () => void openExternally(tab.path)
        },
      {
        id: 'reveal-tab',
        label: 'Reveal in file manager',
        onSelect: () => void revealPath(tab.path)
      },
        {
          id: 'close-tab',
          label: 'Close tab',
          shortcut: 'Ctrl/Cmd+W',
          onSelect: () => void closeTab(tab.id)
        }
      ]
    }
    const path = target.path
    const isDirectory = target.entryKind === 'directory'
    const isFile = target.entryKind === 'file'
    const isSymlink = target.entryKind === 'symlink'
    return [
      {
        id: 'open-entry',
        label: isDirectory ? 'Expand/collapse' : 'Open',
        icon: isDirectory ? 'folderOpen' : 'fileSearch',
        disabled: !isDirectory && !isFile,
        onSelect: () => void selectTreePathRef.current(path)
      },
      { type: 'separator', id: 'entry-open-separator' },
      {
        id: 'create-file',
        label: 'New file here',
        icon: 'plus',
        disabled: isSymlink,
        onSelect: () => {
          selectContextPath(path)
          void createEntry('file')
        }
      },
      {
        id: 'create-directory',
        label: 'New folder here',
        icon: 'folderPlus',
        disabled: isSymlink,
        onSelect: () => {
          selectContextPath(path)
          void createEntry('directory')
        }
      },
      {
        id: 'rename-entry',
        label: 'Rename',
        icon: 'edit',
        disabled: isSymlink || busy,
        onSelect: () => {
          selectContextPath(path)
          void moveSelected()
        }
      },
      {
        id: 'duplicate-entry',
        label: 'Duplicate',
        icon: 'copy',
        disabled: !isFile || busy,
        onSelect: () => void duplicateFile(path)
      },
      {
        id: 'delete-entry',
        label: 'Delete permanently',
        icon: 'trash',
        danger: true,
        disabled: isSymlink || busy,
        onSelect: () => {
          selectContextPath(path)
          void deleteSelected()
        }
      },
      { type: 'separator', id: 'entry-path-separator' },
      {
        id: 'copy-entry-path',
        label: 'Copy relative path',
        onSelect: () => copyPath(path)
      },
      {
        id: 'copy-entry-absolute-path',
        label: 'Copy absolute path',
        onSelect: () => copyPath(absoluteWorkspacePath(workspacePath ?? '', path))
      },
      {
        id: 'open-entry-external',
        label: 'Open externally',
        disabled: !isFile,
        onSelect: () => void openExternally(path)
      },
      {
        id: 'reveal-entry',
        label: 'Reveal in file manager',
        onSelect: () => void revealPath(path)
      },
      ...(isDirectory
        ? [
            {
              id: 'refresh-entry',
              label: 'Refresh folder',
              icon: 'refresh',
              onSelect: () => void loadDirectory(path)
            } satisfies ContextMenuItem
          ]
        : [])
    ]
  }, [
    busy,
    closeTab,
    contextMenu,
    copyPath,
    createEntry,
    deleteSelected,
    duplicateFile,
    loadDirectory,
    openExternally,
    overwriteTab,
    revealPath,
    reloadTabMenuItem,
    refreshTree,
    saveTabMenuItem,
    selectContextPath,
    tabs,
    moveSelected,
    workspacePath
  ])

  const editorActionItems = useMemo<ContextMenuItem[]>(() => {
    if (!activeTab) return []
    const textOnlyReason = 'This action is available for text files only.'
    const formatterUnavailable =
      formatterStatus?.kind === 'unavailable'
        ? formatterStatus.detail
        : 'Checking for an installed formatter…'
    return [
      saveTabMenuItem(activeTab),
      reloadTabMenuItem(activeTab),
      { type: 'separator', id: 'editor-file-separator' },
      {
        id: 'editor-reveal',
        label: 'Reveal in file manager',
        icon: 'folderOpen',
        disabled: !window.vyotiq?.workspaceFileReveal && !window.vyotiq?.slashCommandsOpenFile,
        disabledReason: 'File reveal is unavailable in this build.',
        onSelect: () => void revealPath(activeTab.path)
      },
      {
        id: 'editor-copy-path',
        label: 'Copy relative path',
        icon: 'copy',
        onSelect: () => copyPath(activeTab.path)
      },
      {
        id: 'editor-diff',
        label: 'Diff View',
        icon: 'columns',
        disabled: integrationBusy || !window.vyotiq?.gitDiff,
        disabledReason: integrationBusy
          ? 'Another editor integration is still loading.'
          : 'Git diff is unavailable in this build.',
        onSelect: () => void showDiffView()
      },
      {
        id: 'editor-lsp',
        label: 'LSP',
        icon: 'plug',
        disabled: activeTab.kind !== 'text' || !window.vyotiq?.workspaceLspStatus,
        disabledReason:
          activeTab.kind !== 'text' ? textOnlyReason : 'Language-server discovery is unavailable.',
        onSelect: () => void showLspView()
      },
      {
        id: 'editor-go-to-definition',
        label: 'Go to Definition',
        icon: 'chevronRight',
        disabled: activeTab.kind !== 'text' || !window.vyotiq?.workspaceLspRequest,
        disabledReason:
          activeTab.kind !== 'text' ? textOnlyReason : 'Language-server requests are unavailable.',
        onSelect: () => {
          if (!workspacePath || activeTab.kind !== 'text') return
          void window.vyotiq
            .workspaceLspRequest({
              workspacePath,
              path: activeTab.path,
              content: activeTab.content,
              action: 'definition',
              line: Math.max(0, (activeTextPosition?.line ?? 1) - 1),
              character: Math.max(0, (activeTextPosition?.column ?? 1) - 1)
            })
            .then((res) => {
              if (!res.ok) {
                setError(`Go to Definition failed: ${res.error}`)
                return
              }
              if (res.data.kind !== 'definition' || !res.data.path) {
                setError('No definition found.')
                return
              }
              const defPath = res.data.path
              const defLine = res.data.line
              void openFile(defPath).then(() => setScrollToLine(defLine + 1))
            })
        }
      },
      {
        id: 'editor-rename',
        label: 'Rename Symbol',
        icon: 'edit',
        disabled: activeTab.kind !== 'text' || !window.vyotiq?.workspaceLspRequest,
        disabledReason:
          activeTab.kind !== 'text' ? textOnlyReason : 'Language-server requests are unavailable.',
        onSelect: () => {
          if (!workspacePath || activeTab.kind !== 'text') return
          void requestPrompt('Rename symbol').then(
            (name) => {
              if (!name?.trim()) return
              void window.vyotiq
                .workspaceLspRequest({
                  workspacePath,
                  path: activeTab.path,
                  content: activeTab.content,
                  action: 'rename',
                  newName: name.trim(),
                  line: Math.max(0, (activeTextPosition?.line ?? 1) - 1),
                  character: Math.max(0, (activeTextPosition?.column ?? 1) - 1)
                })
                .then((res) => {
                  if (!res.ok) {
                    setError(`Rename failed: ${res.error}`)
                    return
                  }
                  if (res.data.kind !== 'rename') {
                    setError('Rename is unavailable for this symbol.')
                    return
                  }
                  if (res.data.edits.length === 0) {
                    setError('Rename returned no edits.')
                    return
                  }
                  const byPath = new Map<string, typeof res.data.edits>()
                  for (const edit of res.data.edits) {
                    const list = byPath.get(edit.path) ?? []
                    list.push(edit)
                    byPath.set(edit.path, list)
                  }
                  void (async () => {
                    try {
                      for (const [path, pathEdits] of byPath) {
                        const read = await window.vyotiq.workspaceFileRead({
                          workspacePath,
                          path
                        })
                        if (!read.ok) {
                          setError(`Rename failed reading ${path}: ${read.error}`)
                          return
                        }
                        if (read.data.kind !== 'text') {
                          setError(`Rename skipped binary file ${path}.`)
                          return
                        }
                        const next = applyLspTextEdits(read.data.content, pathEdits)
                        const saved = await window.vyotiq.workspaceFileSave({
                          workspacePath,
                          path,
                          kind: 'text',
                          content: next,
                          encoding: read.data.encoding,
                          eol: read.data.eol,
                          bom: read.data.bom,
                          expectedVersion: read.data.version,
                          replaceExisting: false
                        })
                        if (!saved.ok) {
                          setError(`Rename failed writing ${path}: ${saved.error}`)
                          return
                        }
                        const open = sessionRef.current?.tabs.find((tab) => tab.path === path)
                        if (open && !open.dirty) void reloadTab(open.id)
                      }
                      setError(
                        `Renamed in ${byPath.size} file${byPath.size === 1 ? '' : 's'}.`
                      )
                    } catch (err) {
                      setError(err instanceof Error ? err.message : String(err))
                    }
                  })()
                })
            }
          )
        }
      },
      {
        id: 'editor-blame',
        label: 'Git Blame',
        icon: 'branch',
        disabled: activeTab.kind !== 'text' || !window.vyotiq?.gitBlame,
        disabledReason:
          activeTab.kind !== 'text' ? textOnlyReason : 'Git blame is unavailable in this build.',
        onSelect: () => void showBlameView()
      },
      { type: 'separator', id: 'editor-view-separator' },
      {
        id: 'editor-line-numbers',
        label: 'Line numbers',
        checked: showLineNumbers,
        disabled: activeTab.kind !== 'text',
        disabledReason: textOnlyReason,
        onSelect: () => updateSession({ showLineNumbers: !showLineNumbers })
      },
      {
        id: 'editor-word-wrap',
        label: 'Word wrap',
        checked: wordWrap,
        disabled: activeTab.kind !== 'text',
        disabledReason: textOnlyReason,
        onSelect: () => updateSession({ wordWrap: !wordWrap })
      },
      {
        id: 'editor-encoding',
        label: `Encoding: ${activeTab.encoding.toUpperCase()}${activeTab.bom ? ' (BOM)' : ''}`,
        disabled: true,
        onSelect: () => {}
      },
      ...(activeTab.eol !== 'none'
        ? [
            {
              id: 'editor-line-endings',
              label: `Line endings: ${activeTab.eol.toUpperCase()}`,
              disabled: true,
              onSelect: () => {}
            } satisfies ContextMenuItem
          ]
        : []),
      {
        id: 'editor-auto-save',
        label: 'Auto Save',
        checked: autoSave,
        onSelect: () => updateSession({ autoSave: !autoSave })
      },
      {
        id: 'editor-format-on-save',
        label: 'Format on Save',
        checked: formatOnSave,
        disabled:
          activeTab.kind !== 'text' ||
          (!window.vyotiq?.workspaceFormatterStatus ||
            (formatterStatus?.kind !== 'available' && !formatOnSave)),
        disabledReason:
          activeTab.kind !== 'text' ? textOnlyReason : formatterUnavailable,
        onSelect: () => updateSession({ formatOnSave: !formatOnSave })
      }
    ]
  }, [
    activeTab,
    activeTextPosition,
    autoSave,
    copyPath,
    formatterStatus,
    formatOnSave,
    integrationBusy,
    openFile,
    reloadTab,
    reloadTabMenuItem,
    requestPrompt,
    revealPath,
    saveTabMenuItem,
    setError,
    showBlameView,
    showDiffView,
    showLineNumbers,
    showLspView,
    updateSession,
    wordWrap,
    workspacePath
  ])

  const workspaceActionItems = useMemo<ActionMenuItem[]>(() => {
    const items: ActionMenuItem[] = [
      {
        id: 'refresh-files',
        label: 'Refresh files',
        icon: 'refresh',
        onSelect: refreshTree
      },
      {
        id: 'show-ignored-files',
        label: 'Show ignored files',
        checked: showIgnoredFiles,
        onSelect: () => updateSession({ showIgnoredFiles: !showIgnoredFiles })
      }
    ]
    if (canMutateSelected && !busy) {
      items.unshift(
        {
          id: 'rename-selected',
          label: 'Rename selected',
          icon: 'edit',
          onSelect: () => void moveSelected()
        },
        {
          id: 'delete-selected',
          label: 'Delete selected permanently',
          icon: 'trash',
          onSelect: () => void deleteSelected()
        }
      )
    }
    return items
  }, [busy, canMutateSelected, deleteSelected, moveSelected, refreshTree, showIgnoredFiles, updateSession])

  const treeSortItems = useMemo<ActionMenuItem[]>(
    () => [
      {
        id: 'sort-name',
        label: 'Name',
        onSelect: () => updateSession({ treeSort: 'name' })
      },
      {
        id: 'sort-kind',
        label: 'Type',
        onSelect: () => updateSession({ treeSort: 'kind' })
      }
    ],
    [updateSession]
  )

  const closeContextMenu = useCallback((): void => {
    setContextMenu(null)
  }, [])

  const closeEditorActions = useCallback((): void => {
    setEditorActionsAnchor(null)
  }, [])

  const openEditorActions = useCallback((): void => {
    const button = editorActionsButtonRef.current
    if (!button) return
    const rect = button.getBoundingClientRect()
    setContextMenu(null)
    editorMenuReturnFocusRef.current = button
    setEditorActionsAnchor({ x: rect.right, y: rect.bottom })
  }, [])

  useEffect(() => {
    if (active) return
    setContextMenu(null)
    setWorkspaceActionsOpen(false)
    setEditorActionsAnchor(null)
  }, [active])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!active) return
      if (event.defaultPrevented) return
      if (
        !panelRootRef.current ||
        !(event.target instanceof Node) ||
        !panelRootRef.current.contains(event.target)
      ) {
        return
      }
      if (!(event.ctrlKey || event.metaKey) || event.altKey) return
      if (event.key.toLowerCase() === 's' && activeTabId) {
        event.preventDefault()
        event.stopPropagation()
        void saveTab(activeTabId)
      } else if (event.key.toLowerCase() === 'w' && activeTabId) {
        event.preventDefault()
        event.stopPropagation()
        void closeTab(activeTabId)
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [active, activeTabId, closeTab, saveTab])

  const updateTextMeta = useCallback(
    (meta: { cursor: number; selections: WorkspaceEditorSelection[] }): void => {
      if (!activeTabId) return
      mutateTab(activeTabId, (tab) => ({
        ...tab,
        cursor: meta.cursor,
        selections: meta.selections
      }))
    },
    [activeTabId, mutateTab]
  )

  const workspacePathCompleteRef = useRef(workspacePath)
  workspacePathCompleteRef.current = workspacePath
  const inlineCompleteFileRef = useRef(
    activeTab?.kind === 'text' ? activeTab.path : ''
  )
  inlineCompleteFileRef.current = activeTab?.kind === 'text' ? activeTab.path : ''
  const inlineAbortRef = useRef<(() => void) | null>(null)

  const requestInlineComplete = useMemo((): InlineCompleteRequestFn => {
    const fn = (async (prefix: string, suffix: string): Promise<string> => {
      const api = window.vyotiq
      const ws = workspacePathCompleteRef.current
      const path = inlineCompleteFileRef.current
      if (!api?.workspaceInlineComplete || !ws || !path) return ''
      inlineAbortRef.current?.()
      const requestId = crypto.randomUUID()
      let active = true
      inlineAbortRef.current = () => {
        if (!active) return
        active = false
        void api.workspaceInlineCompleteAbort?.({ requestId })
      }
      try {
        const result = await api.workspaceInlineComplete({
          workspacePath: ws,
          path,
          prefix,
          suffix,
          requestId
        })
        if (!active) return ''
        if (!result.ok) return ''
        return result.data.text
      } catch {
        return ''
      } finally {
        if (active && inlineAbortRef.current) {
          inlineAbortRef.current = null
        }
      }
    }) as InlineCompleteRequestFn
    fn.abort = () => {
      inlineAbortRef.current?.()
    }
    return fn
  }, [])

  useEffect(() => {
    if (tabAutocompleteEnabled && workspacePath) return
    inlineAbortRef.current?.()
  }, [tabAutocompleteEnabled, workspacePath])

  const updateHexMeta = useCallback(
    (meta: {
      cursor: number
      selections: WorkspaceEditorSelection[]
      bookmarks: number[]
      template: string | null
    }): void => {
      if (!activeTabId) return
      mutateTab(activeTabId, (tab) => ({
        ...tab,
        cursor: meta.cursor,
        selections: meta.selections,
        bookmarks: meta.bookmarks,
        template: meta.template
      }))
    },
    [activeTabId, mutateTab]
  )

  const updateEditorView = useCallback(
    (meta: { scrollTop: number }): void => {
      if (!activeTabId) return
      mutateTab(activeTabId, (tab) => ({
        ...tab,
        scrollTop: Math.max(0, Math.round(meta.scrollTop))
      }))
    },
    [activeTabId, mutateTab]
  )

  const navigateTreeTo = useCallback(
    (nextPath: string): void => {
      setTreeFocusPath(nextPath)
      if (!activeTab) {
        updateSession({ selectedPath: nextPath })
      }
      document.getElementById(treeElementId(nextPath))?.focus({ preventScroll: true })
    },
    [activeTab, updateSession]
  )

  const selectTreePath = useCallback(
    async (path: string): Promise<void> => {
      let entry =
        findVisibleTreeEntry(visibleEntries, path) ??
        findTreeEntry(directoriesRef.current, path)
      if (!entry) {
        await revealPathInTreeRef.current(path)
        entry = findTreeEntry(directoriesRef.current, path)
      }
      if (!entry) return
      if (isDirectoryEntry(entry)) {
        toggleDirectory(path)
        navigateTreeTo(path)
      } else if (entry.kind === 'file') {
        await openFile(path)
      } else if (entry.kind === 'symlink') {
        navigateTreeTo(path)
        setError('Symlinks are displayed for transparency but are not opened or mutated here.')
      } else {
        navigateTreeTo(path)
        setError('This filesystem entry is not a regular file or directory.')
      }
    },
    [navigateTreeTo, openFile, toggleDirectory, visibleEntries]
  )
  selectTreePathRef.current = selectTreePath

  const onTreeKeyDown = useCallback(
    async (event: React.KeyboardEvent<HTMLElement>, path: string): Promise<void> => {
      const index = visibleEntries.findIndex(
        (item) => isVisibleTreeEntry(item) && item.entry.path === path
      )
      if (index < 0) return
      const current = isVisibleTreeEntry(visibleEntries[index]!)
        ? visibleEntries[index]!.entry
        : undefined
      if (!current) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const nextIndex = event.key === 'ArrowDown' ? index + 1 : index - 1
        const nextItem = visibleEntries[nextIndex]
        const next = nextItem && isVisibleTreeEntry(nextItem) ? nextItem.entry : undefined
        if (next) {
          navigateTreeTo(next.path)
        }
        return
      }
      if (event.key === 'Home' || event.key === 'End') {
        event.preventDefault()
        const edgeItem =
          event.key === 'Home' ? visibleEntries[0] : visibleEntries.at(-1)
        const next =
          edgeItem && isVisibleTreeEntry(edgeItem) ? edgeItem.entry : undefined
        if (next) {
          navigateTreeTo(next.path)
        }
        return
      }
      if (event.key === 'ArrowRight' && isDirectoryEntry(current)) {
        event.preventDefault()
        if (!expandedPaths.includes(path)) {
          toggleDirectory(path)
        } else {
          const firstChild = directories[path]?.entries[0]
          if (firstChild) {
            navigateTreeTo(firstChild.path)
          }
        }
        return
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        if (isDirectoryEntry(current) && expandedPaths.includes(path)) {
          toggleDirectory(path)
        } else {
          const parent = parentPath(path)
          if (parent) {
            navigateTreeTo(parent)
          }
        }
        return
      }
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        await selectTreePath(path)
        return
      }
      if (
        event.key.length === 1 &&
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey
      ) {
        event.preventDefault()
        typeaheadRef.current = `${typeaheadRef.current}${event.key.toLowerCase()}`
        if (typeaheadTimerRef.current) window.clearTimeout(typeaheadTimerRef.current)
        typeaheadTimerRef.current = window.setTimeout(() => {
          typeaheadRef.current = ''
        }, 750)
        const ordered = [...visibleEntries.slice(index + 1), ...visibleEntries.slice(0, index + 1)]
        const match = ordered.find(
          (item) =>
            isVisibleTreeEntry(item) &&
            item.entry.name.toLowerCase().startsWith(typeaheadRef.current)
        )
        if (match && isVisibleTreeEntry(match)) {
          navigateTreeTo(match.entry.path)
        }
      }
    },
    [directories, expandedPaths, navigateTreeTo, selectTreePath, toggleDirectory, visibleEntries]
  )

  const rootDirectory = directories['']
  const rootLoading = !rootDirectory || rootDirectory.loading
  const nestedWorkspaceMessage = useMemo(() => {
    if (!workspacePath || !rootDirectory || rootDirectory.loading || rootDirectory.error) {
      return null
    }
    return nestedWorkspaceHint(workspacePath, rootDirectory.entries)
  }, [rootDirectory, workspacePath])
  const narrowSurface = surfaceWidth > 0 && surfaceWidth < 680
  const explorerMaxWidth =
    narrowSurface || surfaceWidth <= 0
      ? FILES_EXPLORER_WIDTH_MAX
      : Math.min(FILES_EXPLORER_WIDTH_MAX, Math.max(FILES_EXPLORER_WIDTH_MIN, surfaceWidth - 248))
  const effectiveExplorerWidth = Math.min(explorerMaxWidth, explorerWidthPx)
  const explorerWidthStyle = {
    '--files-explorer-width': `${effectiveExplorerWidth}px`
  } as CSSProperties

  if (!workspacePath) {
    return (
      <div className="flex h-full items-center justify-center px-5 text-center text-caption text-muted">
        Open a workspace to browse and edit files.
      </div>
    )
  }

  return (
    <div
      ref={panelRootRef}
      className="flex h-full min-h-0 min-w-0 flex-col bg-bg"
      data-files-layout={narrowSurface ? 'stacked' : 'split'}
    >
      {promptDialog}
      {confirmDialog}
      {findInFilesOpen ? (
        <div className="flex shrink-0 flex-col gap-1.5 border-b border-border/40 bg-surface px-2 py-2">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(event) => {
              event.preventDefault()
              const q = findQuery.trim()
              if (!q || !workspacePath || !window.vyotiq?.workspaceGrep) return
              setFindBusy(true)
              setFindError(null)
              void window.vyotiq
                .workspaceGrep({ workspacePath, query: q, maxResults: 80 })
                .then((res) => {
                  if (!res.ok) {
                    setFindError(res.error)
                    setFindHits([])
                    return
                  }
                  setFindHits(res.data.hits)
                })
                .finally(() => setFindBusy(false))
            }}
          >
            <input
              ref={findInputRef}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg px-2 text-caption text-fg outline-none"
              placeholder="Find in files"
              value={findQuery}
              onChange={(event) => setFindQuery(event.target.value)}
            />
            <button type="submit" className={DOCK_TOOLBAR_BTN} disabled={findBusy}>
              {findBusy ? 'Searching…' : 'Search'}
            </button>
            <button
              type="button"
              className={DOCK_TOOLBAR_BTN}
              onClick={() => {
                setFindInFilesOpen(false)
                setFindHits([])
                setFindError(null)
              }}
            >
              Close
            </button>
          </form>
          {findError ? <p className="m-0 text-caption text-danger">{findError}</p> : null}
          {findHits.length > 0 ? (
            <ul className="m-0 max-h-40 list-none overflow-auto p-0">
              {findHits.map((hit) => (
                <li key={`${hit.path}:${hit.line}:${hit.text.slice(0, 24)}`}>
                  <button
                    type="button"
                    className="flex w-full items-baseline gap-2 truncate rounded px-1 py-0.5 text-left text-caption hover:bg-surface-2"
                    onClick={() => {
                      void openFile(hit.path).then(() => setScrollToLine(hit.line))
                    }}
                  >
                    <span className="truncate text-fg">{hit.path}</span>
                    <span className="shrink-0 text-muted">{hit.line}</span>
                    <span className="min-w-0 truncate text-muted">{hit.text.trim()}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <ContextMenu
        anchor={contextMenu?.anchor ?? null}
        items={contextMenuItems}
        onClose={closeContextMenu}
        returnFocusRef={contextReturnFocusRef}
        shouldRestoreFocus={() => active}
        aria-label="Files actions"
      />
      <ContextMenu
        anchor={editorActionsAnchor}
        items={editorActionItems}
        onClose={closeEditorActions}
        returnFocusRef={editorMenuReturnFocusRef}
        shouldRestoreFocus={() => active}
        aria-label="Editor actions"
      />
      {recoveryError ? (
        <div
          role="alert"
          className={cn(
            FILES_PANEL_ALERT,
            'border-warning/30 bg-warning/10 text-warning'
          )}
        >
          <span className="min-w-0 flex-1 truncate">
            Recovery warning: {recoveryError}
          </span>
        </div>
      ) : null}
      {error ? (
        <div
          role="alert"
          aria-live="assertive"
          className={cn(
            FILES_PANEL_ALERT,
            'border-danger/30 bg-danger/10 text-danger'
          )}
        >
          <span className="min-w-0 flex-1 truncate">{error}</span>
          <div className="flex shrink-0 items-center gap-1.5">
            {failedOpenPath && window.vyotiq?.slashCommandsOpenFile ? (
              <button
                type="button"
                className={DOCK_TOOLBAR_BTN}
                onClick={() => {
                  void window.vyotiq?.slashCommandsOpenFile({
                    workspacePath,
                    path: failedOpenPath
                  })
                }}
              >
                Open externally
              </button>
            ) : null}
            <button
              type="button"
              className={DOCK_TOOLBAR_BTN}
              onClick={() => {
                setError(null)
                setFailedOpenPath(null)
              }}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : null}
      <div className={cn('flex min-h-0 min-w-0 flex-1', narrowSurface ? 'flex-col' : 'flex-row')}>
        <div
          style={explorerWidthStyle}
          className={cn(
            'flex min-h-0 min-w-0 flex-col border-border/40',
            narrowSurface
              ? 'h-[42%] min-h-[11rem] w-full max-w-none border-b'
              : 'w-[var(--files-explorer-width)] max-w-[45%] border-r'
          )}
        >
          <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border/30 px-2 py-1" role="toolbar" aria-label="Workspace files">
            <div className="flex min-w-0 flex-1 items-center">
              <span className="min-w-0 truncate text-caption font-medium tracking-normal text-fg" title={workspacePath}>
                {workspaceName(workspacePath)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-0.5">
              <IconButton
                icon="search"
                label="Find in files"
                size="xs"
                variant="bare"
                className="text-muted"
                disabled={busy}
                onClick={() => setFindInFilesOpen(true)}
              />
              <IconButton
                icon="plus"
                label="Create file"
                size="xs"
                variant="bare"
                className="text-muted"
                disabled={busy}
                onClick={() => void createEntry('file')}
              />
              <IconButton
                icon="folderPlus"
                label="Create folder"
                size="xs"
                variant="bare"
                className="text-muted"
                disabled={busy}
                onClick={() => void createEntry('directory')}
              />
              <IconButton
                icon="refresh"
                label="Refresh files"
                size="xs"
                variant="bare"
                className="text-muted"
                disabled={busy}
                onClick={refreshTree}
              />
              <ActionMenu
                open={workspaceActionsOpen}
                onOpenChange={setWorkspaceActionsOpen}
                placement="down"
                align="end"
                aria-label="Workspace actions"
                items={workspaceActionItems}
                trigger={(props) => (
                  <IconButton
                    ref={props.ref}
                    icon="menu"
                    label="Workspace actions"
                    size="xs"
                    variant="bare"
                    className="text-muted"
                    disabled={busy}
                    aria-expanded={props['aria-expanded']}
                    aria-controls={props['aria-controls']}
                    aria-haspopup={props['aria-haspopup']}
                    onClick={props.onClick}
                  />
                )}
              />
              {dirtyTabCount > 0 ? (
                <button
                  type="button"
                  className={cn(
                    DOCK_TOOLBAR_BTN,
                    'ml-0.5 border-accent bg-accent px-1.5 text-accent-fg hover:bg-accent/90'
                  )}
                  aria-label={`Save all (${dirtyTabCount} unsaved)`}
                  title={`Save ${dirtyTabCount} unsaved tab${dirtyTabCount === 1 ? '' : 's'}`}
                  disabled={busy || !tabs.some((tab) => tab.dirty && !tab.conflict)}
                  onClick={() => void flushDirtyTabs()}
                >
                  Save
                </button>
              ) : null}
            </div>
          </div>
          {nestedWorkspaceMessage && !treeFilter.trim() ? (
            <div
              className={cn(FILES_PANEL_ALERT, 'border-border/30 bg-warning/10 text-warning')}
              role="status"
            >
              <Icon name="info" size={14} className="shrink-0" />
              <span className="min-w-0 flex-1">{nestedWorkspaceMessage}</span>
            </div>
          ) : null}
          <div className="flex min-w-0 shrink-0 items-center gap-1.5 border-b border-border/30 px-2 py-1">
            <SearchInput
              aria-label="Filter workspace files"
              className="h-7 min-h-0 min-w-0 flex-1 gap-1 rounded-md border-border/50 bg-bg px-2"
              inputClassName="min-h-0 py-0 text-caption"
              placeholder="Filter files"
              tone="quiet"
              value={treeFilter}
              onChange={(event) => setTreeFilter(event.target.value)}
              onClear={() => setTreeFilter('')}
            />
            <ActionMenu
              open={treeSortOpen}
              onOpenChange={setTreeSortOpen}
              placement="down"
              align="end"
              aria-label="Sort workspace files"
              items={treeSortItems}
              trigger={(props) => (
                <button
                  ref={props.ref}
                  type="button"
                  className={cn(DOCK_TOOLBAR_BTN, 'shrink-0 gap-1 px-1.5')}
                  aria-label="Sort workspace files"
                  aria-expanded={props['aria-expanded']}
                  aria-controls={props['aria-controls']}
                  aria-haspopup={props['aria-haspopup']}
                  title="Sort workspace files"
                  onClick={props.onClick}
                >
                  <span>{treeSort === 'name' ? 'Name' : 'Type'}</span>
                  <Icon name="chevron" size={10} className="text-muted" />
                </button>
              )}
            />
          </div>
          <div
            ref={treeScrollRef}
            className="files-panel-scroll min-h-0 flex-1 overflow-auto px-1 pb-1"
            role="region"
            aria-label="Workspace file surface"
            aria-busy={rootLoading}
            onContextMenu={(event) => openContextMenu(event, { kind: 'surface' })}
          >
            {rootLoading && visibleEntries.length === 0 ? (
              <div className="px-2 py-3 text-caption text-muted" role="status">
                Loading files…
              </div>
            ) : null}
            {directories['']?.error ? (
              <div role="alert" className="flex items-center gap-2 px-2 py-3 text-caption text-danger">
                {directories[''].error}
                <button
                  type="button"
                  className="shrink-0 text-accent hover:underline"
                  onClick={() => void loadDirectory('')}
                >
                  Retry
                </button>
              </div>
            ) : null}
            {directories['']?.truncated ? (
              <div className="px-2 py-1 text-2xs text-warning">
                Workspace root capped at {directories[''].total.toLocaleString()} entries
              </div>
            ) : null}
            {!rootLoading &&
            !directories['']?.error &&
            visibleEntries.length === 0 ? (
              <div className="px-2 py-5 text-center text-caption text-muted" role="status">
                {treeFilter ? 'No matching files.' : 'No files in this workspace.'}
              </div>
            ) : null}
            <ul
              role="tree"
              aria-label="Workspace files"
              tabIndex={0}
              className="relative m-0 list-none p-0"
              style={{ height: `${treeVirtualizer.getTotalSize()}px` }}
              onKeyDown={(event) => {
                if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                  openContextMenuFromKeyboard(event, { kind: 'surface' })
                }
              }}
            >
              {treeRows.map((virtualEntry) => {
                const visible = visibleEntries[virtualEntry.index]
                if (!visible) return null

                if (visible.kind === 'loadMore') {
                  return (
                    <li
                      key={`load-more-${visible.parentPath}`}
                      data-index={virtualEntry.index}
                      id={treeLoadMoreElementId(visible.parentPath)}
                      role="none"
                      className="absolute left-0 top-0 m-0 h-7 w-full list-none p-0"
                      style={{ transform: `translateY(${virtualEntry.start}px)` }}
                    >
                      <button
                        type="button"
                        className="flex h-full min-w-0 items-center gap-1 rounded px-1.5 text-left text-xs text-accent outline-none hover:bg-surface/60 focus-visible:vy-focus-ring"
                        style={treeIndentStyle(visible.level)}
                        onClick={() => void loadDirectory(visible.parentPath, true)}
                      >
                        <span className="w-[10px]" aria-hidden />
                        Load more ({visible.loaded.toLocaleString()}/
                        {visible.total.toLocaleString()})
                      </button>
                    </li>
                  )
                }

                const { entry, level } = visible
                const open = expandedPaths.includes(entry.path)
                const highlighted = treeHighlightPath === entry.path
                const focused = treeKeyboardPath === entry.path
                const isDir = isDirectoryEntry(entry)
                const directory = directories[entry.path]
                return (
                  <li
                    key={entry.path}
                    data-index={virtualEntry.index}
                    id={treeElementId(entry.path)}
                    role="treeitem"
                    aria-level={level}
                    aria-setsize={visibleEntries.length}
                    aria-posinset={virtualEntry.index + 1}
                    aria-expanded={isDir ? open : undefined}
                    aria-selected={highlighted || (!activeTab && focused)}
                    tabIndex={focused ? 0 : -1}
                    className="absolute left-0 top-0 m-0 h-7 w-full list-none p-0"
                    style={{ transform: `translateY(${virtualEntry.start}px)` }}
                    onContextMenu={(event) => {
                      selectContextPath(entry.path)
                      openContextMenu(event, {
                        kind: 'tree',
                        path: entry.path,
                        entryKind: entry.kind
                      })
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key === 'ContextMenu' ||
                        (event.key === 'F10' && event.shiftKey)
                      ) {
                        openContextMenuFromKeyboard(event, {
                          kind: 'tree',
                          path: entry.path,
                          entryKind: entry.kind
                        })
                        return
                      }
                      void onTreeKeyDown(event, entry.path)
                    }}
                  >
                    <button
                      type="button"
                      tabIndex={-1}
                      aria-haspopup="menu"
                      className={cn(
                        'flex h-full min-w-0 items-center gap-1 overflow-hidden rounded px-1.5 text-left text-xs outline-none hover:bg-surface/60 focus-visible:vy-focus-ring',
                        highlighted
                          ? TREE_ROW_ACTIVE_FILE
                          : focused
                            ? TREE_ROW_FOCUSED
                            : 'text-fg/80'
                      )}
                      style={treeIndentStyle(level)}
                      onClick={() => void selectTreePath(entry.path)}
                      onContextMenu={(event) => {
                        selectContextPath(entry.path)
                        openContextMenu(event, {
                          kind: 'tree',
                          path: entry.path,
                          entryKind: entry.kind
                        })
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === 'ContextMenu' ||
                          (event.key === 'F10' && event.shiftKey)
                        ) {
                          openContextMenuFromKeyboard(event, {
                            kind: 'tree',
                            path: entry.path,
                            entryKind: entry.kind
                          })
                          event.stopPropagation()
                          return
                        }
                        event.stopPropagation()
                        void onTreeKeyDown(event, entry.path)
                      }}
                    >
                      {isDir ? (
                        <Icon name={open ? 'chevron' : 'chevronRight'} size={10} className="text-muted" />
                      ) : (
                        <span className="w-[10px]" aria-hidden />
                      )}
                      <FileTypeIcon
                        path={entry.path}
                        kind={isDir ? 'folder' : 'file'}
                        open={open}
                        size={14}
                        className="shrink-0"
                      />
                      <span className="min-w-0 flex-1 truncate" title={entry.path}>
                        {entry.name}
                      </span>
                      {isDir && open && directory?.loading ? (
                        <span
                          className="flex shrink-0 items-center gap-0.5 text-2xs text-muted"
                          role="status"
                        >
                          <Icon name="loader" size={10} className="animate-spin" />
                          Loading…
                        </span>
                      ) : null}
                      {isDir && open && directory?.error ? (
                        <span className="flex shrink-0 items-center gap-0.5 text-2xs text-danger" role="alert">
                          <span className="max-w-[5rem] truncate">{directory.error}</span>
                          <span
                            role="link"
                            tabIndex={0}
                            className="cursor-pointer text-accent hover:underline"
                            onClick={(event) => {
                              event.stopPropagation()
                              void loadDirectory(entry.path)
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                event.stopPropagation()
                                void loadDirectory(entry.path)
                              }
                            }}
                          >
                            Retry
                          </span>
                        </span>
                      ) : null}
                      {isDir &&
                      open &&
                      directory &&
                      !directory.loading &&
                      !directory.error &&
                      directory.entries.length === 0 ? (
                        <span className="shrink-0 text-2xs text-muted">Empty</span>
                      ) : null}
                      {isDir && open && directory?.truncated ? (
                        <span
                          className="shrink-0 text-2xs text-warning"
                          title={`Directory capped at ${directory.total.toLocaleString()} entries`}
                        >
                          Capped
                        </span>
                      ) : null}
                      {entry.kind === 'symlink' ? (
                        <span className="text-2xs text-warning">link</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
        <PanelResizeHandle
          label="Resize Files explorer"
          value={effectiveExplorerWidth}
          min={FILES_EXPLORER_WIDTH_MIN}
          max={explorerMaxWidth}
          edge="end"
          onChange={setExplorerWidthPx}
          className={narrowSurface ? 'hidden' : undefined}
        />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {tabs.length > 0 ? (
            <div
              role="tablist"
              aria-label="Open files"
              tabIndex={-1}
              className={cn(PANEL_SUBTAB_BAR, 'sidebar-scroll-x gap-1 overflow-x-auto')}
              onKeyDown={(event) =>
                handleTabListKeyDown(event, {
                  tabs: tabs.map((tab) => tab.id),
                  activeId: activeTabId,
                  onSelect: (id) => void selectTab(id)
                })
              }
            >
              {tabs.map((tab) => {
                const selected = tab.id === activeTabId
                return (
                  <div key={tab.id} className={dockPanelTabShellClass(selected, true)}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected}
                      aria-haspopup="menu"
                      aria-controls="workspace-file-editor-panel"
                      id={tabElementId(tab.id)}
                      aria-label={`${fileName(tab.path)}${tab.dirty ? `, ${saveStateLabel(saveStates[tab.id] ?? 'pending')}` : ', Saved'}`}
                      tabIndex={selected ? 0 : -1}
                      className={dockPanelTabButtonClass(selected)}
                      onClick={() => void selectTab(tab.id)}
                      onContextMenu={(event) =>
                        openContextMenu(event, { kind: 'tab', tabId: tab.id })
                      }
                      onKeyDown={(event) =>
                        openContextMenuFromKeyboard(event, { kind: 'tab', tabId: tab.id })
                      }
                      title={tab.path}
                    >
                      <FileTypeIcon path={tab.path} size={14} className="shrink-0" />
                      {tab.dirty ? <span className="text-warning" aria-hidden>●</span> : null}
                      <span className="min-w-0 truncate">{fileName(tab.path)}</span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Close ${fileName(tab.path)}`}
                      tabIndex={selected ? 0 : -1}
                      className={dockPanelTabCloseClass(selected)}
                      onClick={() => void closeTab(tab.id)}
                      onContextMenu={(event) =>
                        openContextMenu(event, { kind: 'tab', tabId: tab.id })
                      }
                      onKeyDown={(event) => {
                        if (
                          event.key === 'ContextMenu' ||
                          (event.key === 'F10' && event.shiftKey)
                        ) {
                          openContextMenuFromKeyboard(event, { kind: 'tab', tabId: tab.id })
                          event.stopPropagation()
                          return
                        }
                        event.stopPropagation()
                      }}
                    >
                      <Icon name="close" size={10} />
                    </button>
                  </div>
                )
              })}
            </div>
          ) : null}
          {activeTab ? (
            <div
              id="workspace-file-editor-panel"
              role="tabpanel"
              aria-labelledby={tabElementId(activeTab.id)}
              tabIndex={0}
              className="flex min-h-0 min-w-0 flex-1 flex-col"
              onContextMenu={(event) =>
                openContextMenu(event, { kind: 'tab', tabId: activeTab.id })
              }
            >
              <div className="flex min-w-0 shrink-0 items-center gap-1 border-b border-border/30 px-2 py-1 text-caption text-muted">
                <EditorBreadcrumb path={activeTab.path} />
                {activeTextPosition ? (
                  <span className="shrink-0 tabular-nums text-muted">
                    Ln {activeTextPosition.line}, Col {activeTextPosition.column}
                  </span>
                ) : null}
                {activeTab.kind === 'text' ? (
                  <button
                    type="button"
                    className={cn(
                      DOCK_TOOLBAR_BTN,
                      'px-1.5',
                      wordWrap && DOCK_TOOLBAR_BTN_PRESSED
                    )}
                    aria-pressed={wordWrap}
                    aria-label="Wrap"
                    title="Toggle word wrap"
                    onClick={() => updateSession({ wordWrap: !wordWrap })}
                  >
                    Wrap
                  </button>
                ) : null}
                {activeTab.kind === 'text' ? (
                  <button
                    type="button"
                    className={cn(
                      DOCK_TOOLBAR_BTN,
                      'px-1.5',
                      showLineNumbers && DOCK_TOOLBAR_BTN_PRESSED
                    )}
                    aria-pressed={showLineNumbers}
                    aria-label="Line numbers"
                    title="Toggle line numbers"
                    onClick={() => updateSession({ showLineNumbers: !showLineNumbers })}
                  >
                    Lines
                  </button>
                ) : null}
                {previewKind ? (
                  <button
                    type="button"
                    className={cn(
                      DOCK_TOOLBAR_BTN,
                      'px-1.5',
                      previewOpen && DOCK_TOOLBAR_BTN_PRESSED
                    )}
                    aria-pressed={previewOpen}
                    aria-label={previewOpen ? 'Show source' : 'Show preview'}
                    title={previewOpen ? 'Show source' : 'Show preview'}
                    onClick={() => setPreviewOpen((open) => !open)}
                  >
                    {previewOpen ? 'Source' : 'Preview'}
                  </button>
                ) : null}
                <div className="ml-auto flex shrink-0 items-center gap-1">
                <span
                  className={cn(
                    'inline-flex shrink-0 items-center gap-1',
                    activeTab.conflict || activeSaveState === 'error'
                      ? 'text-warning'
                      : activeSaveState === 'saved'
                        ? 'text-success'
                        : 'text-muted'
                  )}
                  role="status"
                  aria-live="polite"
                  title={saveStateLabel(activeSaveState)}
                >
                  {activeSaveState === 'saved' ? <Icon name="check" size={12} /> : null}
                  <span className="hidden sm:inline">{saveStateLabel(activeSaveState)}</span>
                </span>
                {activeDirty || activeTab.conflict ? (
                  <button
                    type="button"
                    className={cn(DOCK_TOOLBAR_BTN, 'px-1.5')}
                    disabled={busy}
                    onClick={() =>
                      activeTab.conflict
                        ? void reloadTabWithConfirm(activeTab.id)
                        : void saveTab(activeTab.id)
                    }
                  >
                    {activeTab.conflict ? 'Reload' : 'Save'}
                  </button>
                ) : null}
                {activeTab.conflict ? (
                  <button
                    type="button"
                    className={cn(DOCK_TOOLBAR_BTN, 'px-1.5 text-warning')}
                    disabled={busy}
                    onClick={() => void overwriteTab(activeTab.id)}
                  >
                    Overwrite
                  </button>
                ) : null}
                <button
                  ref={editorActionsButtonRef}
                  type="button"
                  className={cn(DOCK_TOOLBAR_BTN, 'px-1.5')}
                  aria-haspopup="menu"
                  aria-expanded={editorActionsAnchor != null}
                  aria-label="Editor actions"
                  title="Editor actions"
                  disabled={integrationBusy}
                  onClick={openEditorActions}
                >
                  <Icon name="menu" size={12} />
                </button>
                </div>
              </div>
              {loadingPath === activeTab.path ? (
                <div className="flex flex-1 items-center justify-center text-caption text-muted">Loading file…</div>
              ) : editorMode === 'diff' ? (
                <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-editor-integration="diff">
                  <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-border/30 bg-bg/95 px-2 py-1 text-caption">
                    <strong className="font-medium text-fg">Diff View</strong>
                    <span className="min-w-0 flex-1 truncate text-muted">{activeTab.path}</span>
                    <button
                      type="button"
                      className={DOCK_TOOLBAR_BTN}
                      onClick={() => setEditorMode('editor')}
                    >
                      Back to editor
                    </button>
                  </div>
                  {diffLines.length > 0 ? (
                    <DiffPreview
                      lines={diffLines}
                      path={activeTab.path}
                      expanded
                      wordWrap={wordWrap}
                    />
                  ) : (
                    <p className="px-3 py-5 text-caption text-muted">No diff content is available.</p>
                  )}
                </div>
              ) : editorMode === 'blame' ? (
                <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-editor-integration="blame">
                  <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-border/30 bg-bg/95 px-2 py-1 text-caption">
                    <strong className="font-medium text-fg">Git Blame</strong>
                    <span className="min-w-0 flex-1 truncate text-muted">{activeTab.path}</span>
                    <button
                      type="button"
                      className={DOCK_TOOLBAR_BTN}
                      onClick={() => setEditorMode('editor')}
                    >
                      Back to editor
                    </button>
                  </div>
                  {blameResult?.kind === 'ok' ? (
                    <div className="min-w-max font-mono text-caption leading-5">
                      {blameResult.lines.map((line) => (
                        <div key={line.line} className="flex min-w-0 border-b border-border/15">
                          <span className="w-20 shrink-0 truncate px-2 text-muted" title={line.author}>
                            {line.shortSha ?? 'working'}
                          </span>
                          <span className="w-32 shrink-0 truncate px-2 text-muted" title={line.date}>
                            {line.author}
                          </span>
                          <span className="w-10 shrink-0 px-1 text-right tabular-nums text-muted/70">
                            {line.line}
                          </span>
                          <span className="min-w-0 whitespace-pre px-2 text-fg/85">{line.text}</span>
                        </div>
                      ))}
                      {blameResult.truncated ? (
                        <p className="px-2 py-1 text-caption text-warning">
                          Blame view capped at {blameResult.lines.length.toLocaleString()} lines.
                        </p>
                      ) : null}
                    </div>
                  ) : (
                    <p className="px-3 py-5 text-caption text-muted">
                      {blameResult?.kind === 'unavailable'
                        ? blameResult.detail
                        : blameResult?.kind === 'not_repo'
                          ? blameResult.detail
                          : 'Git blame is unavailable.'}
                    </p>
                  )}
                </div>
              ) : editorMode === 'lsp' ? (
                <div className="min-h-0 min-w-0 flex-1 overflow-auto" data-editor-integration="lsp">
                  <div className="sticky top-0 z-sticky flex items-center gap-2 border-b border-border/30 bg-bg/95 px-2 py-1 text-caption">
                    <strong className="font-medium text-fg">Language Server</strong>
                    <span className="min-w-0 flex-1 truncate text-muted">{activeTab.path}</span>
                    <button
                      type="button"
                      className={DOCK_TOOLBAR_BTN}
                      onClick={() => setEditorMode('editor')}
                    >
                      Back to editor
                    </button>
                  </div>
                  {lspStatus?.kind === 'available' ? (
                    <div className="space-y-2 px-3 py-3 text-caption">
                      <p className="m-0 text-fg">
                        {lspStatus.server.label}
                        <span className="ml-1 text-muted">
                          ({lspStatus.server.source === 'workspace' ? 'workspace' : 'PATH'})
                        </span>
                      </p>
                      <p className="m-0 text-muted">
                        {lspStatus.server.capabilities.length > 0
                          ? `Capabilities: ${lspStatus.server.capabilities.join(', ')}`
                          : 'The detected server will report capabilities when it initializes.'}
                      </p>
                      {lspResponse?.kind === 'diagnostics' ? (
                        lspResponse.items.length > 0 ? (
                          <ul className="m-0 list-none space-y-1 p-0">
                            {lspResponse.items.map((item, index) => (
                              <li
                                key={`${item.line}:${item.character}:${index}`}
                                className={cn(
                                  'rounded border px-2 py-1',
                                  item.severity === 'error'
                                    ? 'border-danger/40 text-danger'
                                    : item.severity === 'warning'
                                      ? 'border-warning/40 text-warning'
                                      : 'border-border/50 text-muted'
                                )}
                              >
                                Ln {item.line + 1}, Col {item.character + 1}: {item.message}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <p className="m-0 text-success">No diagnostics reported.</p>
                        )
                      ) : (
                        <p className="m-0 text-muted">
                          Diagnostics are requested when the server advertises support.
                        </p>
                      )}
                    </div>
                  ) : (
                    <p className="px-3 py-5 text-caption text-muted">
                      {lspStatus?.kind === 'unavailable'
                        ? lspStatus.detail
                        : 'No language server detected.'}
                    </p>
                  )}
                </div>
              ) : previewOpen && previewKind ? (
                <FilePreview
                  path={activeTab.path}
                  content={activeTab.content}
                  binary={activeTab.kind === 'binary'}
                />
              ) : activeTab.kind === 'text' ? (
                <TextCodeEditor
                  key={activeTab.id}
                  path={activeTab.path}
                  value={activeTab.content}
                  cursor={activeTab.cursor}
                  selections={activeTab.selections}
                  showLineNumbers={showLineNumbers}
                  wordWrap={wordWrap}
                  scrollTop={activeTab.scrollTop}
                  scrollToLine={scrollToLine}
                  lspDiagnostics={
                    inlineLspEnabled && inlineLsp.status?.kind === 'available'
                      ? inlineLsp.diagnostics
                      : null
                  }
                  onLspHover={inlineLspEnabled ? inlineLsp.fetchHover : undefined}
                  onInlineComplete={
                    tabAutocompleteEnabled && workspacePath
                      ? requestInlineComplete
                      : undefined
                  }
                  onScrollToLineHandled={() => setScrollToLine(null)}
                  onChange={(content) => {
                    const accepted = mutateTab(activeTab.id, (tab) => ({
                      ...tab,
                      content,
                      dirty: tab.savedContent !== content,
                      conflict: false,
                      revision: tab.revision + 1
                    }))
                    if (accepted) {
                      setTabSaveState(
                        activeTab.id,
                        content === activeTab.savedContent ? 'saved' : 'pending'
                      )
                    }
                    return accepted
                  }}
                  onMetaChange={updateTextMeta}
                  onViewChange={updateEditorView}
                />
              ) : (
                <HexEditor
                  key={activeTab.id}
                  value={activeTab.content}
                  cursor={activeTab.cursor}
                  bookmarks={activeTab.bookmarks}
                  selections={activeTab.selections}
                  template={activeTab.template}
                  scrollTop={activeTab.scrollTop}
                  onChange={(content) => {
                    if (
                      contentLimit('binary', content, activeTab) > WORKSPACE_FILE_BINARY_MAX_BYTES
                    ) {
                      setError(
                        `Binary edits cannot exceed ${Math.round(
                          WORKSPACE_FILE_BINARY_MAX_BYTES / (1024 * 1024)
                        )} MiB.`
                      )
                      return false
                    }
                    const accepted = mutateTab(activeTab.id, (tab) => ({
                      ...tab,
                      content,
                      dirty: tab.savedContent !== content,
                      conflict: false,
                      revision: tab.revision + 1
                    }))
                    if (accepted) {
                      setTabSaveState(
                        activeTab.id,
                        content === activeTab.savedContent ? 'saved' : 'pending'
                      )
                    }
                    return accepted
                  }}
                  onMetaChange={updateHexMeta}
                  onViewChange={updateEditorView}
                />
              )}
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center px-5 text-center text-caption text-muted">
              <Icon name="fileSearch" size={28} className="mb-3 text-muted/50" />
              <p>Select a file to open it in the editor.</p>
              <p className="mt-1 max-w-[18rem] text-caption text-muted/80">
                Text files open in the code editor. Images, SVG, Markdown, and HTML can preview in
                the tab. Other binary files open in the hex editor.
              </p>
            </div>
          )}
        </div>
      </div>
      <div className="flex min-h-8 shrink-0 items-center justify-between gap-3 border-t border-border/30 px-3 py-1 text-caption text-muted">
        <div className="flex min-w-0 items-center gap-1.5">
          {dirtyTabCount > 0 ? (
            <span className="text-warning" role="status">
              {dirtyTabCount} unsaved tab{dirtyTabCount === 1 ? '' : 's'}
            </span>
          ) : null}
          {savingTabCount > 0 ? (
            <span className="text-muted" role="status" aria-live="polite">
              {savingTabCount === 1 ? 'Autosaving' : `Autosaving ${savingTabCount}`}
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <span
            className={cn(autoSave ? 'text-muted' : 'text-warning')}
            title={
              autoSave
                ? 'Files save automatically after editing. Toggle in Editor actions menu.'
                : 'Files save only when you choose Save. Toggle in Editor actions menu.'
            }
          >
            {autoSave ? 'Auto Save' : 'Manual Save'}
          </span>
          {formatOnSave ? (
            <span className="hidden text-muted sm:inline">
              Format on Save{formatterStatus?.kind === 'available' ? ` · ${formatterStatus.tool}` : ''}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  )
})
