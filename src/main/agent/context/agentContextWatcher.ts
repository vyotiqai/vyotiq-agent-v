import { watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { IPC } from '../../../shared/channels'
import { logger } from '../../../shared/logger'
import type { WorkspaceAgentContextChanged, WorkspaceAgentContextResult } from '../../../shared/ipc'
import { canonicalizeWorkspacePath } from '../../../shared/workspacePath'
import { workspacePathsEqual } from '../../../shared/workspacePathMatch'
import { getCodeIndexRuntimeStatus, isCodeIndexPaused, onCodeIndexRuntimeStatus } from '../codeindex'
import { invalidateGitStatusCache } from '../../git/gitStatusCache'
import { getSettings } from '../../settings/settings'
import { buildWorkspaceAgentContext, mapCodeIndexState } from './agentContext'

/**
 * Keep the empty-session context strip honest while it is on screen.
 *
 * Watches only the five cold paths the summary is actually computed from —
 * never `.vyotiq` as a whole, which holds `runs/`, `codeindex/` and
 * `sparsegrep/` and churns constantly during a run. Every watch is filtered
 * to the entries that can change an answer, so an agent writing transcripts
 * costs nothing here.
 *
 * A push only goes out when a rebuilt summary differs from the last one the
 * renderer was given, so fs noise cannot turn into IPC traffic or re-renders.
 */

/** One checkout writes several files; coalesce the burst into one rebuild. */
const DEBOUNCE_MS = 250

type TargetKey = 'root' | 'vyotiq' | 'rules' | 'cursor' | 'cursorRules' | 'memory' | 'git'

type Target = {
  key: TargetKey
  rel: readonly string[]
  recursive: boolean
  /** Direct entries that can change an answer; null = anything below matters. */
  names: readonly string[] | null
  /**
   * Entries whose change can move the branch. Branch reads are cached for
   * 750ms, so these must drop that cache before the rebuild reads it — `.git`
   * appearing under the root counts, otherwise `git init` can be answered
   * from a cached "not a repo".
   */
  gitNames?: readonly string[]
}

const TARGETS: readonly Target[] = [
  {
    key: 'root',
    rel: [],
    recursive: false,
    names: ['AGENTS.md', 'CLAUDE.md', '.cursorrules', '.vyotiq', '.cursor', '.git'],
    gitNames: ['.git']
  },
  { key: 'vyotiq', rel: ['.vyotiq'], recursive: false, names: ['rules', 'memory'] },
  { key: 'rules', rel: ['.vyotiq', 'rules'], recursive: true, names: null },
  { key: 'cursor', rel: ['.cursor'], recursive: false, names: ['rules'] },
  { key: 'cursorRules', rel: ['.cursor', 'rules'], recursive: true, names: null },
  { key: 'memory', rel: ['.vyotiq', 'memory'], recursive: true, names: null },
  { key: 'git', rel: ['.git'], recursive: false, names: ['HEAD'], gitNames: ['HEAD'] }
]

type Watch = {
  /** The exact path the renderer asked about — echoed back so it can filter. */
  workspacePath: string
  handles: Map<TargetKey, FSWatcher>
  timer: ReturnType<typeof setTimeout> | null
  gitDirty: boolean
  last: WorkspaceAgentContextResult
  building: boolean
  again: boolean
}

const watches = new Map<string, Watch>()
let codeIndexUnsubscribe: (() => void) | null = null

function sameContext(a: WorkspaceAgentContextResult, b: WorkspaceAgentContextResult): boolean {
  return (
    a.workspaceName === b.workspaceName &&
    a.branch === b.branch &&
    a.rules.agentsMd === b.rules.agentsMd &&
    a.rules.claudeMd === b.rules.claudeMd &&
    a.rules.cursorrules === b.rules.cursorrules &&
    a.rules.ruleFileCount === b.rules.ruleFileCount &&
    a.memoryNotes === b.memoryNotes &&
    (a.memoryNoteNames ?? []).join('\0') === (b.memoryNoteNames ?? []).join('\0') &&
    a.codeIndex.state === b.codeIndex.state &&
    a.codeIndex.files === b.codeIndex.files &&
    a.codeIndex.indexedAt === b.codeIndex.indexedAt
  )
}

function push(payload: WorkspaceAgentContextChanged): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue
    try {
      win.webContents.send(IPC.agentContextChanged, payload)
    } catch {
      /* window went away between the check and the send */
    }
  }
}

function schedule(w: Watch, gitChanged: boolean): void {
  if (gitChanged) w.gitDirty = true
  if (w.timer) clearTimeout(w.timer)
  w.timer = setTimeout(() => {
    w.timer = null
    void rebuild(w)
  }, DEBOUNCE_MS)
}

/**
 * Arm every target that is not watched yet. Re-run on each rebuild: a missing
 * `.git` or `.vyotiq/memory` is armed the moment its parent reports it
 * appearing, without a second code path for "directory created later".
 */
function armTargets(w: Watch): void {
  for (const target of TARGETS) {
    if (w.handles.has(target.key)) continue
    const dir = join(w.workspacePath, ...target.rel)
    try {
      const handle = watch(dir, { recursive: target.recursive }, (_event, filename) => {
        // `filename` is null on platforms that cannot report it — react rather
        // than filter, since a missed change is worse than a wasted rebuild.
        const name = filename == null ? null : String(filename)
        if (target.names && name != null && !target.names.includes(name)) return
        const gitChanged =
          target.gitNames != null && (name == null || target.gitNames.includes(name))
        schedule(w, gitChanged)
      })
      handle.on('error', () => {
        try {
          handle.close()
        } catch {
          /* already closed */
        }
        w.handles.delete(target.key)
      })
      // Never hold the event loop open at quit.
      handle.unref()
      w.handles.set(target.key, handle)
    } catch (err) {
      // A directory that does not exist yet is expected: its parent is watched,
      // so it is armed on a later rebuild. Anything else is a watch that will
      // never fire, and the strip would go quietly stale — say so.
      if ((err as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        logger.warn('Agent context watch could not start', { scope: 'agent', target: target.key, err })
      }
    }
  }
}

async function rebuild(w: Watch): Promise<void> {
  if (w.building) {
    w.again = true
    return
  }
  w.building = true
  try {
    do {
      w.again = false
      if (w.gitDirty) {
        w.gitDirty = false
        invalidateGitStatusCache(w.workspacePath)
      }
      armTargets(w)
      const indexStatus = getCodeIndexRuntimeStatus()
      const next = await buildWorkspaceAgentContext(w.workspacePath, {
        enabled: getSettings().codeIndex?.enabled !== false,
        phase: indexStatus.phase,
        statusWorkspace: indexStatus.workspacePath,
        paused: isCodeIndexPaused(w.workspacePath)
      })
      // Stopped while we were reading disk — drop the result.
      if (watches.get(canonicalizeWorkspacePath(w.workspacePath)) !== w) return
      if (sameContext(w.last, next)) continue
      w.last = next
      push({ workspacePath: w.workspacePath, context: next })
    } while (w.again)
  } catch (err) {
    // Keep the last known-good summary, but not silently: a rebuild that throws
    // every time leaves the strip frozen on its boot-time reading.
    logger.warn('Agent context rebuild failed', { scope: 'agent', err })
  } finally {
    w.building = false
  }
}

function hookCodeIndexStatus(): void {
  if (codeIndexUnsubscribe) return
  // One listener feeds every watched workspace, but the phase speaks only for
  // the workspace the status names. Sync emits progress continuously; only a
  // change to that workspace's card state is worth a rebuild, and any other
  // workspace rebuilds once, when a live phase it showed has moved on.
  codeIndexUnsubscribe = onCodeIndexRuntimeStatus((status) => {
    const enabled = getSettings().codeIndex?.enabled !== false
    for (const w of watches.values()) {
      const owns = status.workspacePath != null && workspacePathsEqual(status.workspacePath, w.workspacePath)
      const shown = w.last.codeIndex.state
      if (owns ? shown === mapCodeIndexState(status.phase, enabled) : shown !== 'building' && shown !== 'degraded') continue
      schedule(w, false)
    }
  })
}

/**
 * Start (or re-baseline) live updates for a workspace. Called from the
 * `workspace:agentContext` handler with the summary that request returned, so
 * the first push is a real change rather than an echo of what was just read.
 */
export function armAgentContextWatch(
  workspacePath: string,
  initial: WorkspaceAgentContextResult
): void {
  const key = canonicalizeWorkspacePath(workspacePath)
  const existing = watches.get(key)
  if (existing) {
    existing.last = initial
    armTargets(existing)
    return
  }
  const w: Watch = {
    workspacePath,
    handles: new Map(),
    timer: null,
    gitDirty: false,
    last: initial,
    building: false,
    again: false
  }
  watches.set(key, w)
  armTargets(w)
  hookCodeIndexStatus()
}

/** Release every handle for a workspace (workspace removed, or tests). */
export function stopAgentContextWatch(workspacePath: string): void {
  const key = canonicalizeWorkspacePath(workspacePath)
  const w = watches.get(key)
  if (!w) return
  watches.delete(key)
  if (w.timer) {
    clearTimeout(w.timer)
    w.timer = null
  }
  for (const handle of w.handles.values()) {
    try {
      handle.close()
    } catch {
      /* already closed */
    }
  }
  w.handles.clear()
  if (watches.size === 0 && codeIndexUnsubscribe) {
    codeIndexUnsubscribe()
    codeIndexUnsubscribe = null
  }
}
