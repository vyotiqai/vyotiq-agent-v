import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionMenu,
  Button,
  Checkbox,
  DiffStat,
  IconButton,
  Menu,
  ProgressBar,
  Segmented,
  StatusGlyph,
  cn,
  type ActionMenuItem,
  type MenuOption
} from '@renderer/lib/ui'
import { isEditableShortcutTarget, matchShortcut } from '@renderer/lib/shortcuts'
import { Icon } from '@renderer/lib/icons'
import { CHAT_RIGHT_PANEL_BODY } from '@renderer/lib/utils/layout'
import type { GitBranchEntry, GitChangedFile, GitLogEntry, GitStatus, TaskFileStat } from '@shared/ipc'
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
  FileDiffBody,
  useFileDiff,
  type BrowserFileEntry,
  type ChangesListFile,
  type FileDiffSource
} from '@renderer/features/inspector/ChangesList'
import type { AskTarget } from '@renderer/features/inspector/ReviewDiffTable'
import { lineLabel } from '@renderer/features/inspector/reviewDiff'
import { reviewSignature, useReviewViewed } from '@renderer/features/inspector/reviewViewed'
import { sessionEditTotals, settledWriteCount } from '@renderer/features/inspector/taskCounts'
import { FileBadge } from './FileBadge'
import {
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
  sessionToolAgentFiles: ReturnType<typeof collectSessionChangedFiles>
  sessionAgentDiffs: ReturnType<typeof collectSessionFileDiffs>
  /** The record's own per-file counts, for when the checkpoints cannot be asked. */
  sessionEditTotals: ReturnType<typeof sessionEditTotals>
}

type ChangeDataCache = { current: { signature: string; data: ChangeData } | null }

/**
 * Signature-keyed cache for the session-wide change collectors.
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
    sessionToolAgentFiles: collectSessionChangedFiles(items),
    sessionAgentDiffs: collectSessionFileDiffs(items),
    sessionEditTotals: sessionEditTotals(items)
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
  preferredSelectedPathToken = 0,
  runId = null,
  variant = 'panel',
  reviewTitle = 'Review',
  onReviewBack,
  onAskAboutLine
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
  /** The task whose writes This task lists; its checkpoints give the counts and diffs. */
  runId?: string | null
  /** `review`: the inspector taken to the whole work area. */
  variant?: 'panel' | 'review'
  /** The review's heading: the task's name. */
  reviewTitle?: string
  onReviewBack?: () => void
  /** Asking about a line sends this instruction to the agent as a follow-up. */
  onAskAboutLine?: (instruction: string) => void
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
  const { sessionToolAgentFiles, sessionAgentDiffs, sessionEditTotals: editTotals } = changeData
  const sessionAgentFiles = useMemo(
    () => mergeCheckpointChangedFiles(sessionToolAgentFiles, writeCheckpointFiles),
    [sessionToolAgentFiles, writeCheckpointFiles]
  )

  // This task's counts: each file's first before-image against the file now,
  // exact or absent — the numbers the navigator shows and Keep/Undo act on.
  // Asked again when a write settles, git moves, or a file is kept or undone.
  const settledWrites = useMemo(() => settledWriteCount(sourceItems), [sourceItems])
  const statsKey = workspacePath && runId ? `${workspacePath}\u0000${runId}` : null
  const [taskStats, setTaskStats] = useState<{ key: string; files: Map<string, TaskFileStat> } | null>(null)
  useEffect(() => {
    if (!active || !statsKey || !workspacePath || !runId || !window.vyotiq?.taskFileStats) return undefined
    let cancelled = false
    void window.vyotiq.taskFileStats({ workspacePath, runId }).then((res) => {
      if (cancelled || !res.ok) return
      setTaskStats({ key: statsKey, files: new Map(res.data.files.map((f) => [normalizeRelPath(f.path), f])) })
    })
    return () => {
      cancelled = true
    }
  }, [active, statsKey, workspacePath, runId, gitRevision, settledWrites, writeFileResolutions])
  const liveStats = taskStats && taskStats.key === statsKey ? taskStats.files : null
  const [scope, setScope] = useState<ChangeScope>(preferredScope)
  const [menuOpen, setMenuOpen] = useState(false)
  const [commitMenuOpen, setCommitMenuOpen] = useState(false)
  /** What the commit being composed will do once its message is right. */
  const [commitIntent, setCommitIntent] = useState<'commit' | 'push' | 'pr'>('commit')
  const [layout, setLayout] = useState<DiffLayout>('unified')
  /** The review reads side by side by default; the narrow tab reads top to bottom. */
  const [reviewLayout, setReviewLayout] = useState<DiffLayout>('split')
  const [reviewMenuOpen, setReviewMenuOpen] = useState(false)
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  // Long lines run on and scroll, as in the mockup; Word wrap is in the menu.
  const [wordWrap, setWordWrap] = useState(false)
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
    setReviewMenuOpen(false)
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

  // git's numbers for its scopes; This task's are summed from its rows, which
  // come from the task's checkpoints.
  const gitTotals = useMemo(() => {
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
  }, [displayScope, filteredFiles])

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
            ? 'Uncommitted changes, commits and PRs need git. Initialize one here — nothing else changes.'
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
          const key = normalizeRelPath(f.path)
          const stat = liveStats?.get(key)
          const action = stat?.action ?? f.action
          const exact = liveStats
            ? stat?.add != null && stat.del != null
              ? { added: stat.add, removed: stat.del }
              : {}
            : editTotals.get(key)
              ? { added: editTotals.get(key)!.add, removed: editTotals.get(key)!.del }
              : {}
          return {
            path: f.path,
            status: action === 'created' ? 'A' : action === 'deleted' ? 'D' : 'M',
            ...exact,
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

  // Without a run to ask, the edit's own arguments are all there is to show.
  const taskDiffLines = selected && displayScope === 'agent' && !runId
    ? (sessionAgentDiffs.get(normalizeRelPath(selected.path)) ?? sessionAgentDiffs.get(selected.path) ?? null)
    : null
  // The task's own record of the file: its first before-image against the file
  // now. A file the run changed some other way (a command) is not in it; git's
  // view against HEAD is the next best answer.
  const fetchTaskDiff = useCallback<FileDiffSource>(
    async (path) => {
      if (!workspacePath) return { error: 'No workspace' }
      void gitRevision
      if (runId && window.vyotiq?.taskFileDiff) {
        const res = await window.vyotiq.taskFileDiff({ workspacePath, runId, path })
        if (res.ok) {
          const d = res.data
          if (d.diff) return { content: d.diff }
          if (d.reason === 'binary_or_large') return { error: 'Binary or too large to diff' }
          if (d.reason === 'unrestorable') return { error: 'A folder delete — no copy was kept to compare with' }
          if (d.reason !== 'not_in_task') return { content: '', note: 'Nothing left to review — it is back as it was' }
        }
      }
      if (chrome.result?.kind !== 'ok') return { error: 'No diff to show' }
      const res = await window.vyotiq.gitDiff({ workspacePath, path, vsHead: true })
      return res.ok ? { content: res.data.content } : { error: res.error }
    },
    [workspacePath, runId, gitRevision, chrome.result?.kind]
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
          fetchDiff={displayScope === 'agent' ? fetchTaskDiff : fetchGitDiff}
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
  // One file without numbers leaves the total without numbers too.
  const shownTotals =
    displayScope === 'agent'
      ? listFiles.every((f) => f.added != null && f.removed != null)
        ? {
            added: listFiles.reduce((sum, f) => sum + (f.added ?? 0), 0),
            removed: listFiles.reduce((sum, f) => sum + (f.removed ?? 0), 0)
          }
        : null
      : { added: gitTotals.added, removed: gitTotals.removed }

  // ── Review: the inspector taken to the whole work area ──────────────────
  const reviewing = variant === 'review'
  const viewedKey = workspacePath
    ? `${workspacePath}::${runId ?? ''}::${displayScope}${commitSha ? `:${commitSha}` : ''}`
    : null
  const viewed = useReviewViewed(viewedKey)
  const isViewed = (file: ChangesListFile): boolean => viewed.isViewed(file.path, reviewSignature(file))
  const viewedCount = listFiles.filter(isViewed).length
  const firstUnviewed = listFiles.find((f) => !isViewed(f))?.path ?? listFiles[0]?.path ?? null
  useEffect(() => {
    // The review opens on something to read: the first file not yet viewed.
    if (!reviewing || selectedPath || !firstUnviewed) return
    setSelectedPath(firstUnviewed)
  }, [reviewing, selectedPath, firstUnviewed])
  const reviewSource = !reviewing || !selected ? undefined : displayScope === 'agent' ? fetchTaskDiff : fetchGitDiff
  const reviewDiff = useFileDiff(
    selected?.path ?? '',
    reviewing ? taskDiffLines : null,
    reviewSource,
    browserFiles.find((f) => f.path === selected?.path)?.binary
  )
  const askAboutLine =
    onAskAboutLine && displayScope !== 'commits'
      ? (target: AskTarget, question: string) => {
          const n = lineLabel(target.line)
          const where =
            target.line.kind === 'del' ? `line ${n} as it was before the change (removed)` : `line ${n}`
          onAskAboutLine(
            [`In \`${target.path}\`, ${where}:`, '```', target.line.text, '```', '', question].join('\n')
          )
        }
      : undefined

  if (reviewing) {
    const name = selected ? (selected.path.split('/').pop() ?? selected.path) : ''
    const dir = selected && selected.path.includes('/') ? selected.path.slice(0, selected.path.lastIndexOf('/') + 1) : ''
    const decidableSelected =
      selected &&
      displayScope === 'agent' &&
      canResolve &&
      resolvableOf(selected.path) &&
      !resolutionOf(selected.path) &&
      !conflictedOf(selected.path)
    const reviewMoreItems: ActionMenuItem[] = [
      ...(Object.keys(SCOPE_LABEL) as ChangeScope[]).map((key) => ({
        id: `scope-${key}`,
        label: SCOPE_LABEL[key],
        checked: displayScope === key,
        onSelect: () => {
          setScope(key)
          if (key !== 'commits') setSelectedCommit(null)
          setSelectedPath(null)
        }
      })),
      { id: 'wrap', label: 'Word wrap', checked: wordWrap, separatorBefore: true, onSelect: () => setWordWrap((v) => !v) },
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
      ...(selected && onOpenFile && selected.status !== 'D'
        ? [{ id: 'open', label: `Open ${name}`, icon: 'external' as const, onSelect: () => onOpenFile(selected.path) }]
        : []),
      ...(pendingTask && !resolveLocked && !running && onKeepAllWrites
        ? [{ id: 'keep-all', label: 'Keep all', icon: 'check' as const, separatorBefore: true, onSelect: () => void onKeepAllWrites() }]
        : []),
      ...(pendingTask && !resolveLocked && !running && onDiscardAllWrites
        ? [{ id: 'undo-all', label: 'Undo all', icon: 'undo' as const, onSelect: () => void onDiscardAllWrites() }]
        : []),
      ...(displayScope === 'unstaged' && status && visibleGitFiles.length > 0
        ? [{ id: 'stage-all', label: 'Stage all', icon: 'plus' as const, separatorBefore: true, onSelect: sendStageAll }]
        : []),
      ...(onViewPr ? [{ id: 'pr', label: 'View pull request', icon: 'pullRequest' as const, separatorBefore: true, onSelect: onViewPr }] : [])
    ]

    return (
      <div
        className={cn('flex min-h-0 min-w-0 flex-1 flex-col bg-bg', className)}
        data-changes-panel
        data-review
        role="region"
        aria-label="Review"
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2" data-review-header>
          <IconButton
            icon="arrowLeft"
            label="Back to the record"
            size="md"
            onClick={onReviewBack}
            data-review-back
          />
          <h2 className="min-w-0 truncate text-sm font-semibold text-fg-strong">{reviewTitle}</h2>
          <span className="flex-1" />
          <Segmented
            label="Diff layout"
            value={reviewLayout}
            onChange={setReviewLayout}
            items={[
              { id: 'unified', icon: 'rows', title: 'Unified' },
              { id: 'split', icon: 'columns', title: 'Split' }
            ]}
          />
          <ActionMenu
            open={reviewMenuOpen}
            onOpenChange={setReviewMenuOpen}
            placement="down"
            align="end"
            aria-label="Scope, wrap, whitespace, undo all"
            items={reviewMoreItems}
            trigger={(t) => (
              <IconButton
                ref={t.ref}
                icon="more"
                label="Scope, wrap, whitespace, undo all"
                size="md"
                tone="muted"
                aria-expanded={t['aria-expanded']}
                aria-controls={t['aria-controls']}
                aria-haspopup={t['aria-haspopup']}
                onClick={t.onClick}
              />
            )}
          />
          {canCommit && !composing ? (
            <ActionMenu
              open={commitMenuOpen}
              onOpenChange={setCommitMenuOpen}
              placement="down"
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
                  size="xs"
                  variant="primary"
                  trailingIcon="chevron"
                  disabled={running || chrome.busy || Boolean(resolveBusy)}
                  title={running ? 'Commit unlocks when the run stops' : undefined}
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

        {composing ? (
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2" data-review-compose>
            <input
              ref={commitInputRef}
              type="text"
              value={message}
              className="min-w-0 flex-1 bg-transparent font-mono text-xs text-fg outline-none placeholder:font-sans placeholder:text-tertiary"
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
                  e.preventDefault()
                  e.stopPropagation()
                  cancelCompose()
                }
              }}
            />
            {generationNotice ? (
              <span className="max-w-[40%] truncate text-caption text-muted" title={generationNotice} aria-live="polite">
                No agent message: {generationNotice}
              </span>
            ) : null}
            <Button size="xs" variant="ghost" onClick={cancelCompose}>
              Cancel
            </Button>
            <Button
              size="xs"
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
        ) : null}

        {running && (pendingTask || canCommit) ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs text-muted">
            <StatusGlyph state="paused" size={13} />
            <span className="min-w-0 flex-1">Commit and Keep/Undo unlock when the run stops.</span>
            {onStopRun ? (
              <Button size="xs" variant="ghost" onClick={onStopRun}>
                Stop run
              </Button>
            ) : null}
          </div>
        ) : null}

        {findOpen ? (
          <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs">
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
              'm-0 shrink-0 border-b border-border px-4 py-1.5 text-xs',
              chrome.noticeFailed ? 'text-danger' : 'text-secondary'
            )}
            role={chrome.noticeFailed ? 'alert' : 'status'}
          >
            {chrome.notice}
          </p>
        ) : null}

        <div className="flex min-h-0 flex-1">
          <aside className="flex w-[300px] shrink-0 flex-col border-r border-border" aria-label="Files to review">
            {displayScope === 'commits' && !selectedCommit ? (
              commits.length === 0 ? (
                <p className="m-0 px-3 py-2 text-xs text-muted">{commitsBusy ? 'Loading commits…' : commitsEmptyTitle}</p>
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
            ) : (
              <>
                {displayScope === 'commits' && selectedCommit ? (
                  <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-1 pr-3 text-xs">
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
                <div className="flex h-9 shrink-0 items-center gap-2 px-3 text-xs" data-review-progress>
                  <span className="text-muted">
                    <span className="font-medium text-fg">{viewedCount}</span> of {listFiles.length} viewed
                  </span>
                  <span className="flex-1" />
                  {shownTotals && listFiles.length > 0 ? (
                    <DiffStat add={shownTotals.added} del={shownTotals.removed} />
                  ) : null}
                </div>
                <ProgressBar value={viewedCount} max={Math.max(1, listFiles.length)} flush label="Files viewed" />
                <ul className="scroll-thin m-0 min-h-0 flex-1 list-none overflow-y-auto pb-2" aria-label="Changed files">
                  {listFiles.map((file) => {
                    const fileName = file.path.split('/').pop() ?? file.path
                    const on = file.path === selected?.path
                    const seen = isViewed(file)
                    return (
                      <li
                        key={file.path}
                        className={cn('flex h-8 items-center gap-2 px-3', on ? 'bg-surface-2' : 'hover:bg-surface')}
                        title={file.path}
                        data-review-row={file.path}
                      >
                        <Checkbox
                          checked={seen}
                          aria-label={`Viewed ${fileName}`}
                          onCheckedChange={(next) => viewed.setViewed(file.path, reviewSignature(file), next)}
                        />
                        <button
                          type="button"
                          aria-current={on || undefined}
                          className="flex h-full min-w-0 flex-1 items-center gap-2 text-left focus-visible:vy-focus-ring"
                          onClick={() => setSelectedPath(file.path)}
                        >
                          <FileBadge path={file.path} size={14} />
                          <span
                            className={cn(
                              'min-w-0 flex-1 truncate text-xs',
                              file.status === 'D' ? 'text-muted line-through' : seen ? 'text-muted' : 'text-fg'
                            )}
                          >
                            {fileName}
                          </span>
                        </button>
                        {file.note ? (
                          <span className={cn('shrink-0 text-caption', file.noteTone === 'warning' ? 'text-warning' : 'text-tertiary')}>
                            {file.note}
                          </span>
                        ) : file.added != null && file.removed != null ? (
                          <DiffStat add={file.added} del={file.removed} />
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              </>
            )}
          </aside>

          <div className="flex min-w-0 flex-1 flex-col">
            {selected ? (
              <>
                <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4 text-xs" data-review-file>
                  <FileBadge path={selected.path} size={14} />
                  <span className="min-w-0 flex-1 truncate font-mono text-caption text-muted" title={selected.path}>
                    {dir}
                    <span className="text-fg">{name}</span>
                  </span>
                  {selected.added != null && selected.removed != null ? (
                    <DiffStat add={selected.added} del={selected.removed} />
                  ) : null}
                  {decidableSelected && onDiscardWriteFile ? (
                    <IconButton
                      icon="undo"
                      label="Undo this file"
                      title={resolveBlockedReason ?? 'Put this file back as it was before the agent wrote it'}
                      size="sm"
                      tone="muted"
                      disabled={resolveLocked}
                      onClick={() => void onDiscardWriteFile(selected.path)}
                    />
                  ) : null}
                  <Checkbox
                    checked={isViewed(selected)}
                    label="Viewed"
                    onCheckedChange={(next) => viewed.setViewed(selected.path, reviewSignature(selected), next)}
                  />
                </div>
                {conflictBlock}
                <div
                  className="scroll-thin min-h-0 flex-1 overflow-auto bg-sunken py-1 font-mono text-xs leading-[20px]"
                  data-diff-scroll-root
                >
                  <FileDiffBody
                    path={selected.path}
                    diff={reviewDiff}
                    layout={reviewLayout}
                    wordWrap={wordWrap}
                    findQuery={findQuery}
                    numbers="both"
                    onAsk={askAboutLine}
                  />
                </div>
              </>
            ) : (
              <EmptyPanel
                icon="diff"
                title={listFiles.length === 0 ? emptyTitle : 'Pick a file'}
                body={listFiles.length === 0 ? emptyBody : 'Its diff opens here.'}
                centered
              />
            )}
          </div>
        </div>
      </div>
    )
  }

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
            {shownTotals ? <DiffStat add={shownTotals.added} del={shownTotals.removed} className="shrink-0" /> : null}
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
                body="Uncommitted changes, commits and PRs need git. Initialize one here — nothing else changes."
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
