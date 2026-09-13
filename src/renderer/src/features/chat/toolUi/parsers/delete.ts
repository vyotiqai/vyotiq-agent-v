import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type DeleteParsed = {
  path: string
  recursive: boolean
  message: string
}

export function parseDeleteData(tool: UiToolRow): DeleteParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const recursive = args?.recursive === true
  const message = (tool.content ?? '').trim() || `Deleted ${path}`
  return { path, recursive, message }
}
