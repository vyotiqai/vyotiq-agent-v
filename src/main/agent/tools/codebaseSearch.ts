import { runCodebaseSearch } from '../codeindex'
import { DEFAULT_SEARCH_LIMIT } from '../codeindex/types'
import { isAbortError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'

export { DEFAULT_SEARCH_LIMIT as CODEBASE_SEARCH_DEFAULT_LIMIT }

/**
 * The caller's hide predicate, remembering which matching files it kept out,
 * and the line that says so — grep's wording, so the model reads one rule.
 */
export function hiddenSearchPaths(hidePath: ((rel: string) => boolean) | undefined): {
  hidePath: ((rel: string) => boolean) | undefined
  note: () => string
} {
  if (!hidePath) return { hidePath: undefined, note: () => '' }
  const hidden = new Set<string>()
  return {
    hidePath: (rel) => {
      const hide = hidePath(rel)
      if (hide) hidden.add(rel)
      return hide
    },
    note: () => {
      const count = hidden.size
      if (count === 0) return ''
      return `\n\n${count} matching file${count === 1 ? '' : 's'} left out: a permission rule denies or asks before reading ${count === 1 ? 'it' : 'them'} (read one directly to ask)`
    }
  }
}

/** Ranked keyword codebase search over the local SQLite trigram index. */
export async function toolCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: {
    maxResults?: number
    refresh?: boolean
    signal?: AbortSignal
    /** Files a permission rule keeps from search (permissions.ts hidesFromSearch). */
    hidePath?: (rel: string) => boolean
  } = {}
): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error('codebase_search query is required')
  const hidden = hiddenSearchPaths(opts.hidePath)
  let result: Awaited<ReturnType<typeof runCodebaseSearch>>
  try {
    result = await runCodebaseSearch(workspaceRoot, q, {
      limit: opts.maxResults ?? DEFAULT_SEARCH_LIMIT,
      refresh: opts.refresh === true,
      signal: opts.signal,
      hidePath: hidden.hidePath
    })
  } catch (err) {
    // No hits could be produced at all (store absent or index sync failed).
    // Surface an actionable message instead of a raw error string; aborts rethrow.
    if (isAbortError(err) || opts.signal?.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('codeindex: codebase_search produced no results', {
      scope: 'codeindex',
      reason
    })
    return `codebase_search unavailable: ${reason}. The index may still be warming — retry shortly or pass refresh:true to force a sync.`
  }
  const { formatted, status, hits } = result
  if (!status.ready && status.chunkCount === 0 && formatted.includes('disabled')) {
    return formatted
  }
  const header = `index: ${status.chunkCount} chunks / ${status.fileCount} files · hits=${hits.length}`
  return `${header}\n\n${formatted}${hidden.note()}`
}
