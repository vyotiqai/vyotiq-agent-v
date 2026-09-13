import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { parseWebSearchData } from './webSearch'

export type WebSearchSource = {
  title: string
  url: string
  domain: string
}

export type WebSearchTimelineItem = {
  id: string
  name: string
  status: 'running' | 'done' | 'fail'
  kind: 'search' | 'read'
  host: string
  query: string
  count: number | null
  failed: boolean
  sources: WebSearchSource[]
}

const TIMELINE_TOOL_NAMES = new Set(['web_search', 'browser_search', 'web_fetch'])

export function isWebSearchTimelineToolName(name: string): boolean {
  return TIMELINE_TOOL_NAMES.has(name)
}

export function isWebSearchTimelineGroup(tools: ReadonlyArray<{ name: string }>): boolean {
  return tools.length > 0 && tools.every((tool) => isWebSearchTimelineToolName(tool.name))
}

function hostFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function domainFromUrl(raw: string): string {
  try {
    return new URL(raw).hostname
  } catch {
    return ''
  }
}

/**
 * Timeline item for the web-search family of tools. Additive parser only — the
 * underlying tool content grammars live in parsers/webSearch.ts (legacy hits),
 * parsers/browser.ts (`Navigated to <url>` preamble) and parsers/webFetch.ts.
 */
export function parseWebSearchTimelineItem(tool: UiToolRow): WebSearchTimelineItem {
  const args = parseArgsRecord(tool.argsPreview)
  const content = tool.content ?? ''
  const isFetch = tool.name === 'web_fetch'

  let host = ''
  let query = ''
  let count: number | null = null
  let sources: WebSearchSource[] = []

  if (isFetch) {
    // web_fetch: everything comes from the args record; content is page text.
    const url = typeof args?.url === 'string' ? args.url.trim() : ''
    host = url ? hostFromUrl(url) : ''
    query = url || tool.summary?.trim() || ''
  } else if (tool.name === 'browser_search') {
    // browser_search: target host from the navigate preamble only — snapshot
    // body links are not structured and are not guessed.
    const navUrl = /^Navigated to\s+(\S+)/im.exec(content)?.[1] ?? ''
    host = navUrl ? hostFromUrl(navUrl) : ''
    query = typeof args?.query === 'string' ? args.query : tool.summary?.trim() || ''
    // Conservative count: only when the snapshot literally states a number.
    const stated = /\b(?:About\s+)?([\d,]{1,15})\s+results\b/i.exec(content)
    if (stated) count = Number.parseInt(stated[1]!.replace(/,/g, ''), 10)
  } else {
    // Legacy web_search: reuse the existing hit grammar.
    const parsed = parseWebSearchData(tool)
    query = parsed.query
    sources = parsed.hits.map((hit) => ({
      title: hit.title,
      url: hit.url,
      domain: hit.url ? domainFromUrl(hit.url) : ''
    }))
    if (parsed.hits.length > 0) count = parsed.hits.length
    else if (/\bNo results\.?\b/i.test(content)) count = 0
  }

  return {
    id: tool.id,
    name: tool.name,
    status: tool.status,
    kind: isFetch ? 'read' : 'search',
    host,
    query,
    count,
    failed:
      tool.status === 'fail' ||
      // Same failure vocabulary as parseBrowserActionData; interrupted-run
      // markers are handled upstream by isInterruptedToolContent.
      /timed out|failed|unknown snapshot ref|not interactable|ssrf|blocked|ERR_|CONNECTION_REFUSED/i.test(
        content
      ),
    sources
  }
}
