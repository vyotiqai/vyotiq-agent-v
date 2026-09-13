import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type SearchHit = {
  file: string
  line: number | null
  snippet: string
  isFilenameHit: boolean
}

export type SearchParsed = {
  query: string
  hits: SearchHit[]
  truncated: boolean
}

export function parseSearchData(tool: UiToolRow): SearchParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const query =
    typeof args?.query === 'string' ? args.query : tool.summary?.trim() || ''
  const content = tool.content ?? ''

  if (content.startsWith('No matches for')) {
    return { query, hits: [], truncated: false }
  }

  const truncated =
    (content.includes('stopped at') && content.includes('matches')) ||
    content.includes('scan cap')
  const hits: SearchHit[] = []
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('…') || trimmed.startsWith('index=')) continue

    const fileHit = trimmed.match(/^file:\s*(.+)$/)
    if (fileHit) {
      hits.push({ file: fileHit[1]!, line: null, snippet: '', isFilenameHit: true })
      continue
    }

    const contentHit = trimmed.match(/^(.+?):(\d+):\s*(.*)$/)
    if (contentHit) {
      hits.push({
        file: contentHit[1]!,
        line: Number(contentHit[2]),
        snippet: contentHit[3]!,
        isFilenameHit: false
      })
    }
  }

  return { query, hits, truncated }
}
