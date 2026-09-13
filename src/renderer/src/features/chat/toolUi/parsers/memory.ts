import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { splitLines } from './common'

export type MemoryListParsed = {
  indexExcerpt: string
  notes: string[]
  hasState: boolean
}

export type MemoryReadParsed = {
  path: string
  lines: string[]
}

export type MemoryWriteParsed = {
  path: string
  preview: string
  charCount: number
}

export function parseMemoryListData(tool: UiToolRow): MemoryListParsed {
  const content = tool.content ?? ''
  const indexMatch = content.match(/## index\.md \(excerpt\)\n([\s\S]*?)\n\n## notes\//i)
  const indexExcerpt = indexMatch?.[1]?.trim() ?? ''
  const notesSection = content.match(/## notes\/\n([\s\S]*?)(?:\n\nstate\.md:|$)/i)
  const notesRaw = notesSection?.[1]?.trim() ?? ''
  const notes =
    notesRaw === '(none)'
      ? []
      : notesRaw
          .split('\n')
          .map((l) => l.replace(/^-\s*/, '').trim())
          .filter(Boolean)
  const hasState = /state\.md:\s*present/i.test(content)
  return { indexExcerpt, notes, hasState }
}

export function parseMemoryReadData(tool: UiToolRow): MemoryReadParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const lines = splitLines(tool.content ?? '')
  return { path, lines }
}

export function parseMemoryWriteData(tool: UiToolRow): MemoryWriteParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  const preview =
    typeof args?.contents === 'string' ? args.contents : (tool.content ?? '').replace(/^Wrote memory\//, '')
  return { path, preview, charCount: preview.length }
}
