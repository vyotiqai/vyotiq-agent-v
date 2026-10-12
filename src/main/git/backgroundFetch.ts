import { realpathSync } from 'fs'
import { canonicalizeWorkspacePath, isWindowsStylePath } from '../../shared/workspacePath'
import { fetchRemotes, hasGitRemote, isGitRepo, readGitAheadBehind, type GitFetchOutcome } from './git'
import { resolveGitDirs } from './repoCommandGuard'

/**
 * The app's own periodic fetch, so ahead/behind and "N to pull" stay true
 * without a click. The renderer asks every few minutes while the window has
 * focus; this decides whether a fetch actually runs:
 *
 * - at most one per repository every few minutes, whoever asked (several
 *   panes, a subfolder of it, another worktree of it, or a click just now, all
 *   count: they share one set of remote-tracking refs);
 * - after a failure (no network, no credential) it holds off for a while and
 *   says nothing — the next click still fetches and still reports;
 * - never two fetches at once in one repository: a click waits for a background
 *   fetch already running instead of colliding on the remote-tracking refs.
 *
 * `fetchRemotes` is git's non-interactive fetch: a missing credential fails at
 * once rather than waiting on a prompt.
 */

export const BACKGROUND_FETCH_MIN_GAP_MS = 4 * 60_000
export const BACKGROUND_FETCH_HOLD_OFF_MS = 30 * 60_000

const lastFetchAt = new Map<string, number>()
const holdOffUntil = new Map<string, number>()
const inFlight = new Map<string, Promise<unknown>>()
/** A background fetch between its checks and its fetch. */
const claimed = new Set<string>()
/** Per repository: when a fetch last went through (a failed one moves no refs). */
const fetchedAt = new Map<string, number>()
/** Per workspace folder: the repository's fetch it last knew of. */
const seenFetchAt = new Map<string, number>()

function folderKey(path: string): string {
  const canonical = canonicalizeWorkspacePath(path)
  return isWindowsStylePath(canonical) ? canonical.toLowerCase() : canonical
}

/**
 * The repository's shared git folder, where the remote-tracking refs live: the
 * same for a subfolder and for every worktree of one repository. Found the way
 * git finds it, without running git; the folder itself when there is none.
 *
 * Realpath'd, because the same repository is spelled differently depending on
 * who asks: a worktree's `.git` pointer carries the real path git wrote, while
 * the caller passes its own spelling — `/var` against `/private/var` on macOS,
 * where the two are the same directory. Without this a worktree and its parent
 * became two repositories as far as the fetch bookkeeping goes, so each
 * fetched, and each decided the other's refs had moved.
 */
function repoKey(workspacePath: string): string {
  const dirs = resolveGitDirs(workspacePath)
  const raw = dirs ? dirs.commonDir : workspacePath
  let real = raw
  try {
    real = realpathSync(raw)
  } catch {
    // A repository that is gone keeps its resolved spelling.
  }
  return folderKey(real)
}

/** @internal */
export function resetBackgroundFetchForTests(): void {
  lastFetchAt.clear()
  holdOffUntil.clear()
  inFlight.clear()
  claimed.clear()
  fetchedAt.clear()
  seenFetchAt.clear()
}

/**
 * Run `fetch` as the only fetch in this repository, after any one already under
 * way. A fetch that went through counts from when it was asked for (`askedAt`),
 * so the gap is the same however long the network took.
 */
export async function exclusiveFetch<T>(
  workspacePath: string,
  fetch: () => Promise<T>,
  askedAt = Date.now()
): Promise<T> {
  const key = repoKey(workspacePath)
  for (let prior = inFlight.get(key); prior; prior = inFlight.get(key)) {
    await prior.catch(() => undefined)
  }
  const run = fetch()
  inFlight.set(key, run)
  try {
    const result = await run
    lastFetchAt.set(key, askedAt)
    fetchedAt.set(key, askedAt)
    seenFetchAt.set(folderKey(workspacePath), askedAt)
    holdOffUntil.delete(key)
    return result
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key)
  }
}

export type BackgroundFetchOutcome = GitFetchOutcome & {
  skipped?: boolean
  /** Skipped, but another workspace of the repository fetched since this one last asked. */
  refsMoved?: boolean
  /** The branch's ahead/behind counts moved: worth telling the renderer. */
  changed?: boolean
}

export async function backgroundFetch(workspacePath: string, now = Date.now()): Promise<BackgroundFetchOutcome> {
  const key = repoKey(workspacePath)
  if (inFlight.has(key) || claimed.has(key)) return { detail: 'A fetch is already running', skipped: true }
  const last = lastFetchAt.get(key)
  if (last !== undefined && now - last < BACKGROUND_FETCH_MIN_GAP_MS) {
    // Fetched from another worktree or subfolder of this repository: nothing to
    // fetch, but this one has not read the counts that fetch moved.
    const folder = folderKey(workspacePath)
    const fetched = fetchedAt.get(key)
    const seen = seenFetchAt.get(folder)
    const refsMoved = fetched !== undefined && (seen === undefined || seen < fetched)
    if (fetched !== undefined) seenFetchAt.set(folder, fetched)
    return { detail: 'Fetched a moment ago', skipped: true, ...(refsMoved ? { refsMoved } : {}) }
  }
  const holdOff = holdOffUntil.get(key)
  if (holdOff !== undefined && now < holdOff) return { detail: 'Held off after a failed fetch', skipped: true }
  // Claimed before the first await: two panes asking on one tick get one fetch.
  claimed.add(key)
  try {
    if (!isGitRepo(workspacePath) || !(await hasGitRemote(workspacePath))) return { detail: 'No remote to fetch', skipped: true }
    const before = await readGitAheadBehind(workspacePath)
    try {
      const result = await exclusiveFetch(workspacePath, () => fetchRemotes(workspacePath), now)
      const changed = before?.ahead !== result.ahead || before?.behind !== result.behind
      return { ...result, changed }
    } catch (err) {
      lastFetchAt.set(key, now)
      holdOffUntil.set(key, now + BACKGROUND_FETCH_HOLD_OFF_MS)
      throw err
    }
  } finally {
    claimed.delete(key)
  }
}
