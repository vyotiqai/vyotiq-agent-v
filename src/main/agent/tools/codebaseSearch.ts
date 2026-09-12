import { runCodebaseSearch } from '../codeindex'
import { DEFAULT_SEARCH_LIMIT } from '../codeindex/types'
import { isAbortError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'

export { DEFAULT_SEARCH_LIMIT as CODEBASE_SEARCH_DEFAULT_LIMIT }

/** Ranked keyword codebase search over the local SQLite trigram index. */
export async function toolCodebaseSearch(
  workspaceRoot: string,
  query: string,
  opts: {
    maxResults?: number
    refresh?: boolean
    signal?: AbortSignal
  } = {}
): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error('codebase_search query is required')
  let result: Awaited<ReturnType<typeof runCodebaseSearch>>
  try {
    result = await runCodebaseSearch(workspaceRoot, q, {
      limit: opts.maxResults ?? DEFAULT_SEARCH_LIMIT,
      refresh: opts.refresh === true,
      signal: opts.signal
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
  return `${header}\n\n${formatted}`
}
