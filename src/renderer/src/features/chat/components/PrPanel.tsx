import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ActionMenu,
  Badge,
  Button,
  IconButton,
  Segmented,
  StatusGlyph,
  Tabs,
  Textarea,
  cn,
  type ActionMenuItem,
  type BadgeTone,
  type TaskState
} from '@renderer/lib/ui'
import { isEditableShortcutTarget, matchShortcut } from '@renderer/lib/shortcuts'
import { Icon } from '@renderer/lib/icons'
import { copyText } from '@renderer/lib/markdown/copyText'
import { MarkdownContent } from '@renderer/lib/ui'
import { CHAT_RIGHT_PANEL_BODY, SECTION_LABEL } from '@renderer/lib/utils/layout'
import { formatElapsed } from '@shared/utils/timeFormat'
import type { GithubAuthStatus, PrCheck, PrFile, PrMergeMethod, PrReview, PrView } from '@shared/ipc'
import { EmptyPanel } from './PanelChrome'
import { GithubAuthPanel } from './GithubAuthPanel'
import { type DiffLayout } from './DiffPreview'
import {
  ChangeDiff,
  ChangesList,
  type BrowserFileEntry,
  type ChangesListFile
} from '@renderer/features/inspector/ChangesList'
import type { WorkspaceFileOpenOptions } from './FilesPanel'

type PrTab = 'changes' | 'description' | 'commits' | 'checks' | 'reviews' | 'issues'

function formatPrState(state: string): string {
  const lower = state.trim().toLowerCase()
  if (!lower) return state
  return lower.charAt(0).toUpperCase() + lower.slice(1)
}

function prEmptyTitle(error: string | null): string {
  if (!error) return 'No pull request'
  if (/GitHub CLI \(gh\) is not installed|gh is not installed|not on PATH/i.test(error)) {
    return 'GitHub CLI not found'
  }
  if (/not a git repository/i.test(error)) return 'Not a git repository'
  if (/no git remote|no remotes|no default remote|unable to determine base repository|could not determine base repository/i.test(error)) {
    return 'GitHub repository not configured'
  }
  if (/no initial commit/i.test(error)) return 'No commits yet'
  if (/auth|login|HTTP 401|HTTP 403/i.test(error)) return 'GitHub authentication required'
  if (/no pull request|no open pull request/i.test(error)) return 'No pull request'
  return 'Pull request unavailable'
}

function prEmptyBody(error: string | null): string {
  if (!error) return 'Commit and push, then open one — or let the agent do both.'
  if (/not a git repository/i.test(error)) {
    return 'Open a workspace that contains a Git repository to use pull requests.'
  }
  if (/no git remote|no remotes|no default remote|unable to determine base repository|could not determine base repository/i.test(error)) {
    return 'Agent V will connect the matching GitHub repository or create a private one when you create a pull request.'
  }
  if (/no initial commit/i.test(error)) {
    return 'Commit changes first, then create a pull request. An empty git history cannot be published.'
  }
  if (/auth|login|HTTP 401|HTTP 403/i.test(error)) {
    return 'Connect GitHub, then refresh the pull request panel.'
  }
  return error
}

function viewedStorageKey(workspacePath: string, prNumber: number): string {
  return `vyotiq.prViewed:${workspacePath}:${prNumber}`
}

/** How often to re-ask gh while a check is in flight. */
const PR_CHECKS_POLL_MS = 15_000
/** Give up watching one head commit after this long. */
const PR_CHECKS_POLL_MAX_MS = 30 * 60_000

function loadViewed(workspacePath: string, prNumber: number): Set<string> {
  try {
    const raw = localStorage.getItem(viewedStorageKey(workspacePath, prNumber))
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((p): p is string => typeof p === 'string'))
  } catch {
    return new Set()
  }
}

function saveViewed(workspacePath: string, prNumber: number, viewed: Set<string>): void {
  try {
    localStorage.setItem(
      viewedStorageKey(workspacePath, prNumber),
      JSON.stringify([...viewed])
    )
  } catch {
    /* ignore */
  }
}

function changeBadge(changeType: PrFile['changeType']): string | null {
  switch (changeType) {
    case 'ADDED':
      return 'New'
    case 'DELETED':
      return 'Deleted'
    case 'RENAMED':
      return 'Renamed'
    case 'COPIED':
      return 'Copied'
    case 'MODIFIED':
    case 'CHANGED':
    case 'UNKNOWN':
      return null
    default: {
      const _exhaustive: never = changeType
      return _exhaustive
    }
  }
}

function prStatusLetter(changeType: PrFile['changeType']): BrowserFileEntry['statusLetter'] {
  switch (changeType) {
    case 'ADDED':
      return 'A'
    case 'DELETED':
      return 'D'
    case 'RENAMED':
      return 'R'
    case 'COPIED':
      return 'C'
    case 'MODIFIED':
    case 'CHANGED':
    case 'UNKNOWN':
      return 'M'
    default: {
      const _exhaustive: never = changeType
      return _exhaustive
    }
  }
}

function toPrBrowserEntry(file: PrFile): BrowserFileEntry {
  const label = changeBadge(file.changeType)
  return {
    path: file.path,
    statusLetter: prStatusLetter(file.changeType),
    statusLabel: label,
    statusTone: label === 'New' ? 'success' : 'muted',
    added: file.additions,
    removed: file.deletions
  }
}

function needsGithubConnect(error: string | null, auth: GithubAuthStatus | null): boolean {
  if (auth?.ghAuthenticated && !auth.pending) return false
  if (auth?.pending) return true
  if (auth?.error) return true
  if (auth?.ghAvailable && !auth.ghAuthenticated) return true
  if (
    error &&
    /auth|login|HTTP 401|HTTP 403|to get started|not logged into any github/i.test(error)
  ) {
    return true
  }
  return false
}

/** Ignore stale status snapshots that would drop an in-flight Connect GitHub flow. */
function mergeAuthStatus(
  prev: GithubAuthStatus | null,
  incoming: GithubAuthStatus
): GithubAuthStatus {
  if (
    prev?.pending &&
    !incoming.pending &&
    !incoming.ghAuthenticated &&
    !incoming.error
  ) {
    return prev
  }
  return incoming
}

function needsGhInstall(error: string | null, auth: GithubAuthStatus | null): boolean {
  if (auth && !auth.ghAvailable) return true
  if (error && /GitHub CLI \(gh\) is not installed|gh is not installed|not on PATH/i.test(error)) {
    return true
  }
  return false
}

function checksLabel(pr: PrView): string {
  const total = pr.checks.length
  if (total === 0) return 'Checks'
  const passed = checksPassedCount(pr)
  return `Checks ${passed}/${total}`
}

/**
 * States GitHub reports while a check has not finished.
 *
 * The rollup mixes two node shapes: a CheckRun reports its status here
 * (QUEUED / IN_PROGRESS) with a null conclusion, while a StatusContext reports
 * PENDING / EXPECTED and never carries one. Anything else — including a value
 * this list does not know — counts as settled, so a malformed rollup can never
 * keep the poller alive indefinitely.
 */
const PENDING_CHECK_STATES = new Set([
  'QUEUED',
  'IN_PROGRESS',
  'PENDING',
  'WAITING',
  'REQUESTED',
  'EXPECTED'
])

/** Checks still running: a finished run always reports some conclusion. */
export function checksPendingCount(pr: PrView): number {
  return pr.checks.filter((c) => {
    if ((c.conclusion ?? '').trim()) return false
    return PENDING_CHECK_STATES.has(c.state.trim().toUpperCase())
  }).length
}

/** Count checks that actually passed — not bare COMPLETED without a success conclusion. */
export function checksPassedCount(pr: PrView): number {
  return pr.checks.filter((c) => {
    const conclusion = (c.conclusion ?? '').toUpperCase()
    if (conclusion === 'SUCCESS' || conclusion === 'PASSED') return true
    if (c.conclusion == null || c.conclusion === '') {
      const state = c.state.toUpperCase()
      return state === 'SUCCESS' || state === 'PASSED'
    }
    return false
  }).length
}

function prStateTone(pr: PrView): BadgeTone {
  const s = pr.state.trim().toUpperCase()
  if (s === 'MERGED') return 'accent'
  if (s === 'CLOSED') return 'danger'
  if (pr.isDraft || s === 'DRAFT') return 'neutral'
  if (s === 'OPEN') return 'success'
  return 'neutral'
}

const FAILED_CONCLUSIONS = new Set(['FAILURE', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])
const QUEUED_CHECK_STATES = new Set(['QUEUED', 'WAITING', 'REQUESTED', 'EXPECTED', 'PENDING'])

/** One check in the task vocabulary: shape first, then colour, then its word. */
export function checkState(check: PrCheck): { glyph: TaskState; word: string } {
  const conclusion = (check.conclusion ?? '').trim().toUpperCase()
  const state = check.state.trim().toUpperCase()
  if (conclusion === 'SUCCESS' || (!conclusion && (state === 'SUCCESS' || state === 'PASSED'))) {
    return { glyph: 'review', word: 'passed' }
  }
  if (FAILED_CONCLUSIONS.has(conclusion) || (!conclusion && (state === 'FAILURE' || state === 'ERROR'))) {
    return { glyph: 'failed', word: 'failed' }
  }
  if (conclusion === 'CANCELLED') return { glyph: 'stopped', word: 'cancelled' }
  if (conclusion) return { glyph: 'done', word: conclusion.toLowerCase().replace(/_/g, ' ') }
  if (state === 'IN_PROGRESS') return { glyph: 'running', word: 'running' }
  if (QUEUED_CHECK_STATES.has(state)) return { glyph: 'queued', word: 'queued' }
  return { glyph: 'done', word: state.toLowerCase().replace(/_/g, ' ') }
}

/** How long a check ran, or has been running — only from times GitHub gave. */
function checkDuration(check: PrCheck, now: number): string {
  const started = check.startedAt ? Date.parse(check.startedAt) : Number.NaN
  // GitHub reports year 1 for a check that has not started.
  if (!Number.isFinite(started) || started <= Date.UTC(2000, 0, 1)) return ''
  const ended = check.completedAt ? Date.parse(check.completedAt) : Number.NaN
  const end = Number.isFinite(ended) && ended >= started ? ended : now
  return formatElapsed(Math.max(0, end - started))
}

/**
 * What stands between the pull request and a merge, from GitHub's own state:
 * the checks it reports and its mergeability.
 */
export function mergeSummary(pr: PrView): string {
  const failing = pr.checks.filter((c) => checkState(c).glyph === 'failed').length
  const running = checksPendingCount(pr)
  const parts: string[] = []
  if (failing > 0) parts.push(`${failing} check${failing === 1 ? '' : 's'} failing`)
  if (running > 0) parts.push(`${running} still running`)
  const checks = parts.length ? `${parts.join(' and ')}.` : ''
  // Older builds of gh report no merge state; the view says less, not wrong.
  const status = (pr.mergeStateStatus ?? '').trim().toUpperCase()
  const verdict = pr.isDraft
    ? 'It is a draft — mark it ready for review to merge.'
    : status === 'BLOCKED'
      ? 'Branch protection blocks the merge.'
      : status === 'DIRTY'
        ? `The branch conflicts with ${pr.baseRefName}.`
        : status === 'BEHIND'
          ? `The branch is behind ${pr.baseRefName}.`
          : status === 'CLEAN' || status === 'HAS_HOOKS'
            ? 'Ready to merge.'
            : status === 'UNSTABLE'
              ? 'Mergeable, with checks that are not required failing.'
              : ''
  return [checks, verdict].filter(Boolean).join(' ')
}

const MERGE_LABEL: Record<PrMergeMethod, string> = {
  squash: 'Squash and merge',
  merge: 'Create a merge commit',
  rebase: 'Rebase and merge'
}

function prMergeAllowed(pr: PrView): boolean {
  if (pr.isDraft) return false
  const s = pr.state.trim().toUpperCase()
  return s !== 'CLOSED' && s !== 'MERGED'
}

function reviewsLabel(pr: PrView): string {
  const n = pr.latestReviews.length || pr.reviews.length
  return n > 0 ? `Reviews ${n}` : 'Reviews'
}

function ReviewCard({ review }: { review: PrReview }) {
  const state = review.state.trim().toUpperCase()
  const tone: BadgeTone = state === 'APPROVED' ? 'success' : state === 'CHANGES_REQUESTED' ? 'danger' : 'outline'
  return (
    <li className="py-2 text-xs">
      <div className="flex items-center gap-2">
        <span className="font-medium text-fg">{review.author}</span>
        <Badge tone={tone}>{state.toLowerCase().replace(/_/g, ' ')}</Badge>
        {review.submittedAt ? (
          <span className="ml-auto truncate text-caption text-tertiary">
            {new Date(review.submittedAt).toLocaleString()}
          </span>
        ) : null}
      </div>
      {review.body.trim() ? (
        <div className="mt-1.5">
          <MarkdownContent content={review.body} tone="secondary" className="text-xs" />
        </div>
      ) : (
        <p className="m-0 mt-1 text-tertiary">No review comment.</p>
      )}
    </li>
  )
}

/**
 * Docked PR panel backed by GitHub CLI (`gh`).
 */
export function PrPanel({
  workspacePath,
  className,
  onPrMeta,
  onUnlink,
  active = true,
  gitRevision = 0,
  onOpenFile,
  onHandToAgent
}: {
  workspacePath?: string | null
  className?: string
  onPrMeta?: (meta: { number: number; title: string } | null) => void
  onUnlink?: () => void
  /** When false (hidden mounted dock), do not intercept Ctrl/Cmd+F/R. */
  active?: boolean
  /** Same clock as Changes — reloads PR metadata after git-mutating activity. */
  gitRevision?: number
  onOpenFile?: (path: string, options?: WorkspaceFileOpenOptions) => void
  /** Give the task an instruction — used for a failing check. */
  onHandToAgent?: (instruction: string) => void
}) {
  const [pr, setPr] = useState<PrView | null>(null)
  const [loading, setLoading] = useState(false)
  const loadSeqRef = useRef(0)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<PrTab>('checks')
  const [menuOpen, setMenuOpen] = useState(false)
  const [mergeOpen, setMergeOpen] = useState(false)
  const [readyBusy, setReadyBusy] = useState(false)
  const [mergeBusy, setMergeBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [noticeFailed, setNoticeFailed] = useState(false)
  const [layout, setLayout] = useState<DiffLayout>('unified')
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false)
  const [wordWrap, setWordWrap] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [viewed, setViewed] = useState<Set<string>>(() => new Set())
  const [editingTitle, setEditingTitle] = useState(false)
  const [titleDraft, setTitleDraft] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [auth, setAuth] = useState<GithubAuthStatus | null>(null)
  const [authBusy, setAuthBusy] = useState(false)
  const [ghInstallBusy, setGhInstallBusy] = useState(false)
  const [createBusy, setCreateBusy] = useState(false)
  const [reviewEvent, setReviewEvent] = useState<'approve' | 'request-changes' | 'comment'>('comment')
  const [reviewBody, setReviewBody] = useState('')
  const [reviewBusy, setReviewBusy] = useState(false)
  const [issues, setIssues] = useState<Array<{ number: number; title: string; url: string; state: string }>>([])
  const [issuesBusy, setIssuesBusy] = useState(false)
  const [issueTitle, setIssueTitle] = useState('')
  const [issueBody, setIssueBody] = useState('')
  const [issueCreateBusy, setIssueCreateBusy] = useState(false)
  const findInputRef = useRef<HTMLInputElement>(null)
  const titleInputRef = useRef<HTMLInputElement>(null)
  const prevGitRevisionRef = useRef(gitRevision)
  /** Keep latest callback without putting it in `load` deps (avoids prView spam). */
  const onPrMetaRef = useRef(onPrMeta)
  onPrMetaRef.current = onPrMeta

  const closeMenus = useCallback(() => {
    setMenuOpen(false)
    setMergeOpen(false)
  }, [])

  const load = useCallback(async (opts?: { quiet?: boolean }) => {
    const seq = ++loadSeqRef.current
    if (!workspacePath || !window.vyotiq?.prView) {
      if (seq !== loadSeqRef.current) return
      setPr(null)
      onPrMetaRef.current?.(null)
      setError(
        !window.vyotiq?.prView
          ? 'PR IPC unavailable'
          : 'Open a workspace to view a pull request.'
      )
      setLoading(false)
      return
    }
    if (!opts?.quiet) {
      setLoading(true)
      setError(null)
    }
    try {
      let authData: GithubAuthStatus | null = null
      if (window.vyotiq.githubAuthStatus) {
        const authRes = await window.vyotiq.githubAuthStatus()
        if (seq === loadSeqRef.current && authRes.ok) {
          authData = authRes.data
          setAuth((prev) => mergeAuthStatus(prev, authRes.data))
        }
      }
      if (
        authData?.ghAvailable &&
        !authData.ghAuthenticated &&
        !authData.pending
      ) {
        if (seq !== loadSeqRef.current) return
        if (!opts?.quiet) {
          setPr(null)
          onPrMetaRef.current?.(null)
          setError('Connect GitHub to view pull requests for this branch.')
        }
        return
      }
      const res = await window.vyotiq.prView(workspacePath)
      if (seq !== loadSeqRef.current) return
      if (!res.ok) {
        if (opts?.quiet) return
        setPr(null)
        onPrMetaRef.current?.(null)
        setError(res.error)
        return
      }
      setPr(res.data)
      onPrMetaRef.current?.(
        res.data ? { number: res.data.number, title: res.data.title } : null
      )
      if (res.data) {
        setViewed(loadViewed(workspacePath, res.data.number))
        setTitleDraft(res.data.title)
        if (opts?.quiet) setError(null)
      } else if (!opts?.quiet) {
        setError('No pull request for this branch.')
      }
    } catch (err) {
      if (seq !== loadSeqRef.current) return
      if (opts?.quiet) return
      setPr(null)
      onPrMetaRef.current?.(null)
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === loadSeqRef.current) setLoading(false)
    }
  }, [workspacePath])

  const loadIssues = useCallback(async () => {
    if (!workspacePath) return
    setIssuesBusy(true)
    try {
      const res = await window.vyotiq.githubIssuesList({ workspacePath })
      if (!res.ok) {
        setNotice(res.error)
        setNoticeFailed(true)
        return
      }
      setIssues(res.data.issues)
    } finally {
      setIssuesBusy(false)
    }
  }, [workspacePath])

  useEffect(() => {
    if (tab !== 'issues') return
    void loadIssues()
  }, [tab, loadIssues])

  const loadRef = useRef(load)
  loadRef.current = load
  /** Poll budget per head commit, so re-renders cannot extend it forever. */
  const pollStartRef = useRef<{ key: string; at: number } | null>(null)

  /**
   * Watch CI while it is actually running.
   *
   * `prView` shells out to `gh` over the network, so this only ticks when a
   * check is genuinely in flight on an open PR and the window is visible, and
   * it gives up after PR_CHECKS_POLL_MAX_MS on one head commit — a check wedged
   * in QUEUED must not poll GitHub for the rest of the session. Pushing a new
   * commit changes the head oid and starts a fresh budget.
   */
  useEffect(() => {
    if (!pr) {
      pollStartRef.current = null
      return undefined
    }
    const prState = pr.state.trim().toUpperCase()
    if (prState === 'MERGED' || prState === 'CLOSED') return undefined
    if (checksPendingCount(pr) === 0) return undefined

    const key = `${pr.number}:${pr.headRefOid}`
    if (pollStartRef.current?.key !== key) {
      pollStartRef.current = { key, at: Date.now() }
    }
    if (Date.now() - pollStartRef.current.at > PR_CHECKS_POLL_MAX_MS) return undefined

    const timer = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      void loadRef.current({ quiet: true })
    }, PR_CHECKS_POLL_MS)
    return () => window.clearInterval(timer)
  }, [pr])

  const hadGhAuthRef = useRef(false)

  const applyAuthStatus = useCallback(
    (data: GithubAuthStatus) => {
      setAuth((prev) => mergeAuthStatus(prev, data))
      if (data.ghAuthenticated && !hadGhAuthRef.current) {
        hadGhAuthRef.current = true
        setError(null)
        void load()
      }
      hadGhAuthRef.current = data.ghAuthenticated
    },
    [load]
  )

  const refreshAuth = useCallback(async () => {
    if (!window.vyotiq?.githubAuthStatus) return
    const res = await window.vyotiq.githubAuthStatus()
    if (!res.ok) return
    applyAuthStatus(res.data)
  }, [applyAuthStatus])

  useEffect(() => {
    const unsubscribe = window.vyotiq?.onGithubAuthStatus?.(applyAuthStatus)
    return () => {
      unsubscribe?.()
    }
  }, [applyAuthStatus])

  useEffect(() => {
    if (!auth?.pending) return undefined
    const id = window.setInterval(() => {
      void refreshAuth()
    }, 2000)
    return () => window.clearInterval(id)
  }, [auth?.pending, refreshAuth])

  const connectGithub = useCallback(async () => {
    if (!window.vyotiq?.githubAuthStart) {
      setAuth((prev) => ({
        ghAvailable: prev?.ghAvailable ?? true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: 'GitHub connect is unavailable in this build. Restart Agent V and try again.'
      }))
      return
    }
    setAuthBusy(true)
    setAuth((prev) => ({
      ghAvailable: prev?.ghAvailable ?? true,
      ghAuthenticated: false,
      hasAppToken: false,
      pending: true,
      userCode: prev?.userCode ?? null,
      verificationUri: prev?.verificationUri ?? 'https://github.com/login/device',
      error: null
    }))
    try {
      const res = await window.vyotiq.githubAuthStart()
      if (res.ok) {
        applyAuthStatus(res.data)
      } else {
        setAuth((prev) =>
          prev
            ? { ...prev, error: res.error, pending: false }
            : {
                ghAvailable: true,
                ghAuthenticated: false,
                hasAppToken: false,
                pending: false,
                userCode: null,
                verificationUri: null,
                error: res.error
              }
        )
      }
    } catch (err) {
      setAuth((prev) => ({
        ghAvailable: prev?.ghAvailable ?? true,
        ghAuthenticated: false,
        hasAppToken: false,
        pending: false,
        userCode: null,
        verificationUri: null,
        error: err instanceof Error ? err.message : String(err)
      }))
    } finally {
      setAuthBusy(false)
    }
  }, [applyAuthStatus])

  const cancelGithub = useCallback(() => {
    void window.vyotiq.githubAuthCancel?.().then((res) => {
      if (res.ok) applyAuthStatus(res.data)
    })
  }, [applyAuthStatus])

  const installGhCli = useCallback(async () => {
    if (!window.vyotiq?.githubCliInstall) return
    setGhInstallBusy(true)
    setNotice(null)
    setNoticeFailed(false)
    setError(null)
    try {
      const res = await window.vyotiq.githubCliInstall()
      if (res.ok && res.data.ghAvailable) {
        setAuth((prev) => (prev ? { ...prev, ghAvailable: true } : prev))
        setNotice(res.data.detail || 'GitHub CLI is ready.')
        setNoticeFailed(false)
        await refreshAuth()
        void load()
        return
      }
      await refreshAuth()
      const authRes = await window.vyotiq.githubAuthStatus?.()
      if (authRes?.ok && authRes.data.ghAvailable) {
        setAuth(authRes.data)
        setNotice('GitHub CLI is ready.')
        setNoticeFailed(false)
        void load()
      } else {
        setNotice(res.ok ? 'GitHub CLI install finished but is not ready yet.' : res.error)
        setNoticeFailed(true)
      }
    } finally {
      setGhInstallBusy(false)
    }
  }, [load, refreshAuth])

  const createPr = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prCreate || createBusy) return
    setCreateBusy(true)
    setNotice(null)
    setNoticeFailed(false)
    try {
      const res = await window.vyotiq.prCreate(workspacePath, { draft: true })
      if (res.ok) {
        setNotice(`${res.data.detail}: ${res.data.url}`)
        setNoticeFailed(false)
        await load()
      } else {
        setNotice(res.error)
        setNoticeFailed(true)
      }
    } finally {
      setCreateBusy(false)
    }
  }, [workspacePath, createBusy, load])

  const openExternal = useCallback(async (url: string) => {
    if (!window.vyotiq?.shellOpenExternal) return
    const res = await window.vyotiq.shellOpenExternal(url)
    if (!res.ok) {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [])

  useEffect(() => {
    if (!active) return
    const quiet = prevGitRevisionRef.current !== gitRevision
    prevGitRevisionRef.current = gitRevision
    void load(quiet ? { quiet: true } : undefined)
  }, [load, gitRevision, active])

  useEffect(() => {
    setSelectedPath(null)
    setFindQuery('')
    setFindOpen(false)
    setEditingTitle(false)
  }, [workspacePath])

  useEffect(() => {
    if (!findOpen) return
    findInputRef.current?.focus()
  }, [findOpen])

  useEffect(() => {
    if (!editingTitle) return
    titleInputRef.current?.focus()
    titleInputRef.current?.select()
  }, [editingTitle])

  const merge = useCallback(
    async (method: PrMergeMethod) => {
      if (!workspacePath || !window.vyotiq?.prMerge || !pr) return
      const confirmed = window.confirm(
        `Merge PR #${pr.number} using ${method}? This cannot be undone from the app.`
      )
      if (!confirmed) return
      setMergeBusy(true)
      setNotice(null)
      setNoticeFailed(false)
      closeMenus()
      try {
        const res = await window.vyotiq.prMerge(workspacePath, method, pr.number)
        if (res.ok) {
          setNotice(res.data.detail)
          setNoticeFailed(false)
          void load()
        } else {
          setNotice(res.error)
          setNoticeFailed(true)
        }
      } finally {
        setMergeBusy(false)
      }
    },
    [workspacePath, load, closeMenus, pr]
  )

  const toggleViewed = useCallback(
    (path: string) => {
      if (!workspacePath || !pr) return
      setViewed((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        saveViewed(workspacePath, pr.number, next)
        return next
      })
    },
    [workspacePath, pr]
  )

  const fetchPrDiff = useCallback(
    async (path: string) => {
      if (!workspacePath || !pr) return { error: 'No workspace' }
      const res = await window.vyotiq.prDiff({
        workspacePath,
        path,
        ignoreWhitespace,
        number: pr.number
      })
      if (!res.ok) return { error: res.error }
      return { content: res.data.content }
    },
    [workspacePath, ignoreWhitespace, pr]
  )

  const browserFiles = useMemo(
    () => (pr ? pr.files.map(toPrBrowserEntry) : []),
    [pr]
  )

  const filteredBrowserFiles = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return browserFiles
    return browserFiles.filter((f) => f.path.toLowerCase().includes(q))
  }, [browserFiles, findQuery])

  const showConnect = needsGithubConnect(error, auth)
  const showGhInstall = needsGhInstall(error, auth)
  const canCreatePr = Boolean(
    auth?.ghAvailable &&
      auth.ghAuthenticated &&
      !auth.pending &&
      !/not a git repository/i.test(error ?? '')
  )

  const ghInstallActions = (
    <Button size="sm"
      variant="primary"
      disabled={ghInstallBusy}
      onClick={() => void installGhCli()}
    >
      {ghInstallBusy ? 'Installing…' : 'Install GitHub CLI'}
    </Button>
  )

  const githubAuthPanel = (
    <GithubAuthPanel
      auth={auth}
      authBusy={authBusy}
      onConnect={() => void connectGithub()}
      onCancel={cancelGithub}
      onOpenGithub={(url) => void openExternal(url)}
    />
  )

  const closePr = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prClose || !pr) return
    const confirmed = window.confirm(
      `Close PR #${pr.number}? The pull request will be closed on GitHub.`
    )
    if (!confirmed) return
    closeMenus()
    setNotice(null)
    setNoticeFailed(false)
    const res = await window.vyotiq.prClose(workspacePath, pr.number)
    if (res.ok) {
      setNotice(res.data.detail)
      setNoticeFailed(false)
      void load()
    } else {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [workspacePath, load, closeMenus, pr])

  const saveTitle = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prEditTitle || !pr) return
    const next = titleDraft.trim()
    if (!next || next === pr.title) {
      setEditingTitle(false)
      setTitleDraft(pr.title)
      return
    }
    const res = await window.vyotiq.prEditTitle(workspacePath, next, pr.number)
    if (res.ok) {
      setPr((curr) => (curr ? { ...curr, title: res.data.title } : curr))
      onPrMeta?.({ number: pr.number, title: res.data.title })
      setEditingTitle(false)
      setNotice('Title updated')
      setNoticeFailed(false)
    } else {
      setNotice(res.error)
      setNoticeFailed(true)
    }
  }, [workspacePath, pr, titleDraft, onPrMeta])

  const markReady = useCallback(async () => {
    if (!workspacePath || !window.vyotiq?.prReady || !pr) return
    setReadyBusy(true)
    setNotice(null)
    try {
      const res = await window.vyotiq.prReady(workspacePath, pr.number)
      setNotice(res.ok ? res.data.detail : res.error)
      setNoticeFailed(!res.ok)
      if (res.ok) void load()
    } finally {
      setReadyBusy(false)
    }
  }, [workspacePath, pr, load])

  const startEditTitle = useCallback(() => {
    if (!pr) return
    closeMenus()
    setTitleDraft(pr.title)
    setEditingTitle(true)
  }, [pr, closeMenus])

  useEffect(() => {
    if (!pr || !active) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (matchShortcut(e, 'refresh')) {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        void load()
        return
      }
      if (matchShortcut(e, 'find') && tab === 'changes') {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        setFindOpen(true)
        return
      }
      if (e.shiftKey && e.altKey && e.key.toLowerCase() === 't') {
        if (isEditableShortcutTarget(e.target)) return
        e.preventDefault()
        startEditTitle()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pr, load, tab, startEditTitle, active])

  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    setNow(Date.now())
  }, [pr])

  const prFiles: ChangesListFile[] = filteredBrowserFiles.map((f) => ({
    path: f.path,
    status: f.statusLetter,
    added: f.added,
    removed: f.removed,
    ...(viewed.has(f.path) ? { note: 'Viewed' } : {})
  }))
  const selectedIndex = selectedPath ? prFiles.findIndex((f) => f.path === selectedPath) : -1
  const selectedFile = selectedIndex >= 0 ? prFiles[selectedIndex]! : null
  const stepFile = (offset: number): (() => void) | undefined => {
    const next = prFiles[selectedIndex + offset]
    return next ? () => setSelectedPath(next.path) : undefined
  }
  const fileActions = (file: ChangesListFile) => {
    const name = file.path.replace(/\\/g, '/').split('/').pop() ?? file.path
    const seen = viewed.has(file.path)
    return (
      <>
        <IconButton
          icon={seen ? 'eye' : 'check'}
          label={seen ? `Mark ${name} as not viewed` : `Mark ${name} as viewed`}
          size="xs"
          tone="muted"
          onClick={() => toggleViewed(file.path)}
        />
        {onOpenFile && file.status !== 'D' ? (
          <IconButton icon="external" label={`Open ${name}`} size="xs" tone="muted" onClick={() => onOpenFile(file.path)} />
        ) : null}
      </>
    )
  }

  const moreItems: ActionMenuItem[] = pr
    ? [
        { id: 'wrap', label: 'Word wrap', checked: wordWrap, onSelect: () => setWordWrap((v) => !v) },
        { id: 'whitespace', label: 'Ignore whitespace', checked: ignoreWhitespace, onSelect: () => setIgnoreWhitespace((v) => !v) },
        {
          id: 'filter',
          label: 'Filter files',
          icon: 'filter',
          separatorBefore: true,
          onSelect: () => {
            setTab('changes')
            setFindOpen(true)
          }
        },
        { id: 'refresh', label: 'Refresh', icon: 'refresh', onSelect: () => void load() },
        { id: 'copy', label: 'Copy URL', icon: 'copy', onSelect: () => void copyText(pr.url) },
        { id: 'title', label: 'Edit title', icon: 'edit', onSelect: startEditTitle },
        { id: 'issues', label: 'Issues', icon: 'flag', onSelect: () => setTab('issues') },
        ...(auth?.hasAppToken
          ? [
              {
                id: 'disconnect',
                label: 'Disconnect GitHub',
                icon: 'plug' as const,
                separatorBefore: true,
                onSelect: () => {
                  void window.vyotiq.githubAuthLogout?.().then((res) => {
                    if (res.ok) applyAuthStatus(res.data)
                    void load()
                  })
                }
              }
            ]
          : []),
        {
          id: 'close-pr',
          label: 'Close pull request',
          icon: 'close',
          danger: true,
          separatorBefore: !auth?.hasAppToken,
          onSelect: () => void closePr()
        },
        {
          id: 'hide',
          label: 'Hide panel',
          onSelect: () => {
            onPrMeta?.(null)
            onUnlink?.()
          }
        }
      ]
    : []

  const openState = pr ? pr.state.trim().toUpperCase() : ''
  const handPrompt = (check: PrCheck): string =>
    `The “${check.name}” check failed on pull request #${pr?.number ?? ''}${check.description ? ` (${check.description})` : ''}. ` +
    `Read its log${check.url ? ` at ${check.url}` : ''}, find the cause and fix it.`

  const back = (label: string) => (
    <div className="-mx-2 mb-2 flex items-center gap-1">
      <IconButton icon="arrowLeft" label={`Back to ${label}`} size="xs" tone="muted" onClick={() => setTab(pr ? 'checks' : 'changes')} />
      <span className="text-xs text-muted">{label}</span>
    </div>
  )

  return (
    <div
      className={cn(CHAT_RIGHT_PANEL_BODY, className)}
      data-pr-panel
      role="region"
      aria-label="Pull request panel"
    >
      {pr ? (
        <div className="shrink-0 border-b border-border px-4 pt-3" data-pr-header>
          <div className="flex items-center gap-2 text-xs">
            <Badge tone={prStateTone(pr)}>
              <Icon name="pullRequest" size={11} />
              {pr.isDraft && openState === 'OPEN' ? 'Draft' : formatPrState(pr.state)}
            </Badge>
            <span className="min-w-0 truncate font-mono text-caption text-muted" title={`${pr.headRefName} → ${pr.baseRefName}`}>
              {pr.headRefName} <span className="text-tertiary">→</span> {pr.baseRefName}
            </span>
            <span className="flex-1" />
            <IconButton icon="external" label="Open on GitHub" size="sm" tone="muted" onClick={() => void openExternal(pr.url)} />
            <ActionMenu
              open={menuOpen}
              onOpenChange={setMenuOpen}
              placement="down"
              align="end"
              aria-label="PR actions"
              items={moreItems}
              trigger={(t) => (
                <IconButton
                  ref={t.ref}
                  icon="more"
                  label="PR actions"
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
          {editingTitle ? (
            <form
              className="mt-2 flex min-w-0 items-center gap-1.5"
              onSubmit={(e) => {
                e.preventDefault()
                void saveTitle()
              }}
            >
              <input
                ref={titleInputRef}
                type="text"
                className="min-w-0 flex-1 rounded-md border border-border bg-bg px-2 py-1 text-sm text-fg focus-visible:vy-focus-ring"
                value={titleDraft}
                maxLength={256}
                aria-label="PR title"
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setEditingTitle(false)
                    setTitleDraft(pr.title)
                  }
                }}
              />
              <Button size="sm" type="submit">
                Save
              </Button>
            </form>
          ) : (
            <h3 className="m-0 mt-2 text-sm font-semibold leading-5 text-fg-strong" title={pr.title}>
              {pr.title} <span className="font-normal text-tertiary">#{pr.number}</span>
            </h3>
          )}
          <Tabs
            size="sm"
            value={tab === 'issues' ? 'checks' : tab}
            onChange={(id) => setTab(id)}
            label="Pull request"
            className="mt-1"
            items={[
              {
                id: 'checks',
                label: 'Checks',
                ...(pr.checks.length ? { count: `${checksPassedCount(pr)}/${pr.checks.length}` } : {})
              },
              { id: 'changes', label: 'Files', count: pr.files.length },
              { id: 'commits', label: 'Commits', count: pr.commits.length },
              {
                id: 'reviews',
                label: 'Reviews',
                ...((pr.latestReviews.length || pr.reviews.length) ? { count: pr.latestReviews.length || pr.reviews.length } : {})
              },
              { id: 'description', label: 'About' }
            ]}
          />
        </div>
      ) : null}

      {notice ? (
        <p
          className={cn(
            'm-0 shrink-0 border-b border-border px-4 py-1.5 text-xs',
            noticeFailed ? 'text-danger' : 'text-success'
          )}
          role={noticeFailed ? 'alert' : 'status'}
        >
          {notice}
        </p>
      ) : null}

      {findOpen && pr && tab === 'changes' ? (
        <div className="flex h-9 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs">
          <Icon name="search" size={13} className="shrink-0 text-muted" />
          <input
            ref={findInputRef}
            type="text"
            role="searchbox"
            className="min-w-0 flex-1 bg-transparent text-xs text-fg outline-none placeholder:text-tertiary"
            value={findQuery}
            placeholder="Filter files"
            aria-label="Filter files"
            onChange={(e) => setFindQuery(e.target.value)}
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

      {loading ? (
        <p className="m-0 px-4 py-3 text-xs text-muted">Loading…</p>
      ) : tab === 'issues' ? (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {back(pr ? 'checks' : 'the pull request')}
          <form
            className="space-y-2"
            onSubmit={(event) => {
              event.preventDefault()
              const title = issueTitle.trim()
              if (!title || !workspacePath) return
              setIssueCreateBusy(true)
              setNotice(null)
              void window.vyotiq
                .githubIssueCreate({
                  workspacePath,
                  title,
                  body: issueBody.trim() || undefined
                })
                .then((res) => {
                  if (!res.ok) {
                    setNotice(res.error)
                    setNoticeFailed(true)
                    return
                  }
                  setNotice(res.data.detail)
                  setNoticeFailed(false)
                  setIssueTitle('')
                  setIssueBody('')
                  void loadIssues()
                  if (res.data.url) void window.vyotiq.shellOpenExternal(res.data.url)
                })
                .finally(() => setIssueCreateBusy(false))
            }}
          >
            <h4 className={SECTION_LABEL}>New issue</h4>
            <input
              className="block w-full rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-fg outline-none placeholder:text-tertiary focus-visible:vy-focus-ring"
              value={issueTitle}
              onChange={(e) => setIssueTitle(e.target.value)}
              placeholder="Title"
              aria-label="Issue title"
              required
            />
            <Textarea
              className="min-h-[4.5rem] rounded-md border border-border px-2 text-xs"
              placeholder="Optional description"
              aria-label="Issue description"
              value={issueBody}
              onChange={(e) => setIssueBody(e.target.value)}
            />
            <Button size="sm" type="submit" pending={issueCreateBusy} disabled={issueCreateBusy || !issueTitle.trim()}>
              {issueCreateBusy ? 'Creating…' : 'Create issue'}
            </Button>
          </form>
          <section className="mt-5">
            <h4 className={cn('mb-1', SECTION_LABEL)}>Open issues</h4>
            {issuesBusy && issues.length === 0 ? (
              <p className="m-0 text-xs text-muted">Loading issues…</p>
            ) : issues.length === 0 ? (
              <p className="m-0 text-xs text-muted">No open issues.</p>
            ) : (
              <ul className="-mx-2 m-0 list-none p-0">
                {issues.map((issue) => (
                  <li key={issue.number} className="flex h-8 items-center gap-2 rounded-md px-2 text-xs hover:bg-surface">
                    <span className="shrink-0 font-mono text-caption text-tertiary">#{issue.number}</span>
                    <span className="min-w-0 flex-1 truncate text-fg">{issue.title}</span>
                    <span className="shrink-0 text-caption text-tertiary">{issue.state.toLowerCase()}</span>
                    {issue.url ? (
                      <IconButton
                        icon="external"
                        label={`Open issue #${issue.number}`}
                        size="xs"
                        tone="muted"
                        onClick={() => void window.vyotiq.shellOpenExternal(issue.url)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      ) : !pr ? (
        <div className="flex min-h-0 flex-1 flex-col">
          {showGhInstall ? (
            <EmptyPanel
              icon="pullRequest"
              title={prEmptyTitle(error)}
              body="Install GitHub CLI to view pull requests for this branch. Agent V uses winget or Homebrew when available, otherwise downloads gh into app data."
              actions={ghInstallActions}
              centered
            />
          ) : showConnect || auth?.pending ? (
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">{githubAuthPanel}</div>
          ) : (
            <EmptyPanel
              icon="pullRequest"
              title={prEmptyTitle(error)}
              body={prEmptyBody(error)}
              centered
              actions={
                <>
                  {canCreatePr ? (
                    <Button size="sm" variant="primary" disabled={createBusy} onClick={() => void createPr()}>
                      {createBusy ? 'Creating…' : 'Create a draft PR'}
                    </Button>
                  ) : null}
                  <Button size="sm" onClick={() => setTab('issues')}>
                    Issues
                  </Button>
                </>
              }
            />
          )}
        </div>
      ) : tab === 'changes' ? (
        pr.files.length === 0 ? (
          <p className="m-0 px-4 py-3 text-xs text-muted">No files changed.</p>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2 text-xs">
              <span className="text-muted">
                {pr.files.length} {pr.files.length === 1 ? 'file' : 'files'}
              </span>
              <span className="inline-flex gap-1.5 font-mono text-caption tnum">
                {pr.additions > 0 ? <span className="text-success">+{pr.additions}</span> : null}
                {pr.deletions > 0 ? <span className="text-danger">−{pr.deletions}</span> : null}
              </span>
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
            </div>
            <ChangesList
              files={prFiles}
              selectedPath={selectedFile?.path ?? null}
              onSelect={setSelectedPath}
              actions={fileActions}
              className={cn(
                'scroll-thin shrink-0 overflow-y-auto',
                selectedFile ? 'max-h-[210px] border-b border-border' : 'min-h-0 flex-1'
              )}
            />
            {selectedFile ? (
              <ChangeDiff
                path={selectedFile.path}
                fetchDiff={fetchPrDiff}
                layout={layout}
                wordWrap={wordWrap}
                findQuery={findQuery}
                onOpen={onOpenFile && selectedFile.status !== 'D' ? () => onOpenFile(selectedFile.path) : undefined}
                onPrev={stepFile(-1)}
                onNext={stepFile(1)}
              />
            ) : null}
          </div>
        )
      ) : (
        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {tab === 'description' ? (
            pr.body.trim() ? (
              <MarkdownContent content={pr.body} tone="secondary" />
            ) : (
              <p className="m-0 text-xs text-muted">No description.</p>
            )
          ) : tab === 'commits' ? (
            showConnect && pr.commits.length === 0 ? (
              githubAuthPanel
            ) : pr.commits.length === 0 ? (
              <p className="m-0 text-xs text-muted">No commits reported for this pull request.</p>
            ) : (
              <ul className="-mx-2 m-0 list-none p-0">
                {pr.commits.map((c) => (
                  <li key={c.oid} className="rounded-md px-2 py-1.5">
                    <p className="m-0 truncate text-xs text-fg" title={c.messageHeadline}>
                      {c.messageHeadline}
                    </p>
                    <p className="m-0 mt-0.5 truncate text-caption text-tertiary">
                      <span className="font-mono">{c.oid.slice(0, 7)}</span>
                      {c.authors.length ? ` · ${c.authors.join(', ')}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
            )
          ) : tab === 'reviews' ? (
            showConnect && (pr.latestReviews.length ? pr.latestReviews : pr.reviews).length === 0 ? (
              githubAuthPanel
            ) : (
              <>
                {pr.reviewDecision ? (
                  <p className="m-0 text-xs text-muted">
                    Decision: <span className="font-medium text-fg">{pr.reviewDecision.toLowerCase().replace(/_/g, ' ')}</span>
                  </p>
                ) : null}
                {pr.reviewRequests.length > 0 ? (
                  <p className="m-0 mt-1 text-xs text-muted">Requested: {pr.reviewRequests.join(', ')}</p>
                ) : null}
                {(pr.latestReviews.length ? pr.latestReviews : pr.reviews).length === 0 ? (
                  <p className="m-0 mt-1 text-xs text-muted">No reviews yet for this pull request.</p>
                ) : (
                  <ul className="m-0 mt-1 list-none divide-y divide-border p-0">
                    {(pr.latestReviews.length ? pr.latestReviews : pr.reviews).map((r, i) => (
                      <ReviewCard key={`${r.author}-${r.submittedAt ?? i}`} review={r} />
                    ))}
                  </ul>
                )}
                {workspacePath && window.vyotiq?.prReview ? (
                  <form
                    className="mt-5 space-y-2"
                    onSubmit={(event) => {
                      event.preventDefault()
                      setReviewBusy(true)
                      setNotice(null)
                      void window.vyotiq
                        .prReview({
                          workspacePath,
                          event: reviewEvent,
                          body: reviewBody.trim() || undefined,
                          number: pr.number
                        })
                        .then((res) => {
                          if (!res.ok) {
                            setNotice(res.error)
                            setNoticeFailed(true)
                            return
                          }
                          setNotice(res.data.detail)
                          setNoticeFailed(false)
                          setReviewBody('')
                          void load()
                        })
                        .finally(() => setReviewBusy(false))
                    }}
                  >
                    <h4 className={SECTION_LABEL}>Submit a review</h4>
                    <Segmented
                      label="Review"
                      value={reviewEvent}
                      onChange={setReviewEvent}
                      items={[
                        { id: 'comment', label: 'Comment' },
                        { id: 'approve', label: 'Approve' },
                        { id: 'request-changes', label: 'Request changes' }
                      ]}
                    />
                    <Textarea
                      className="min-h-[4.5rem] rounded-md border border-border px-2 text-xs"
                      placeholder="Review comment"
                      aria-label="Review comment"
                      value={reviewBody}
                      onChange={(e) => setReviewBody(e.target.value)}
                    />
                    <Button size="sm" type="submit" pending={reviewBusy} disabled={reviewBusy}>
                      {reviewBusy ? 'Submitting…' : 'Submit review'}
                    </Button>
                  </form>
                ) : null}
              </>
            )
          ) : (
            <>
              {pr.checks.length === 0 ? (
                <p className="m-0 text-xs text-muted">No CI checks configured — they’ll appear here once set up.</p>
              ) : (
                <ul className="-mx-2 m-0 list-none p-0" aria-label="Checks">
                  {pr.checks.map((c, i) => {
                    const { glyph, word } = checkState(c)
                    const duration = checkDuration(c, now)
                    return (
                      <li
                        key={`${c.name}-${i}`}
                        className={cn('rounded-md px-2 py-2', glyph === 'failed' ? 'bg-danger-soft' : '')}
                        data-check-state={glyph}
                      >
                        <div className="flex items-center gap-2.5">
                          <StatusGlyph state={glyph} size={14} />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg">
                            {c.name}
                            <span className="sr-only">, {word}</span>
                          </span>
                          {duration ? <span className="font-mono text-caption text-tertiary tnum">{duration}</span> : null}
                          {c.url ? (
                            <IconButton
                              icon="external"
                              label={`Open the ${c.name} run`}
                              size="xs"
                              tone="muted"
                              onClick={() => void openExternal(c.url!)}
                            />
                          ) : null}
                        </div>
                        {glyph === 'failed' && (c.description || onHandToAgent) ? (
                          <div className="mt-1.5 flex items-center gap-2 pl-6 text-xs">
                            <span className="min-w-0 flex-1 truncate text-danger">{c.description ?? word}</span>
                            {onHandToAgent ? (
                              <Button size="xs" icon="robot" onClick={() => onHandToAgent(handPrompt(c))}>
                                Hand to the agent
                              </Button>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ul>
              )}

              <section className="mt-5">
                <h4 className={cn('mb-2', SECTION_LABEL)}>Merge</h4>
                {openState === 'MERGED' ? (
                  <p className="m-0 text-xs text-muted">Merged into {pr.baseRefName}.</p>
                ) : openState === 'CLOSED' ? (
                  <p className="m-0 text-xs text-muted">Closed without merging.</p>
                ) : (
                  <>
                    {mergeSummary(pr) ? <p className="m-0 text-xs text-muted">{mergeSummary(pr)}</p> : null}
                    <div className="mt-2.5 flex items-center gap-1.5">
                      <ActionMenu
                        open={mergeOpen}
                        onOpenChange={setMergeOpen}
                        placement="up"
                        align="start"
                        aria-label="Merge method"
                        items={(['squash', 'merge', 'rebase'] as const).map((method) => ({
                          id: method,
                          label: MERGE_LABEL[method],
                          icon: method === 'squash' ? ('gitCommit' as const) : method === 'merge' ? ('gitMerge' as const) : ('gitRebase' as const),
                          onSelect: () => void merge(method)
                        }))}
                        trigger={(t) => (
                          <Button
                            ref={t.ref}
                            size="sm"
                            variant="primary"
                            trailingIcon="chevron"
                            disabled={!prMergeAllowed(pr) || mergeBusy}
                            aria-expanded={t['aria-expanded']}
                            aria-controls={t['aria-controls']}
                            aria-haspopup={t['aria-haspopup']}
                            onClick={t.onClick}
                          >
                            {mergeBusy ? 'Merging…' : 'Squash and merge'}
                          </Button>
                        )}
                      />
                      <span className="flex-1" />
                      {pr.isDraft ? (
                        <Button size="sm" variant="ghost" pending={readyBusy} onClick={() => void markReady()}>
                          Mark ready for review
                        </Button>
                      ) : null}
                    </div>
                  </>
                )}
              </section>
            </>
          )}
        </div>
      )}
    </div>
  )
}
