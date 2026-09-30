import { isSafeWorkspaceRelPath } from '../../shared/utils/workspacePath'

/**
 * What the @-mention and Ctrl K pickers rank out of one workspace walk: the
 * matching files, the matching directories, and how many files matched before
 * slicing. Pure — the walk and the cache own the I/O, this owns the order.
 *
 * Both lists are ranked the same way: a path whose own segment starts with the
 * query outranks one that merely contains it, then paths compare by name. The
 * lists are ranked independently, so adding directories cannot reorder the file
 * rows the pickers already showed.
 */
export type SuggestPathsResult = {
  paths: string[]
  dirs: string[]
  /** File matches before slicing to maxResults. */
  total: number
}

/** Query as the walk-relative paths spell it: trimmed, forward slashes, folded case. */
function normalizeQuery(query: string | undefined): string {
  return (query ?? '').trim().toLowerCase().replace(/\\/g, '/')
}

/**
 * A path typed as a whole segment — `foo` matches `src/foo`, not `src/foobar/…`
 * — beats one that only contains the query somewhere. This is the ordering the
 * file picker shipped with; directories get it too so the two read as one list.
 */
function hitsAsSegment(rel: string, query: string): boolean {
  const lower = rel.toLowerCase()
  return lower.includes(`/${query}`) || lower.startsWith(query)
}

function rank(list: readonly string[], query: string, maxResults: number): string[] {
  const matched = list.filter((rel) => {
    if (!isSafeWorkspaceRelPath(rel)) return false
    return query ? rel.toLowerCase().includes(query) : true
  })
  if (!query) {
    matched.sort((a, b) => a.localeCompare(b))
    return matched.slice(0, maxResults)
  }
  matched.sort((a, b) => {
    const aSegment = hitsAsSegment(a, query)
    const bSegment = hitsAsSegment(b, query)
    if (aSegment !== bSegment) return aSegment ? -1 : 1
    return a.localeCompare(b)
  })
  return matched.slice(0, maxResults)
}

/**
 * The paths a suggest query answers with, from one walk's two lists.
 *
 * `total` counts file matches only, because it is what the pickers page on: a
 * "load more" asks for a bigger `maxResults`, and files fill that budget first.
 * Dirs are sliced to the same cap for the same reason — a broad query would
 * otherwise ship every directory in the workspace to render eight rows.
 */
export function rankSuggestPaths(
  files: readonly string[],
  dirs: readonly string[],
  query: string | undefined,
  maxResults: number
): SuggestPathsResult {
  const normalized = normalizeQuery(query)
  const cap = Math.max(1, Math.floor(maxResults))
  return {
    paths: rank(files, normalized, cap),
    dirs: rank(dirs, normalized, cap),
    total: files.reduce(
      (count, rel) =>
        count + (isSafeWorkspaceRelPath(rel) && (!normalized || rel.toLowerCase().includes(normalized)) ? 1 : 0),
      0
    )
  }
}