import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type GrepMatch = {
  line: number
  text: string
  isMatch: boolean
}

export type GrepFileGroup = {
  file: string
  matches: GrepMatch[]
}

export type GrepParsed = {
  pattern: string
  matchCount: number
  truncated: boolean
  groups: GrepFileGroup[]
}

/** The body only renders a scrolled preview — never parse past this many lines. */
export const GREP_PARSE_LINE_BUDGET = 400

export function parseGrepData(tool: UiToolRow): GrepParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const pattern =
    typeof args?.pattern === 'string' ? args.pattern : tool.summary?.trim() || ''
  const content = tool.content ?? ''

  if (content.startsWith('No matches for')) {
    return { pattern, matchCount: 0, truncated: false, groups: [] }
  }

  const lines = content.split('\n')
  const budgetCapped = lines.length > GREP_PARSE_LINE_BUDGET
  const truncated =
    (content.includes('stopped at') && content.includes('matches')) ||
    content.includes('scan cap') ||
    budgetCapped

  const groups: GrepFileGroup[] = []
  let current: GrepFileGroup | null = null
  let matchCount = 0

  for (let i = 0; i < Math.min(lines.length, GREP_PARSE_LINE_BUDGET); i += 1) {
    const line = lines[i]!.trimEnd()
    if (!line || line.startsWith('…') || line.startsWith('index=')) continue

    const simple = line.match(/^(.+?):(\d+):\s*(.*)$/)
    if (simple) {
      matchCount += 1
      const [, file, lineNum, text] = simple
      if (current && current.file === file) {
        current.matches.push({ line: Number(lineNum), text: text!, isMatch: true })
      } else {
        current = {
          file: file!,
          matches: [{ line: Number(lineNum), text: text!, isMatch: true }]
        }
        groups.push(current)
      }
      continue
    }

    const header = line.match(/^(.+?):(\d+)$/)
    if (header) {
      current = { file: header[1]!, matches: [] }
      groups.push(current)
      continue
    }

    const ctx = line.match(/^([> ])\s*(\d+)\|\s*(.*)$/)
    if (ctx && current) {
      const [, marker, lineNum, text] = ctx
      current.matches.push({ line: Number(lineNum), text: text!, isMatch: marker === '>' })
      if (marker === '>') matchCount += 1
    }
  }

  return { pattern, matchCount, truncated, groups }
}
