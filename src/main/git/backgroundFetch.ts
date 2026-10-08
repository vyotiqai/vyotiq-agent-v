import { canonicalizeWorkspacePath, isWindowsStylePath } from '../../shared/workspacePath'
import { fetchRemotes, hasGitRemote, isGitRepo, readGitAheadBehind, type GitFetchOutcome } from './git'

/**
 * The app's own periodic fetch, so ahead/behind and "N to pull" stay true
 * without a click. The renderer asks every few minutes while the window has
 * focus; this decides whether a fetch actually runs:
 *
 * - at most one per checkout every few minutes, whoever asked (several panes
 *   on one checkout, or a click just now, all count);
 * - after a failure (no network, no credential) it holds off for a while and
 *   says nothing — the next click still fetches and still reports;
 * - never two fetches at once in one checkout: a click waits for a background
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

function checkoutKey(workspacePath: string): string {
  const path = canonicalizeWorkspacePath(workspacePath)
  return isWindowsStylePath(path) ? path.toLowerCase() : path
}

/** @internal */
export function resetBackgroundFetchForTests(): void {
  lastFetchAt.clear()
  holdOffUntil.clear()
  inFlight.clear()
}

/**
 * Run `fetch` as the only fetch in this checkout, after any one already under
 * way. A fetch that went through counts from when it was asked for (`askedAt`),
 * so the gap is the same however long the network took.
 */
export async function exclusiveFetch<T>(
  workspacePath: string,
  fetch: () => Promise<T>,
  askedAt = Date.now()
): Promise<T> {
  const key = checkoutKey(workspacePath)
  for (let prior = inFlight.get(key); prior; prior = inFlight.get(key)) {
    await prior.catch(() => undefined)
  }
  const run = fetch()
  inFlight.set(key, run)
  try {
    const result = await run
    lastFetchAt.set(key, askedAt)
    holdOffUntil.delete(key)
    return result
  } finally {
    if (inFlight.get(key) === run) inFlight.delete(key)
  }
}

export type BackgroundFetchOutcome = GitFetchOutcome & {
  skipped?: boolean
  /** The branch's ahead/behind counts moved: worth telling the renderer. */
  changed?: boolean
}

export async function backgroundFetch(workspacePath: string, now = Date.now()): Promise<BackgroundFetchOutcome> {
  const key = checkoutKey(workspacePath)
  if (inFlight.has(key)) return { detail: 'A fetch is already running', skipped: true }
  const last = lastFetchAt.get(key)
  if (last !== undefined && now - last < BACKGROUND_FETCH_MIN_GAP_MS) return { detail: 'Fetched a moment ago', skipped: true }
  const holdOff = holdOffUntil.get(key)
  if (holdOff !== undefined && now < holdOff) return { detail: 'Held off after a failed fetch', skipped: true }
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
}
