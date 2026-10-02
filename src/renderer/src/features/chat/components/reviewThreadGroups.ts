import type { PrReviewThread } from '@shared/ipc'

/** The line a thread points at now, or where it was made once the code moved on. */
export function reviewThreadLine(thread: PrReviewThread): number | null {
  return thread.line ?? thread.originalLine
}

/** One file's threads, in line order. */
export type ReviewThreadGroup = {
  path: string
  threads: PrReviewThread[]
}

export type ReviewThreadGroups = {
  groups: ReviewThreadGroup[]
  unresolved: PrReviewThread[]
  resolvedCount: number
}

function byLine(a: PrReviewThread, b: PrReviewThread): number {
  const la = reviewThreadLine(a)
  const lb = reviewThreadLine(b)
  // A thread on the whole file (no line) leads its file.
  if (la == null || lb == null) return la == null ? (lb == null ? 0 : -1) : 1
  return la - lb
}

/**
 * Threads grouped by file — files in path order, each file's threads by line.
 * Resolved threads are counted and left out unless `showResolved`.
 * `unresolved` keeps the same order, for "Address all unresolved".
 */
export function groupReviewThreads(
  threads: readonly PrReviewThread[],
  opts: { showResolved?: boolean } = {}
): ReviewThreadGroups {
  const byPath = new Map<string, PrReviewThread[]>()
  let resolvedCount = 0
  for (const thread of threads) {
    if (thread.isResolved) {
      resolvedCount += 1
      if (!opts.showResolved) continue
    }
    const list = byPath.get(thread.path)
    if (list) list.push(thread)
    else byPath.set(thread.path, [thread])
  }
  const groups = [...byPath.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, list]) => ({ path, threads: [...list].sort(byLine) }))
  const unresolved = groups.flatMap((g) => g.threads.filter((t) => !t.isResolved))
  return { groups, unresolved, resolvedCount }
}
