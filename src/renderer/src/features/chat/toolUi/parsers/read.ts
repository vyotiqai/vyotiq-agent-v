import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import { splitLines } from './common'

export type ReadParsed = {
  path: string
  lineRange: string
  isDirectory: boolean
  lines: string[]
  /** 1-based line number for the first content line (from args or `--- lines ---` header). */
  startLine: number
}

const READ_LINES_HEADER_RE = /^--- lines (\d+)-(\d+) of (\d+) ---\n?/

export function parseReadLineRange(tool: UiToolRow): string {
  if (tool.status === 'fail') return ''
  const args = parseArgsRecord(tool.argsPreview)
  const start = typeof args?.startLine === 'number' ? args.startLine : null
  const end = typeof args?.endLine === 'number' ? args.endLine : null
  if (start != null || end != null) {
    return end == null ? `L${start}+` : `L${start ?? 1}-${end}`
  }
  if (tool.contentTruncated || !tool.content) return ''
  const header = READ_LINES_HEADER_RE.exec(tool.content)
  if (header) {
    return `L${header[1]}-${header[2]}`
  }
  const body = tool.content.replace(READ_LINES_HEADER_RE, '')
  const lines = splitLines(body)
  return lines.length > 0 ? `L1-${lines.length}` : ''
}

/** The body only renders a clamped preview — never retain past this many lines. */
export const READ_PARSE_LINE_BUDGET = 500

export function parseReadData(tool: UiToolRow): ReadParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path = typeof args?.path === 'string' ? args.path : tool.summary?.trim() || ''
  if (tool.status === 'fail') {
    return { path, lineRange: '', isDirectory: false, lines: [], startLine: 1 }
  }
  const content = tool.content ?? ''
  const isDirectory = content.startsWith('Path is a directory')

  const argsStart =
    typeof args?.startLine === 'number' && Number.isFinite(args.startLine) && args.startLine > 0
      ? Math.floor(args.startLine)
      : null
  let startLine = argsStart ?? 1

  let lines: string[] = []
  if (!isDirectory && content) {
    const header = READ_LINES_HEADER_RE.exec(content)
    const body = header ? content.slice(header[0].length) : content
    if (argsStart == null && header) {
      const fromHeader = Number(header[1])
      if (Number.isFinite(fromHeader) && fromHeader > 0) startLine = fromHeader
    }
    lines = splitLines(body).slice(0, READ_PARSE_LINE_BUDGET)
  } else if (isDirectory) {
    const contentsIdx = content.indexOf('Contents:')
    if (contentsIdx >= 0) {
      const after = content.slice(contentsIdx + 'Contents:'.length).trim()
      lines = after
        .split('\n')
        .filter((l) => l.startsWith('[dir]') || l.startsWith('[file]'))
        .slice(0, READ_PARSE_LINE_BUDGET)
    }
  }

  return { path, lineRange: parseReadLineRange(tool), isDirectory, lines, startLine }
}
