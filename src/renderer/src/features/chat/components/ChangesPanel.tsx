import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionMenu,
  Button,
  DiffStat,
  IconButton,
  Menu,
  Segmented,
  StatusGlyph,
  cn,
  type ActionMenuItem,
  type MenuOption
} from '@renderer/lib/ui'
import { isEditableShortcutTarget, matchShortcut } from '@renderer/lib/shortcuts'
import { Icon } from '@renderer/lib/icons'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { GitBranchEntry, GitChangedFile, GitLogEntry, GitStatus } from '@shared/ipc'
import { namedGitBranch } from '@shared/utils/gitBranch'
import type { UiItem } from '@shared/transcript'
import type { ChatItemsStore } from '../chatStores'
import { useChatLiveItems } from './ChatStreamLeaves'
import { EmptyPanel } from './PanelChrome'
import { type DiffLayout } from './DiffPreview'
import { useGitChrome, type GitChrome } from './GitChrome'
import { useGitInit } from './useGitInit'
import { defaultCommitMessage } from './CommitComposer'
import {
  ChangeDiff,
  ChangesList,
  type BrowserFileEntry,
  type ChangesListFile
} from '@renderer/features/inspector/ChangesList'
import {
  collectLastTurnChangedFiles,
  collectLastTurnFileDiffs,
  collectSessionChangedFiles,
  collectSessionFileDiffs,
  mergeCheckpointChangedFiles,
  normalizeRelPath,
  type CheckpointChangedFile
} from '../utils/turnFileDiffs'

type ChangeScope = 'agent' | 'uncommitted' | 'staged' | 'unstaged' | 'commits'

const SCOPE_LABEL: Record<ChangeScope, string> = {
  agent: 'This task',
  uncommitted: 'Uncommitted',
  staged: 'Staged',
  unstaged: 'Unstaged',
  commits: 'Commits'
}

function sideDelta(
  file: GitChangedFile,
  scope: ChangeScope
): { added: number; removed: number } {
  if (scope === 'staged') {
    return { added: file.addedStaged, removed: file.removedStaged }
  }
  if (scope === 'unstaged') {
    return { added: file.addedUnstaged, removed: file.removedUnstaged }
  }
  return { added: file.added, removed: file.removed }
}

/** Matches INSTANCE_BRANCH_PREFIX in src/main/git/instanceWorktree.ts. */
const INSTANCE_BRANCH_PREFIX = 'vyotiq/instance/'

function statusBadge(status: GitChangedFile['status']): string {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'New'
    case 'deleted':
      return 'Deleted'
    case 'modified':
      return 'Modified'
    case 'conflicted':
      return 'Conflict'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function statusLetter(status: GitChangedFile['status']): BrowserFileEntry['statusLetter'] {
  switch (status) {
    case 'added':
    case 'untracked':
      return 'A'
    case 'deleted':
      return 'D'
    case 'modified':
      return 'M'
    case 'conflicted':
      return 'C'
    default: {
      const _exhaustive: never = status
      return _exhaustive
    }
  }
}

function toBrowserEntry(file: GitChangedFile, scope: ChangeScope): BrowserFileEntry {
  const delta = sideDelta(file, scope === 'commits' ? 'uncommitted' : scope)
  const label = statusBadge(file.status)
  return {
    path: file.path,
    statusLetter: statusLetter(file.status),
    statusLabel: label,
    statusTone:
      file.status === 'added' || file.status === 'untracked' ? 'success' : 'muted',
    added: delta.added,
    removed: delta.removed,
    binary: file.binary,
    staged: file.staged,
    unstaged: file.unstaged
  }
}

/**
 * Signature of the only inputs the change collectors read.
 *
 * Streaming assistant text and in-flight tool-arg deltas do not change which
 * files were edited or what their diffs are, so this deliberately ignores
 * everything except a tool's identity, its settled status, and its payload
 * sizes. A settled call's `argsPreview` never changes afterwards.
 */
function changeSourceSignature(items: readonly UiItem[]): string {
  let signature = ''
  for (const item of items) {
    if (item.kind !== 'tool') continue
    const tool = item.tool
    signature += `${item.id}\u0001${tool.name}\u0001${tool.status}\u0001${tool.argsPreview?.length ?? 0}\u0001${tool.content?.length ?? 0}\u0002`
  }
  return signature
}

type ChangeData = {
  toolAgentFiles: ReturnType<typeof collectLastTurnChangedFiles>
  agentDiffs: ReturnType<typeof collectLastTurnFileDiffs>
  sessionToolAgentFiles: ReturnType<typeof collectSessionChangedFiles>
  sessionAgentDiffs: ReturnType<typeof collectSessionFileDiffs>
}

type ChangeDataCache = { current: { signature: string; data: ChangeData } | null }

/**
 * Signature-keyed cache for the four session-wide change collectors.
 *
 * Each one walks every tool item and JSON-parses its arguments to split diffs.
 * `useMemo` cannot express "recompute when this signature changes" without the
 * array-identity problem above, so the comparison is explicit here.
 */
function readChangeData(
  cache: ChangeDataCache,
  signature: string,
  items: UiItem[]
): ChangeData {
  const cached = cache.current
  if (cached && cached.signature === signature) return cached.data
  const data: ChangeData = {
    toolAgentFiles: collectLastTurnChangedFiles(items),
    agentDiffs: collectLastTurnFileDiffs(items),
    sessionToolAgentFiles: collectSessionChangedFiles(items),
    sessionAgentDiffs: collectSessionFileDiffs(items)
  }
  cache.current = { signature, data }
  return data
}

/**
 * The inspector's Changes tab: what this task changed, with Keep and Undo,
 * and git's view of the working tree, with Commit. One file list; the
 * selected file's diff below it.
 */
export const ChangesPanel = memo(function ChangesPanel({
  items,
  itemsStore,
  className,
  workspacePath,
  gitRevision = 0,
  chrome: chromeProp,
  onGitMutated,
  onOpenFile,
  onViewPr,
  writeFileResolutions,
  resolvablePaths,
  conflictedPaths,
  canResolve,
  resolveBusy,
  resolveBlockedReason,
  onKeepWriteFile,
  onDiscardWriteFile,
  onKeepAllWrites,
  onDiscardAllWrites,
  writeCheckpointFiles,
  active = true,
  running = false,
  onStopRun,
  preferredScope = 'agent',
  preferredScopeToken = 0,
  preferredSelectedPath = null,
  preferredSelectedPathToken = 0
}: {
  items: UiItem[]
  itemsStore?: ChatItemsStore
  className?: string
  workspacePath?: string | null
  gitRevision?: number
  /** Shared chrome from ChatView — avoids a second gitStatus fetch when the dock is open. */
  chrome?: GitChrome
  /** Notify parent after commits / refreshes from this panel. */
  onGitMutated?: () => void
  onOpenFile?: (path: string, options?: import('./FilesPanel').WorkspaceFileOpenOptions) => void
  onViewPr?: () => void
  writeFileResolutions?: ReadonlyMap<string, 'kept' | 'discarded' | undefined>
  resolvablePaths?: ReadonlySet<string>
  conflictedPaths?: ReadonlySet<string> | undefined
  canResolve?: boolean
  resolveBusy?: boolean
  resolveBlockedReason?: string | null
  onKeepWriteFile?: (path: string) => void | Promise<unknown>
  onDiscardWriteFile?: (path: string) => void | Promise<unknown>
  onKeepAllWrites?: () => void | Promise<unknown>
  onDiscardAllWrites?: () => void | Promise<unknown>
  /** Latest writes_checkpoint files (terminal/MCP observed writes). */
  writeCheckpointFiles?: readonly CheckpointChangedFile[]
  /** When false (hidden mounted dock), do not intercept Ctrl/Cmd+F/R. */
  active?: boolean
  /** The run is live: Commit and Keep/Undo wait for it to stop. */
  running?: boolean
  onStopRun?: () => void
  /** Scope requested by the parent (e.g. transcript Open Changes → agent). */
  preferredScope?: ChangeScope
  /** Bump to re-apply preferredScope even if the scope value is unchanged. */
  preferredScopeToken?: number
  /** File requested by the parent (e.g. transcript receipt click) — select + expand it. */
  preferredSelectedPath?: string | null
  /** Bump alongside preferredSelectedPath to re-apply the selection. */
  preferredSelectedPathToken?: number
}) {
  // Prefer parent-shared chrome; fall back for tests that mount the panel alone.
  const localChrome = useGitChrome(
    chromeProp ? null : (workspacePath ?? null),
    gitRevision,
    !chromeProp && Boolean(workspacePath) && active,
    0
  )
  const chrome = chromeProp ?? localChrome
  // Hidden mounted dock: stop the live subscription and freeze the last visible
  // snapshot so the five session-wide diff collectors never re-run per frame.
  const hidden = active === false
  const liveItems = useChatLiveItems(itemsStore, items, !hidden)
  const visibleItemsRef = useRef<UiItem[]>(liveItems)
  useEffect(() => {
    if (!hidden) visibleItemsRef.current = liveItems
  }, [hidden, liveItems])
  const sourceItems = hidden ? visibleItemsRef.current : liveItems
  // `sourceItems` is a fresh array on every streamed frame, so keying the
  // collectors on it re-ran all of them ~60×/s — each walking every tool item
  // and JSON-parsing its arguments to split diffs. Tool arguments only matter
  // once a call settles, so key on tool identity + status + payload size and
  // let the collectors hold their results across streaming frames.
  const changeCacheRef = useRef<{ signature: string; data: ChangeData } | null>(null)
  const sourceSignature = useMemo(() => changeSourceSignature(sourceItems), [sourceItems])
  const sourceItemsRef = useRef(sourceItems)
  sourceItemsRef.current = sourceItems
  const changeData = readChangeData(changeCacheRef, sourceSignature, sourceItemsRef.current)
  const { toolAgentFiles, agentDiffs, sessionToolAgentFiles, sessionAgentDiffs } = changeData
  const agentFiles = useMemo(
    () => mergeCheckpointChangedFiles(toolAgentFiles, writeCheckpointFiles),
    [toolAgentFiles, writeCheckpointFiles]
  )
  const sessionAgentFiles = useMemo(
    () => mergeCheckpointChangedFiles(sessionToolAgentFiles, writeCheckpointFiles),
    [sessionToolAgentFiles, writeCheckpointFiles]
  )
  const [scope, setScope] = useState<ChangeScope>(preferredScope)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  /** What the commit being composed will do once its message is right. */
  const [commitIntent, setCommitIntent] = useState<'commit' | 'push' | 'pr'>('commit')
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [wordWrap, setWordWrap] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [conflictSides, setConflictSides] = useState<{
    path: string
    ours: string
    theirs: string
    base: string
    working: string
  } | null>(null)
  const [workingDraft, setWorkingDraft] = useState('')
  const [composing, setComposing] = useState(false)
  const [message, setMessage] = useState('')
  const [messageGenerating, setMessageGenerating] = useState(false)
  const [generationNotice, setGenerationNotice] = useState<string | null>(null)
  const [branches, setBranches] = useState<GitBranchEntry[]>([])
  const [commits, setCommits] = useState<GitLogEntry[]>([])
  const [selectedCommit, setSelectedCommit] = useState<GitLogEntry | null>(null)
  const [commitFiles, setCommitFiles] = useState<GitChangedFile[]>([])
  const [commitsBusy, setCommitsBusy] = useState(false)
  const [commitFilesBusy, setCommitFilesBusy] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const commitInputRef = useRef<HTMLInputElement>(null)
  const commitsSeqRef = useRef(0)
  const commitFilesSeqRef = useRef(0)
  const branchesSeqRef = useRef(0)
  const messageGenerationSeqRef = useRef(0)
  const messageEditedRef = useRef(false)

  const closeMenus = useCallback(() => {
    setMenuOpen(false)
    setCommitMenuOpen(false)
  }, [])

  // A new workspace starts over on the scope the parent asks for.
  const preferredScopeRef = useRef(preferredScope)
  preferredScopeRef.current = preferredScope
  useEffect(() => {
    setScope(preferredScopeRef.current)
    setSelectedCommit(null)
    setCommitFiles([])
    setCommits([])
    setSelectedPath(null)
    setComposing(false)
    setMessage('')
    setMessageGenerating(false)
    messageGenerationSeqRef.current += 1
    messageEditedRef.current = false
    setFindOpen(false)
    setFindQuery('')
    closeMenus()
  }, [workspacePath, closeMenus])

  useEffect(() => {
    if (preferredScopeToken <= 0) return
    setScope(preferredScope)
    if (preferredScope !== 'commits') setSelectedCommit(null)
    setSelectedPath(null)
  }, [preferredScope, preferredScopeToken])

  // Runs after the scope effect above so the requested file wins over its reset.
  useEffect(() => {
    if (preferredSelectedPathToken <= 0 || !preferredSelectedPath) return
    setSelectedPath(preferredSelectedPath)
  }, [preferredSelectedPath, preferredSelectedPathToken])

  // Non-git workspaces with agent edits: prefer agent scope so we never stack
  // "Not a git repository" with an Agent edits footer.
  const displayScope: ChangeScope =
    chrome.result?.kind === 'not_repo' &&
    sessionAgentFiles.length > 0 &&
    scope !== 'agent' &&
    scope !== 'commits'
      ? 'agent'
      : scope

  useEffect(() => {
    if (displayScope === scope) return
    setScope(displayScope)
  }, [displayScope, scope])

  const refreshCommits = useCallback(async (): Promise<GitLogEntry[]> => {
    const seq = ++commitsSeqRef.current
    if (!workspacePath || !window.vyotiq?.gitLog) {
      if (seq === commitsSeqRef.current) setCommits([])
      return []
    }
    setCommitsBusy(true)
    try {
      const res = await window.vyotiq.gitLog({ workspacePath, limit: 40 })
      if (seq !== commitsSeqRef.current) return []
      if (!res.ok) {
        setCommits([])
        chrome.reportNotice(res.error, true)
        return []
      }
      setCommits(res.data)
      return res.data
    } finally {
      if (seq === commitsSeqRef.current) setCommitsBusy(false)
    }
  }, [workspacePath, chrome])

  const refreshBranches = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.gitBranches) {
      setBranches([])
      return
    }
    const seq = ++branchesSeqRef.current
    const res = await window.vyotiq.gitBranches(workspacePath)
    if (seq !== branchesSeqRef.current) return
    setBranches(res.ok ? res.data : [])
  }, [workspacePath])

  // The branch select sits in the git views; read the list when one is shown.
  const gitView = displayScope !== 'agent'
  useEffect(() => {
    if (!active || !gitView || chrome.result?.kind !== 'ok') return
    void refreshBranches()
  }, [active, gitView, chrome.result?.kind, refreshBranches, gitRevision])

  useEffect(() => {
    if (!active || displayScope !== 'commits') return
    void refreshCommits()
  }, [active, displayScope, refreshCommits, gitRevision])

  useEffect(() => {
    if (scope !== 'commits' || !selectedCommit || !workspacePath) {
      setCommitFiles([])
      setCommitFilesBusy(false)
      return
    }
    const seq = ++commitFilesSeqRef.current
    let cancelled = false
    setCommitFilesBusy(true)
    void window.vyotiq?.gitCommitFiles?.({ workspacePath, sha: selectedCommit.sha }).then((res) => {
      if (cancelled || seq !== commitFilesSeqRef.current) return
      if (!res.ok) {
        setCommitFiles([])
        chrome.reportNotice(res.error, true)
        return
      }
      setCommitFiles(res.data.files)
    }).finally(() => {
      if (!cancelled && seq === commitFilesSeqRef.current) setCommitFilesBusy(false)
    })
    return () => {
      cancelled = true
    }
  }, [scope, selectedCommit, workspacePath, chrome])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
    findInputRef.current?.select()
  }, [findOpen])

  useEffect(() => {
    if (composing) commitInputRef.current?.focus()
  }, [composing])

  useEffect(() => {
    if (!active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (isEditableShortcutTarget(e.target)) return
      if (matchShortcut(e, 'find')) {
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (matchShortcut(e, 'refresh')) {
        e.preventDefault()
        chrome.refresh()
        if (displayScope === 'commits') void refreshCommits()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [active, chrome, displayScope, refreshCommits])

  useEffect(() => {
    if (!active) return undefined
    const onCommand = (event: Event): void => {
      const id = (event as CustomEvent<{ id?: string }>).detail?.id
      if (id === 'find') setFindOpen(true)
      else if (id === 'refresh') {
        chrome.refresh()
        if (displayScope === 'commits') void refreshCommits()
      }
    }
    window.addEventListener('vyotiq:command', onCommand)
    return () => window.removeEventListener('vyotiq:command', onCommand)
  }, [active, chrome, displayScope, refreshCommits])

  const status: GitStatus | null = chrome.status
  const gitFiles = useMemo(() => status?.files ?? [], [status?.files])

  useEffect(() => {
    if (
      !workspacePath ||
      !selectedPath ||
      !gitFiles.some((file) => file.path === selectedPath && file.status === 'conflicted')
    ) {
      setConflictSides(null)
      return
    }
    let cancelled = false
    void window.vyotiq.gitConflictFile({ workspacePath, path: selectedPath }).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        chrome?.reportNotice(res.error, true)
        return
      }
      setConflictSides({ path: selectedPath, ...res.data })
      setWorkingDraft(res.data.working)
    })
    return () => {
      cancelled = true
    }
  }, [workspacePath, selectedPath, gitFiles, chrome])

  const scopeTotals = useMemo(() => {
    const sumSide = (files: GitChangedFile[], side: 'all' | 'staged' | 'unstaged') => {
      let added = 0
      let removed = 0
      for (const f of files) {
        if (side === 'staged') {
          added += f.addedStaged
          removed += f.removedStaged
        } else if (side === 'unstaged') {
          added += f.addedUnstaged
          removed += f.removedUnstaged
        } else {
          added += f.added
          removed += f.removed
        }
      }
      return { added, removed }
    }
    return {
      agent: {
        added: agentFiles.reduce((s, f) => s + (f.added ?? 0), 0),
        removed: agentFiles.reduce((s, f) => s + (f.removed ?? 0), 0)
      },
      uncommitted: sumSide(gitFiles, 'all'),
      staged: sumSide(gitFiles.filter((f) => f.staged), 'staged'),
      unstaged: sumSide(gitFiles.filter((f) => f.unstaged), 'unstaged'),
      commits: { added: 0, removed: 0 }
    }
  }, [agentFiles, gitFiles])

  const visibleGitFiles = useMemo(() => {
    switch (displayScope) {
      case 'agent':
        return []
      case 'commits':
        return commitFiles
      case 'staged':
        return gitFiles.filter((f) => f.staged)
      case 'unstaged':
        return gitFiles.filter((f) => f.unstaged)
      case 'uncommitted':
        return gitFiles
      default: {
        const _exhaustive: never = displayScope
        return _exhaustive
      }
    }
  }, [gitFiles, displayScope, commitFiles])

  const filteredFiles = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return visibleGitFiles
    return visibleGitFiles.filter((f) => f.path.toLowerCase().includes(q))
  }, [visibleGitFiles, findQuery])

  const browserFiles = useMemo(
    () => filteredFiles.map((f) => toBrowserEntry(f, displayScope)),
    [filteredFiles, displayScope]
  )

  const taskFiles = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    return q ? sessionAgentFiles.filter((f) => f.path.toLowerCase().includes(q)) : sessionAgentFiles
  }, [sessionAgentFiles, findQuery])

  const totals = useMemo(() => {
    if (displayScope === 'agent') {
      return {
        files: taskFiles.length,
        added: taskFiles.reduce((s, f) => s + (f.added ?? 0), 0),
        removed: taskFiles.reduce((s, f) => s + (f.removed ?? 0), 0)
      }
    }
    if (displayScope === 'staged' || displayScope === 'unstaged' || displayScope === 'uncommitted') {
      let added = 0
      let removed = 0
      for (const f of filteredFiles) {
        const d = sideDelta(f, displayScope)
        added += d.added
        removed += d.removed
      }
      return { files: filteredFiles.length, added, removed }
    }
    return {
      files: filteredFiles.length,
      added: filteredFiles.reduce((s, f) => s + f.added, 0),
      removed: filteredFiles.reduce((s, f) => s + f.removed, 0)
    }
  }, [displayScope, taskFiles, filteredFiles])

  const commitMode: 'all' | 'staged' = scope === 'staged' ? 'staged' : 'all'

  const sendCommit = useCallback(
    (push: boolean) => {
      void chrome.commit(message, push, commitMode).then(async (ok) => {
        if (!ok) return
        setMessage('')
        setMessageGenerating(false)
        messageGenerationSeqRef.current += 1
        messageEditedRef.current = false
        setComposing(false)
        onGitMutated?.()
        setScope('commits')
        setSelectedCommit(null)
        setSelectedPath(null)
        const list = await refreshCommits()
        setSelectedCommit(list[0] ?? null)
      })
    },
    [chrome, message, commitMode, onGitMutated, refreshCommits]
  )

  const sendCreatePr = useCallback(() => {
    void chrome.createPr(message, commitMode, true).then(async (ok) => {
      if (!ok) return
      setMessage('')
      setMessageGenerating(false)
      messageGenerationSeqRef.current += 1
      messageEditedRef.current = false
      setComposing(false)
      onGitMutated?.()
      setScope('commits')
      setSelectedCommit(null)
      setSelectedPath(null)
      const list = await refreshCommits()
      setSelectedCommit(list[0] ?? null)
      onViewPr?.()
    })
  }, [chrome, message, commitMode, onGitMutated, onViewPr, refreshCommits])

  // `git init`, offered only where git itself says there is no repository.
  // Never automatic: this runs from the empty-state button and nowhere else.
  const onRepoCreated = useCallback(() => {
    chrome.refresh()
    void refreshCommits()
    onGitMutated?.()
  }, [chrome, onGitMutated, refreshCommits])
  const gitInit = useGitInit(workspacePath, onRepoCreated)

  const sendStageAll = useCallback(() => {
    void chrome.stageAll().then((ok) => {
      if (!ok) return
      onGitMutated?.()
    })
  }, [chrome, onGitMutated])

  const onMessageChange = useCallback((value: string) => {
    messageEditedRef.current = true
    setMessage(value)
  }, [])

  const cancelCompose = useCallback(() => {
    messageGenerationSeqRef.current += 1
    messageEditedRef.current = false
    setMessageGenerating(false)
    setComposing(false)
  }, [])

  const openCompose = useCallback((intent: 'commit' | 'push' | 'pr' = 'commit') => {
    const fallback = defaultCommitMessage(visibleGitFiles, visibleGitFiles.length)
    const sequence = ++messageGenerationSeqRef.current
    messageEditedRef.current = false
    setCommitIntent(intent)
    setMessage(workspacePath ? '' : fallback)
    setComposing(true)
    setMessageGenerating(false)
    setGenerationNotice(null)

    if (!workspacePath) return
    setMessageGenerating(true)
    void window.vyotiq
      .gitGenerateCommitMessage({ workspacePath, mode: commitMode })
      .then((result) => {
        if (sequence !== messageGenerationSeqRef.current || messageEditedRef.current) return
        if (result.ok && result.data.source === 'agent' && result.data.message) {
          setMessage(result.data.message)
          setGenerationNotice(null)
        } else {
          setMessage(fallback)
          setGenerationNotice(
            result.ok ? (result.data.reason ?? 'Generation failed') : 'Generation failed'
          )
        }
      })
      .catch(() => {
        if (sequence !== messageGenerationSeqRef.current || messageEditedRef.current) return
        setMessage(fallback)
        setGenerationNotice('Generation failed')
      })
      .finally(() => {
        if (sequence !== messageGenerationSeqRef.current) return
        setMessageGenerating(false)
      })
  }, [commitMode, visibleGitFiles, workspacePath])

  const checkoutBranch = useCallback(
    async (branch: string) => {
      if (!workspacePath || !window.vyotiq?.gitCheckout) return
      if (status && status.fileCount > 0) {
        const confirmed = window.confirm(
          `Working tree has uncommitted changes. Git will refuse to check out "${branch}" if those files would be overwritten.`
        )
        if (!confirmed) return
      }
      closeMenus()
      const res = await window.vyotiq.gitCheckout(workspacePath, branch)
      if (res.ok) {
        chrome.refresh()
        onGitMutated?.()
        void refreshCommits()
      } else {
        chrome.reportNotice(res.error, true)
      }
    },
    [workspacePath, status, closeMenus, chrome, onGitMutated, refreshCommits]
  )

  const fileDiffStaged = useCallback(
    (file: GitChangedFile): boolean => {
      if (scope === 'staged') return true
      if (scope === 'unstaged') return false
      if (scope === 'uncommitted') return file.unstaged ? false : Boolean(file.staged)
      return false
    },
    [scope]
  )

  const filteredFilesRef = useRef(filteredFiles)
  filteredFilesRef.current = filteredFiles
  const fileDiffStagedRef = useRef(fileDiffStaged)
  fileDiffStagedRef.current = fileDiffStaged

  const empty =
    displayScope === 'agent'
      ? sessionAgentFiles.length === 0
      : displayScope === 'commits'
        ? false
        : filteredFiles.length === 0 && !chrome.busy

  const emptyTitle = !workspacePath
    ? 'No workspace'
    : chrome.error
      ? 'Git status unavailable'
      : chrome.result?.kind === 'unavailable'
        ? 'Git not found'
        : displayScope === 'agent'
          ? 'No changes yet'
          : chrome.result?.kind === 'not_repo'
            ? 'Not a git repository'
            : 'No changes yet'

  const emptyBody = !workspacePath
    ? 'Open a workspace to view git changes and resolve agent edits.'
    : chrome.error
      ? chrome.error
      : chrome.result?.kind === 'unavailable'
        ? chrome.result.detail
        : displayScope === 'agent'
          ? 'Edits the agent makes land here as it makes them.'
          : chrome.result?.kind === 'not_repo'
            ? 'Changes, PRs and undo points need git. Initialize one here — nothing else changes.'
            : 'Working tree changes will appear here when files differ from HEAD.'

  const commitsEmptyTitle =
    chrome.result?.kind === 'not_repo' ? 'Not a git repository' : 'No commits yet'
  const commitsEmptyBody =
    chrome.result?.kind === 'not_repo'
      ? 'This workspace has no .git directory. Git history cannot be listed.'
      : chrome.result?.kind === 'unavailable'
        ? chrome.result.detail
        : 'Commits on this branch will appear here after the first git commit.'

  const gitInitAction =
    workspacePath && chrome.result?.kind === 'not_repo' ? (
      <span className="flex flex-col items-center gap-1.5">
        <Button size="sm"
          variant="primary"
          disabled={gitInit.busy}
          onClick={() => void gitInit.init()}
        >
          {gitInit.busy ? 'Initializing…' : 'Initialize repository'}
        </Button>
        {gitInit.error ? (
          <span className="max-w-[16rem] text-xs text-danger" role="alert">
            {gitInit.error}
          </span>
        ) : null}
      </span>
    ) : null

  const showGitEmpty =
    empty &&
    (displayScope === 'agent' ||
      !workspacePath ||
      chrome.error != null ||
      chrome.result?.kind === 'unavailable' ||
      chrome.result?.kind === 'not_repo' ||
      chrome.result?.kind === 'ok')

  const commitPrimaryPushes = Boolean(status?.hasRemote)
  const commitSha = displayScope === 'commits' ? selectedCommit?.sha ?? null : null

  const stageActions =
    displayScope === 'commits' || displayScope === 'agent'
      ? undefined
      : {
          busy: chrome.busy || Boolean(resolveBusy),
          onStage: (path: string) => {
            void chrome.stagePaths([path]).then((ok) => {
              if (ok) onGitMutated?.()
            })
          },
          onUnstage: (path: string) => {
            void chrome.unstagePaths([path]).then((ok) => {
              if (ok) onGitMutated?.()
            })
          },
          canStage: (file: BrowserFileEntry) => Boolean(file.unstaged),
          canUnstage: (file: BrowserFileEntry) => Boolean(file.staged)
        }

  const fetchGitDiff = useCallback(
    async (path: string) => {
      if (!workspacePath) return { error: 'No workspace' }
      void gitRevision
      const file = filteredFilesRef.current.find((f) => f.path === path)
      const staged = file ? fileDiffStagedRef.current(file) : false
      const vsHead = displayScope === 'uncommitted' && !commitSha
      const res = await window.vyotiq.gitDiff({
        workspacePath,
        path,
        staged: commitSha ? undefined : staged,
        ignoreWhitespace,
        sha: commitSha ?? undefined,
        ...(vsHead ? { vsHead: true } : {})
      })
      if (!res.ok) return { error: res.error }
      return { content: res.data.content }
    },
    [workspacePath, ignoreWhitespace, commitSha, gitRevision, displayScope]
  )

  const repoOk = chrome.result?.kind === 'ok'
  const resolutionOf = (path: string): 'kept' | 'discarded' | undefined =>
    writeFileResolutions?.get(normalizeRelPath(path)) ?? writeFileResolutions?.get(path)
  const conflictedOf = (path: string): boolean =>
    Boolean(conflictedPaths?.has(normalizeRelPath(path)) || conflictedPaths?.has(path))
  const normalizedResolvable = resolvablePaths
    ? new Set(Array.from(resolvablePaths, (path) => normalizeRelPath(path)))
    : null
  const resolvableOf = (path: string): boolean =>
    !resolvablePaths || resolvablePaths.has(path) || Boolean(normalizedResolvable?.has(normalizeRelPath(path)))
  // What Keep all / Undo all act on: the latest write checkpoint's files, not
  // yet kept or undone.
  const unresolvedTask = canResolve
    ? sessionAgentFiles.filter((f) => resolvableOf(f.path) && !resolutionOf(f.path))
    : []
  const resolveLocked = Boolean(resolveBusy || chrome.busy || resolveBlockedReason)

  const listFiles: ChangesListFile[] =
    displayScope === 'agent'
      ? taskFiles.map((f) => {
          const resolution = resolutionOf(f.path)
          const note: Pick<ChangesListFile, 'note' | 'noteTone'> = conflictedOf(f.path)
            ? { note: 'Edited since', noteTone: 'warning' }
            : resolution === 'kept'
              ? { note: 'Kept' }
              : resolution === 'discarded'
                ? { note: 'Undone' }
                : {}
          return {
            path: f.path,
            status: f.action === 'created' ? 'A' : f.action === 'deleted' ? 'D' : 'M',
            added: f.added ?? 0,
            removed: f.removed ?? 0,
            ...note
          }
        })
      : browserFiles.map((f) => ({ path: f.path, status: f.statusLetter, added: f.added, removed: f.removed }))

  const selectedIndex = selectedPath ? listFiles.findIndex((f) => f.path === selectedPath) : -1
  const selected = selectedIndex >= 0 ? listFiles[selectedIndex]! : null
  const selectByOffset = (offset: number): (() => void) | undefined => {
    const next = listFiles[selectedIndex + offset]
    return next ? () => setSelectedPath(next.path) : undefined
  }

  const taskDiffLines = selected && displayScope === 'agent'
    ? (sessionAgentDiffs.get(normalizeRelPath(selected.path)) ?? sessionAgentDiffs.get(selected.path) ?? null)
    : null
  // A file the run changed with a command has no edit to show; git's view of
  // it against HEAD is the change.
  const fetchTaskFallback = useCallback(
    async (path: string) => {
      if (!workspacePath) return { error: 'No workspace' }
      const res = await window.vyotiq.gitDiff({ workspacePath, path, vsHead: true })
      return res.ok ? { content: res.data.content } : { error: res.error }
    },
    [workspacePath]
  )

  const rowActions = (file: ChangesListFile) => {
    const name = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path
    const open =
      onOpenFile && file.status !== 'D' ? (
        <IconButton icon="external" label={`Open ${name}`} size="xs" tone="muted" onClick={() => onOpenFile(file.path)} />
      ) : null
    if (displayScope === 'agent') {
      const decidable = canResolve && resolvableOf(file.path) && !resolutionOf(file.path) && !conflictedOf(file.path)
      return (
        <>
          {decidable && onDiscardWriteFile ? (
            <IconButton
              icon="undo"
              label={`Undo ${name}`}
              title={resolveBlockedReason ?? 'Restore this file to its state before the agent wrote it'}
              size="xs"
              tone="muted"
              disabled={resolveLocked}
              onClick={() => void onDiscardWriteFile(file.path)}
            />
          ) : null}
          {decidable && onKeepWriteFile ? (
            <IconButton
              icon="check"
              label={`Keep ${name}`}
              title={resolveBlockedReason ?? 'Keep this file as the agent wrote it'}
              size="xs"
              tone="muted"
              disabled={resolveLocked}
              onClick={() => void onKeepWriteFile(file.path)}
            />
          ) : null}
          {open}
        </>
      )
    }
    const entry = browserFiles.find((f) => f.path === file.path)
    return (
      <>
        {entry && stageActions?.canStage(entry) ? (
          <IconButton
            icon="plus"
            label={`Stage ${file.path}`}
            size="xs"
            tone="muted"
            disabled={stageActions.busy}
            onClick={() => stageActions.onStage(file.path)}
          />
        ) : null}
        {entry && stageActions?.canUnstage(entry) ? (
          <IconButton
            icon="minus"
            label={`Unstage ${file.path}`}
            size="xs"
            tone="muted"
            disabled={stageActions.busy}
            onClick={() => stageActions.onUnstage(file.path)}
          />
        ) : null}
        {open}
      </>
    )
  }

  const resolveConflict = (path: string, pick: (sides: { ours: string; theirs: string }) => string): void => {
    if (!workspacePath) return
    const apply = (content: string): void => {
      void window.vyotiq.gitResolveConflict({ workspacePath, path, content }).then((resolved) => {
        if (!resolved.ok) {
          chrome.reportNotice(resolved.error, true)
          return
        }
        chrome.refresh()
        onGitMutated?.()
      })
    }
    if (conflictSides?.path === path) {
      apply(pick(conflictSides))
      return
    }
    void window.vyotiq.gitConflictFile({ workspacePath, path }).then((res) => {
      if (!res.ok) {
        chrome.reportNotice(res.error, true)
        return
      }
      apply(pick(res.data))
    })
  }

  const selectedConflicted =
    Boolean(workspacePath && selected) &&
    displayScope !== 'agent' &&
    gitFiles.some((file) => file.path === selected!.path && file.status === 'conflicted')

  const conflictBlock =
    selectedConflicted && selected ? (
      <div className="shrink-0 space-y-2 border-b border-border bg-warning-soft px-3 py-2 text-xs" data-changes-conflict>
        <div className="flex flex-wrap items-center gap-1.5">
          <Icon name="warning" size={13} className="shrink-0 text-warning" />
          <span className="min-w-0 flex-1 truncate text-fg">Both sides changed this file</span>
          <Button size="xs" onClick={() => resolveConflict(selected.path, (sides) => sides.ours)}>
            Keep ours
          </Button>
          <Button size="xs" onClick={() => resolveConflict(selected.path, (sides) => sides.theirs)}>
            Keep theirs
          </Button>
          <Button size="xs" onClick={() => resolveConflict(selected.path, () => workingDraft)}>
            Save working
          </Button>
        </div>
        {conflictSides?.path === selected.path ? (
          <div className="grid max-h-56 grid-cols-1 gap-1 overflow-auto md:grid-cols-3">
            {(['ours', 'theirs', 'base'] as const).map((side) => (
              <pre
                key={side}
                className="m-0 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-bg p-1.5 font-mono text-2xs text-fg"
              >
                <span className="block font-sans text-caption font-medium text-muted">
                  {side === 'ours' ? 'Ours' : side === 'theirs' ? 'Theirs' : 'Base'}
                </span>
                {conflictSides[side] || '∅'}
              </pre>
            ))}
          </div>
        ) : null}
        <label className="m-0 block text-muted">
          Working copy
          <textarea
            className="mt-1 max-h-36 min-h-[4.5rem] w-full rounded-md border border-border bg-bg px-1.5 py-1 font-mono text-2xs text-fg focus-visible:vy-focus-ring"
            value={workingDraft}
            onChange={(e) => setWorkingDraft(e.target.value)}
          />
        </label>
      </div>
    ) : null

  const fileArea = (
    <div className="flex min-h-0 flex-1 flex-col">
      <ChangesList
        files={listFiles}
        selectedPath={selected?.path ?? null}
        onSelect={setSelectedPath}
        actions={rowActions}
        className={cn(
          'scroll-thin shrink-0 overflow-y-auto',
          selected ? 'max-h-[210px] border-b border-border' : 'min-h-0 flex-1'
        )}
      />
      {selected ? (
        <ChangeDiff
          path={selected.path}
          lines={taskDiffLines}
          fetchDiff={displayScope === 'agent' ? (repoOk ? fetchTaskFallback : undefined) : fetchGitDiff}
          binary={browserFiles.find((f) => f.path === selected.path)?.binary}
          layout={layout}
          wordWrap={wordWrap}
          findQuery={findQuery}
          onOpen={onOpenFile && selected.status !== 'D' ? () => onOpenFile(selected.path) : undefined}
          onPrev={selectByOffset(-1)}
          onNext={selectByOffset(1)}
        >
          {conflictBlock}
        </ChangeDiff>
      ) : null}
    </div>
  )

  const scopeOptions: MenuOption[] = (Object.keys(SCOPE_LABEL) as ChangeScope[]).map((key) => ({
    value: key,
    label: SCOPE_LABEL[key]
  }))
  const currentBranch = namedGitBranch(status?.branch)
  const branchOptions: MenuOption[] = (() => {
    const list: MenuOption[] = branches.map((b) => ({
      value: b.name,
      label: b.name,
      ...(b.name.startsWith(INSTANCE_BRANCH_PREFIX) ? { group: 'Instance worktrees' } : {})
    }))
    if (currentBranch && !list.some((o) => o.value === currentBranch)) list.unshift({ value: currentBranch, label: currentBranch })
    return list
  })()

  const moreItems: ActionMenuItem[] = [
    { id: 'wrap', label: 'Word wrap', checked: wordWrap, onSelect: () => setWordWrap((v) => !v) },
    ...(displayScope !== 'agent'
      ? [{ id: 'whitespace', label: 'Ignore whitespace', checked: ignoreWhitespace, onSelect: () => setIgnoreWhitespace((v) => !v) }]
      : []),
    { id: 'find', label: 'Find in changes', icon: 'search', separatorBefore: true, onSelect: () => setFindOpen(true) },
    {
      id: 'refresh',
      label: 'Refresh',
      icon: 'refresh',
      onSelect: () => {
        chrome.refresh()
        void refreshCommits()
      }
    },
    ...(displayScope === 'unstaged' && status && visibleGitFiles.length > 0
      ? [{ id: 'stage-all', label: 'Stage all', icon: 'plus' as const, separatorBefore: true, onSelect: sendStageAll }]
      : []),
    ...(onViewPr ? [{ id: 'pr', label: 'View pull request', icon: 'pullRequest' as const, separatorBefore: true, onSelect: onViewPr }] : [])
  ]

  const canCommit =
    repoOk &&
    displayScope !== 'commits' &&
    (commitMode === 'staged' ? gitFiles.some((f) => f.staged) : gitFiles.length > 0)
  const pendingTask = unresolvedTask.length > 0 && Boolean(onKeepAllWrites || onDiscardAllWrites)
  const showFooter = Boolean(workspacePath) && (pendingTask || canCommit || composing)
  const commitLabel =
    commitIntent === 'push' ? 'Commit & Push' : commitIntent === 'pr' ? 'Commit & Create PR' : 'Commit'
  const commitBusy = chrome.busy || Boolean(resolveBusy) || messageGenerating
  const showCounts = Boolean(workspacePath) && listFiles.length > 0 && !(displayScope === 'commits' && !selectedCommit)

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-changes-panel
      role="region"
      aria-label="Changes"
    >
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2" data-changes-toolbar>
        <Menu
          value={displayScope}
          options={scopeOptions}
          onChange={(value) => {
            const key = value as ChangeScope
            setScope(key)
            if (key !== 'commits') setSelectedCommit(null)
            setSelectedPath(null)
          }}
          aria-label="Change scope"
          placement="down"
          bare
          quiet={displayScope === 'agent'}
          className="shrink-0"
        />
        {gitView && repoOk && currentBranch ? (
          <Menu
            value={currentBranch}
            options={branchOptions}
            onChange={(name) => {
              if (name !== currentBranch) void checkoutBranch(name)
            }}
            aria-label="Switch branch"
            placement="down"
            searchable={branchOptions.length > 8}
            searchPlaceholder="Find a branch"
            bare
            quiet
            mono
            icon="branch"
            className="min-w-0 shrink"
          />
        ) : null}
        {showCounts ? (
          <>
            <span className="shrink-0 text-xs text-muted">
              {listFiles.length} {listFiles.length === 1 ? 'file' : 'files'}
            </span>
            <DiffStat add={totals.added} del={totals.removed} className="shrink-0" />
          </>
        ) : null}
        <span className="flex-1" />
        <Segmented
          label="Diff layout"
          value={layout}
          onChange={setLayout}
          items={[
            { id: 'unified', icon: 'rows', title: 'Unified' },
            { id: 'split', icon: 'columns', title: 'Split' }
          ]}
        />
        <ActionMenu
          open={menuOpen}
          onOpenChange={setMenuOpen}
          placement="down"
          align="end"
          aria-label="More changes actions"
          items={moreItems}
          trigger={(t) => (
            <IconButton
              ref={t.ref}
              icon="more"
              label="More changes actions"
              title="More — wrap, whitespace, find"
              size="sm"
              tone="muted"
              aria-expanded={t['aria-expanded']}
              aria-controls={t['aria-controls']}
              aria-haspopup={t['aria-haspopup']}
              onClick={t.onClick}
            />
          )}
        />
      </div>

      {findOpen ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2 text-xs">
          <Icon name="search" size={13} className="shrink-0 text-muted" />
          <input
            ref={findInputRef}
            type="text"
            role="searchbox"
            value={findQuery}
            onChange={(e) => setFindQuery(e.target.value)}
            placeholder="Find in changes"
            aria-label="Find in changes"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-tertiary"
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                e.stopPropagation()
                setFindOpen(false)
                setFindQuery('')
              }
            }}
          />
          <IconButton
            icon="close"
            label="Close find"
            size="sm"
            tone="muted"
            onClick={() => {
              setFindOpen(false)
              setFindQuery('')
            }}
          />
        </div>
      ) : null}

      {chrome.notice ? (
        <p
          className={cn(
            'm-0 shrink-0 border-b border-border px-3 py-1.5 text-xs',
            chrome.noticeFailed ? 'text-danger' : 'text-secondary'
          )}
          role={chrome.noticeFailed ? 'alert' : 'status'}
        >
          {chrome.notice}
        </p>
      ) : null}

      {status?.truncated && displayScope !== 'agent' && displayScope !== 'commits' ? (
        <p className="m-0 shrink-0 border-b border-border px-3 py-1.5 text-xs text-muted">
          Showing first {status.files.length} of {status.fileCount} changed files
        </p>
      ) : null}

      {displayScope === 'commits' && selectedCommit ? (
        <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-1 pr-3 text-xs">
          <IconButton
            icon="arrowLeft"
            label="Back to commits"
            size="xs"
            tone="muted"
            onClick={() => {
              setSelectedCommit(null)
              setSelectedPath(null)
            }}
          />
          <span className="shrink-0 font-mono text-caption text-tertiary">{selectedCommit.shortSha}</span>
          <span className="min-w-0 flex-1 truncate text-fg">{selectedCommit.subject}</span>
        </div>
      ) : null}

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {!workspacePath ? (
          <EmptyPanel icon="diff" title={emptyTitle} body={emptyBody} centered />
        ) : displayScope === 'agent' ? (
          sessionAgentFiles.length === 0 ? (
            chrome.result?.kind === 'not_repo' ? (
              // Nothing to review and no git to review it with: say which.
              <EmptyPanel
                icon="branch"
                title="Not a git repository"
                body="Changes, PRs and undo points need git. Initialize one here — nothing else changes."
                actions={gitInitAction}
                centered
              />
            ) : (
              <EmptyPanel
                icon="diff"
                title={emptyTitle}
                body={emptyBody}
                centered
                actions={
                  repoOk ? (
                    <Button size="sm" onClick={() => setScope('uncommitted')}>
                      Show uncommitted instead
                    </Button>
                  ) : null
                }
              />
            )
          ) : (
            fileArea
          )
        ) : displayScope === 'commits' && !selectedCommit ? (
          commitsBusy && commits.length === 0 ? (
            <EmptyPanel icon="gitCommit" title="Loading commits…" body="Reading git history for this branch." centered />
          ) : commits.length === 0 ? (
            <EmptyPanel icon="gitCommit" title={commitsEmptyTitle} body={commitsEmptyBody} actions={gitInitAction} centered />
          ) : (
            <ul className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto py-1" aria-label="Commits">
              {commits.map((c) => (
                <li key={c.sha}>
                  <button
                    type="button"
                    className="flex w-full min-w-0 flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-surface focus-visible:vy-focus-ring"
                    onClick={() => {
                      setSelectedCommit(c)
                      setSelectedPath(null)
                    }}
                  >
                    <span className="flex min-w-0 items-center gap-2 text-xs">
                      <span className="shrink-0 font-mono text-caption text-tertiary">{c.shortSha}</span>
                      <span className="min-w-0 truncate text-fg">{c.subject}</span>
                    </span>
                    <span className="text-caption text-tertiary">
                      {c.author} · {c.relativeDate}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : displayScope !== 'commits' && chrome.loading && !chrome.ready ? (
          <EmptyPanel icon="diff" title="Loading changes…" body="Reading git status for this workspace." centered />
        ) : displayScope === 'commits' && commitFilesBusy && browserFiles.length === 0 ? (
          <EmptyPanel icon="gitCommit" title="Loading commit…" body="Reading files changed in this commit." centered />
        ) : displayScope === 'commits' && browserFiles.length === 0 ? (
          <EmptyPanel icon="gitCommit" title="No files in this commit" body="This commit has no file changes to preview." centered />
        ) : showGitEmpty ? (
          <EmptyPanel
            icon={chrome.result?.kind === 'not_repo' ? 'branch' : 'diff'}
            title={emptyTitle}
            body={emptyBody}
            actions={gitInitAction}
            centered
          />
        ) : (
          fileArea
        )}
      </div>

      {showFooter ? (
        <div className="shrink-0 border-t border-border p-3" data-changes-footer>
          {running ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <StatusGlyph state="paused" size={13} />
              <span className="min-w-0 flex-1">Commit and Keep/Undo unlock when the run stops.</span>
              {onStopRun ? (
                <Button size="xs" variant="ghost" onClick={onStopRun}>
                  Stop run
                </Button>
              ) : null}
            </div>
          ) : composing ? (
            <div className="space-y-2.5">
              <input
                ref={commitInputRef}
                type="text"
                value={message}
                className="w-full rounded-sm bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-tertiary focus-visible:vy-focus-ring"
                placeholder={messageGenerating ? 'The agent is writing a commit message…' : 'Commit message'}
                aria-label="Commit message"
                title="Commit message, written by the agent — edit it here"
                onChange={(e) => onMessageChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && message.trim() && !commitBusy) {
                    e.preventDefault()
                    if (commitIntent === 'pr') sendCreatePr()
                    else sendCommit(commitIntent === 'push')
                  }
                  if (e.key === 'Escape') {
                    // Esc here cancels the commit only — never the running agent.
                    e.preventDefault()
                    e.stopPropagation()
                    cancelCompose()
                  }
                }}
              />
              {generationNotice ? (
                <p className="m-0 truncate text-caption text-muted" title={generationNotice} aria-live="polite">
                  No agent message: {generationNotice} — a plain one is in its place
                </p>
              ) : null}
              <div className="flex items-center gap-1.5">
                <Button size="sm" variant="ghost" onClick={cancelCompose}>
                  Cancel
                </Button>
                <span className="flex-1" />
                <Button
                  size="sm"
                  variant="primary"
                  disabled={commitBusy || !message.trim()}
                  onClick={() => {
                    if (commitIntent === 'pr') sendCreatePr()
                    else sendCommit(commitIntent === 'push')
                  }}
                >
                  {commitLabel}
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              {pendingTask && onDiscardAllWrites ? (
                <Button
                  size="sm"
                  variant="ghost"
                  icon="undo"
                  disabled={resolveLocked}
                  title="Restore every listed file to its state before the agent ran"
                  onClick={() => void onDiscardAllWrites()}
                >
                  Undo all
                </Button>
              ) : null}
              <span className="flex-1" />
              {pendingTask && onKeepAllWrites ? (
                <Button
                  size="sm"
                  disabled={resolveLocked}
                  title="Keep every listed file as the agent wrote it"
                  onClick={() => void onKeepAllWrites()}
                >
                  Keep all
                </Button>
              ) : null}
              {canCommit ? (
                <ActionMenu
                  open={commitMenuOpen}
                  onOpenChange={setCommitMenuOpen}
                  placement="up"
                  align="end"
                  aria-label="Commit"
                  items={[
                    { id: 'commit', label: 'Commit…', icon: 'gitCommit', onSelect: () => openCompose('commit') },
                    ...(status?.hasRemote
                      ? [
                          { id: 'push', label: 'Commit & Push…', icon: 'arrowUp' as const, onSelect: () => openCompose('push') },
                          { id: 'pr', label: 'Commit & Create PR…', icon: 'pullRequest' as const, onSelect: () => openCompose('pr') }
                        ]
                      : [])
                  ]}
                  trigger={(t) => (
                    <Button
                      ref={t.ref}
                      size="sm"
                      variant="primary"
                      trailingIcon="chevron"
                      disabled={chrome.busy || Boolean(resolveBusy)}
                      aria-expanded={t['aria-expanded']}
                      aria-controls={t['aria-controls']}
                      aria-haspopup={t['aria-haspopup']}
                      onClick={t.onClick}
                    >
                      Commit
                    </Button>
                  )}
                />
              ) : null}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
})
