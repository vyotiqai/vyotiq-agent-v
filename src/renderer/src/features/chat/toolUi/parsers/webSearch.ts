import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type WebSearchHit = {
  title: string
  url: string
  snippet: string
}

export type WebSearchParsed = {
  query: string
  hits: WebSearchHit[]
}

/**
 * Parse legacy web_search tool content (agent tool removed; keep for old transcripts):
 *
 *   # Web search: query
 *   Found N result(s):
 *   1. Title
 *      url
 *      snippet
 */
export function parseWebSearchData(tool: UiToolRow): WebSearchParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const query =
    typeof args?.query === 'string' ? args.query : tool.summary?.trim() || ''
  const content = tool.content ?? ''
  const hits: WebSearchHit[] = []

  if (!content.trim() || /\bNo results\.?\b/i.test(content)) {
    return { query, hits }
  }

  const lines = content.split('\n')
  let i = 0
  while (i < lines.length) {
    const numbered = lines[i]!.match(/^\d+\.\s+(.+)$/)
    if (!numbered) {
      i += 1
      continue
    }
    const title = numbered[1]!.trim()
    i += 1
    let url = ''
    let snippet = ''
    while (i < lines.length) {
      const line = lines[i]!
      if (/^\d+\.\s+/.test(line)) break
      const trimmed = line.trim()
      i += 1
      if (!trimmed) continue
      if (!url && /^https?:\/\//i.test(trimmed)) {
        url = trimmed
        continue
      }
      if (url && !snippet) {
        snippet = trimmed
        continue
      }
      if (snippet) snippet = `${snippet} ${trimmed}`
    }
    if (title) hits.push({ title, url, snippet })
  }

  return { query, hits }
}
