import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type WebFetchParsed = {
  url: string
  content: string
}

export function parseWebFetchData(tool: UiToolRow): WebFetchParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const url = typeof args?.url === 'string' ? args.url : tool.summary?.trim() || ''
  return { url, content: tool.content ?? '' }
}
