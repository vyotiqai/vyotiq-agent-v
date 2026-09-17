import { runConceptSearch } from '../codeindex'
import { DEFAULT_SEARCH_LIMIT } from '../codeindex/types'
import { isAbortError } from '../../../shared/errors'
import { logger } from '../../../shared/logger'
import type { DenseEmbedder } from '../codeindex/denseJob'

export { DEFAULT_SEARCH_LIMIT as CONCEPT_SEARCH_DEFAULT_LIMIT }

/** Dense semantic (concept) search over the local code-index embeddings. */
export async function toolConceptSearch(
  workspaceRoot: string,
  query: string,
  opts: { maxResults?: number; signal?: AbortSignal; embed?: DenseEmbedder } = {}
): Promise<string> {
  const q = query.trim()
  if (!q) throw new Error('concept_search query is required')
  let result: Awaited<ReturnType<typeof runConceptSearch>>
  try {
    result = await runConceptSearch(workspaceRoot, q, {
      limit: opts.maxResults ?? DEFAULT_SEARCH_LIMIT,
      signal: opts.signal,
      embed: opts.embed
    })
  } catch (err) {
    // Embedding worker/model failures surface as an actionable message instead
    // of a raw error string; aborts rethrow.
    if (isAbortError(err) || opts.signal?.aborted) throw err
    const reason = err instanceof Error ? err.message : String(err)
    logger.warn('codeindex: concept_search produced no results', {
      scope: 'codeindex',
      reason
    })
    return `concept_search unavailable: ${reason}. The embedding model may still be downloading or the index still warming — retry shortly or use codebase_search.`
  }
  const { formatted, status, hits } = result
  if (!status.ready && status.chunkCount === 0 && formatted.includes('disabled')) {
    return formatted
  }
  const header = `index: ${status.chunkCount} chunks / ${status.fileCount} files · hits=${hits.length} (dense)`
  return `${header}\n\n${formatted}`
}