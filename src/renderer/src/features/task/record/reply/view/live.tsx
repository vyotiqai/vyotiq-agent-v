import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import { canonicalizeWorkspacePath, isWindowsStylePath } from '@shared/workspacePath'
import { TASK_VIEW_SOURCES } from '@shared/viewSources'
import type { ViewBlock, ViewBlockOf } from '@shared/viewSpec'
import { branchBlock, changesBlock, checksBlock, commitsBlock, daysBlock, spendBlock, taskChangesBlock } from '@shared/viewLiveBlocks'

/*
  A live block: the view names a source, the app reads it and keeps it
  current. It re-reads when git says the workspace changed, when the window
  comes back into view, after an action in a view (Stage) — and, for checks
  still running on GitHub, every half minute until they finish. Nothing polls
  a source that has settled.

  Reads are shared. Every block on screen that names the same source asks
  through one short-lived cache, so ten views of the checks make one call to
  GitHub, not ten, and a focus that wakes them all reads each source once.
  A change git reports, or an action in a view, starts that workspace over.

  A view in an earlier answer does not follow its source (ViewEraContext):
  the answer around it was written about the moment it was drawn. It keeps
  the last read it had, says when that was, and reads again only on Refresh;
  one drawn there from the start waits for Read now.
*/

type Live = ViewBlockOf<'live'>

export type LiveState =
  | { status: 'loading' }
  /** An earlier answer's view, not read yet: Read now reads it. */
  | { status: 'paused' }
  | { status: 'ready'; block: ViewBlock; at: number }
  /** The read failed or can't be made here; `text` says which. */
  | { status: 'off'; text: string }

/** True where views follow their sources; false in an earlier run's answer. */
export const ViewEraContext = createContext(true)

/** Checks still running on GitHub are read again this often. */
const CHECKS_POLL_MS = 30_000

/** How long one read answers every block that asks for it. GitHub is slow and rate-limited; git and Usage are local. */
const SHARE_MS = { git: 1_500, task: 1_500, pr: 15_000, usage: 10_000 } as const

const off = (text: string): LiveState => ({ status: 'off', text })

/**
 * Why a read failed, in a line. Main leads an error with what git or gh said
 * and follows it with the command it ran (for `gh pr view`, 25 JSON field
 * names), which is no use in a view.
 */
export function readFailure(error: string): string {
  const first = error.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Could not read this'
  if (/no git remotes? found|no default remote/i.test(first)) return 'This workspace has no git remote, so no pull request'
  return first
}

const workspaceKey = (path: string): string => {
  const c = canonicalizeWorkspacePath(path)
  return isWindowsStylePath(c) ? c.toLowerCase() : c
}

/* ─── the shared reads, one set per bridge (a test's fresh bridge starts clean) ─── */

type Sub = { workspace: string; git: boolean; fn: () => void }
type Hub = {
  cache: Map<string, { at: number; value: Promise<unknown> }>
  /** Bumped when a workspace's git state moves: reads cached before it are not reused. */
  gen: Map<string, number>
  subs: Set<Sub>
  gitSubscribed: boolean
}

const hubs = new WeakMap<object, Hub>()

function hubOf(api: object): Hub {
  let hub = hubs.get(api)
  if (!hub) hubs.set(api, (hub = { cache: new Map(), gen: new Map(), subs: new Set(), gitSubscribed: false }))
  return hub
}

function shared<T>(hub: Hub, workspace: string, key: string, ttl: number, read: () => Promise<T>): Promise<T> {
  const k = `${workspace}\u0000${hub.gen.get(workspace) ?? 0}\u0000${key}`
  const now = Date.now()
  const hit = hub.cache.get(k)
  if (hit && now - hit.at < ttl) return hit.value as Promise<T>
  const value = read()
  hub.cache.set(k, { at: now, value })
  // Old entries go as new ones arrive; nothing here outlives a minute.
  for (const [key2, entry] of hub.cache) if (now - entry.at > 60_000) hub.cache.delete(key2)
  return value
}

/** One subscription to git's change events for every block, not one per block. */
function follow(api: Window['vyotiq'], hub: Hub, sub: Sub): () => void {
  hub.subs.add(sub)
  if (!hub.gitSubscribed && api.onGitStatusChanged) {
    hub.gitSubscribed = true
    api.onGitStatusChanged((p) => {
      const ws = workspaceKey(p.workspacePath)
      hub.gen.set(ws, (hub.gen.get(ws) ?? 0) + 1)
      for (const s of [...hub.subs]) if (s.git && s.workspace === ws) s.fn()
    })
  }
  return () => hub.subs.delete(sub)
}

/** Re-read every live block: an action just changed what they show. */
export function refreshLiveSources(): void {
  const api = typeof window === 'undefined' ? undefined : window.vyotiq
  if (!api) return
  const hub = hubOf(api)
  hub.cache.clear()
  for (const s of [...hub.subs]) s.fn()
}

async function read(live: Live, workspacePath: string, runId: string | null): Promise<LiveState> {
  const api = window.vyotiq
  const hub = hubOf(api)
  const ws = workspaceKey(workspacePath)
  switch (live.source) {
    case 'git.changes':
    case 'git.branch': {
      const res = await shared(hub, ws, 'status', SHARE_MS.git, () => api.gitStatus(workspacePath))
      if (!res.ok) return off(readFailure(res.error))
      if (res.data.kind === 'not_repo') return off('This workspace is not a git repository')
      if (res.data.kind !== 'ok') return off('Git is not available')
      const block = live.source === 'git.changes' ? changesBlock(res.data.status, live) : branchBlock(res.data.status)
      return { status: 'ready', block, at: Date.now() }
    }
    case 'git.commits': {
      const limit = Math.min(live.limit ?? 8, 40)
      const res = await shared(hub, ws, `log:${limit}`, SHARE_MS.git, () => api.gitLog({ workspacePath, limit }))
      if (!res.ok) return off(readFailure(res.error))
      return { status: 'ready', block: commitsBlock(res.data, live), at: Date.now() }
    }
    case 'pr.checks': {
      const res = await shared(hub, ws, 'pr', SHARE_MS.pr, () => api.prView(workspacePath))
      if (!res.ok) return off(readFailure(res.error))
      if (!res.data) return off('No pull request for this branch')
      return { status: 'ready', block: checksBlock(res.data, live), at: Date.now() }
    }
    case 'task.changes': {
      if (!runId) return off('Only a task has changes of its own')
      const res = await shared(hub, ws, `task:${runId}`, SHARE_MS.task, () => api.taskFileStats({ workspacePath, runId }))
      if (!res.ok) return off(readFailure(res.error))
      return { status: 'ready', block: taskChangesBlock(res.data.files, live), at: Date.now() }
    }
    case 'usage.spend':
    case 'usage.days': {
      const res = await shared(hub, ws, 'usage', SHARE_MS.usage, () => api.homeActivity({ workspacePaths: [workspacePath], windowDays: 30 }))
      if (!res.ok) return off(readFailure(res.error))
      const block = live.source === 'usage.spend' ? spendBlock(res.data) : daysBlock(res.data, live)
      return { status: 'ready', block, at: Date.now() }
    }
  }
}

function sameState(a: LiveState, b: LiveState): boolean {
  if (a.status !== b.status) return false
  if (a.status === 'ready' && b.status === 'ready') return JSON.stringify(a.block) === JSON.stringify(b.block)
  if (a.status === 'off' && b.status === 'off') return a.text === b.text
  return true
}

const usesGit = (live: Live): boolean => live.source.startsWith('git.') || live.source === 'task.changes'

const stillRunning = (state: LiveState): boolean =>
  state.status === 'ready' && state.block.type === 'checks' && state.block.items.some((c) => c.state === 'running' || c.state === 'pending')

export type LiveSource = {
  state: LiveState
  /** When the block was last read, even if that read changed nothing on screen. */
  readAt: number | null
  /** False in an earlier answer: the block shows its last read and waits for this. */
  following: boolean
  /** Read it now. */
  refresh: () => void
}

export function useLiveSource(live: Live, workspacePath: string | null, runId: string | null): LiveSource {
  const following = useContext(ViewEraContext)
  // A view first drawn in an earlier answer waits to be asked; one that was current keeps its last read.
  const [state, setState] = useState<LiveState>(() => (following ? { status: 'loading' } : { status: 'paused' }))
  const [readAt, setReadAt] = useState<number | null>(null)
  const seq = useRef(0)
  // The block's own fields, not its identity: a reshape that keeps them reads nothing new.
  const key = `${live.source}\u0000${live.limit ?? ''}\u0000${live.title ?? ''}`
  const liveRef = useRef(live)
  liveRef.current = live

  const load = useCallback(async (): Promise<void> => {
    const n = ++seq.current
    if (!workspacePath || !window.vyotiq) {
      setState(off('Open a workspace to see this'))
      return
    }
    if (TASK_VIEW_SOURCES.has(liveRef.current.source) && !runId) {
      setState(off('Only a task has changes of its own'))
      return
    }
    try {
      const next = await read(liveRef.current, workspacePath, runId)
      if (n !== seq.current) return
      // The same read again (the window took focus, an unrelated file saved)
      // changes nothing: the block keeps its state, focus included.
      setState((was) => (sameState(was, next) ? was : next))
      setReadAt(Date.now())
    } catch (err) {
      if (n === seq.current) setState(off(readFailure(err instanceof Error ? err.message : 'Could not read this')))
    }
    // `key` stands for the block's fields read through liveRef.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspacePath, runId, key])

  useEffect(() => {
    if (!following) {
      // Stopped following mid-read: that read answers nothing now, so it waits for Read now.
      setState((was) => (was.status === 'loading' ? { status: 'paused' } : was))
      return
    }
    void load()
    const again = (): void => void load()
    const onFocus = (): void => {
      if (document.visibilityState === 'visible') again()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    const api = window.vyotiq
    const unfollow =
      api && workspacePath ? follow(api, hubOf(api), { workspace: workspaceKey(workspacePath), git: usesGit(liveRef.current), fn: again }) : undefined
    return () => {
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
      unfollow?.()
      // A read still in flight answers nothing once this block stops following.
      seq.current += 1
    }
  }, [load, workspacePath, following])

  const polling = following && stillRunning(state)
  useEffect(() => {
    if (!polling) return
    const t = setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, CHECKS_POLL_MS)
    return () => clearInterval(t)
  }, [polling, load])

  const refresh = useCallback((): void => {
    setState((was) => (was.status === 'paused' ? { status: 'loading' } : was))
    void load()
  }, [load])

  return { state, readAt, following, refresh }
}

/** Test hook: forget every shared read. */
export function resetLiveReadsForTests(): void {
  const api = typeof window === 'undefined' ? undefined : window.vyotiq
  if (api) hubs.delete(api)
}
