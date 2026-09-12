import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type CodebaseSearchHit = {
  path: string
  startLine: number
  endLine: number
  kind: string
  name: string
  score: number
  snippet: string
}

export type CodebaseSearchParsed = {
  query: string
  hits: CodebaseSearchHit[]
}

/** Preview budget for tool body parsing. */
export const CODEBASE_SEARCH_PARSE_HIT_BUDGET = 40

const HIT_HEAD =
  /^(\d+)\.\s+(.+?):(\d+)-(\d+)\s+\[([^\]]+)\](?:\s+score=([0-9.]+))?/

export function parseCodebaseSearchData(tool: UiToolRow): CodebaseSearchParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const query =
    typeof args?.query === 'string' ? args.query : tool.summary?.trim() || ''
  const content = tool.content ?? ''

  if (content.includes('No codebase_search hits')) {
    return { query, hits: [] }
  }

  const hits: CodebaseSearchHit[] = []
  const blocks = content.split(/\n\n+/)
  for (const block of blocks) {
    if (hits.length >= CODEBASE_SEARCH_PARSE_HIT_BUDGET) break
    const lines = block.split('\n')
    const head = lines[0]?.trim() ?? ''
    const m = head.match(HIT_HEAD)
    if (!m) continue
    const kindName = m[5]!.trim()
    const space = kindName.indexOf(' ')
    const kind = space >= 0 ? kindName.slice(0, space) : kindName
    const name = space >= 0 ? kindName.slice(space + 1).replace(/\s*\(.*\)$/, '') : kindName
    hits.push({
      path: m[2]!,
      startLine: Number(m[3]),
      endLine: Number(m[4]),
      kind,
      name,
      score: m[6] ? Number(m[6]) : 0,
      snippet: lines.slice(1).join('\n').trim()
    })
  }

  return { query, hits }
}
