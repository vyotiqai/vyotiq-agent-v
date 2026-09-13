import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type GlobParsed = {
  pattern: string
  paths: string[]
  truncated: boolean
  nested: boolean
}

function isGlobFooterLine(line: string): boolean {
  const t = line.trim()
  return (
    !t ||
    t.startsWith('…') ||
    t.startsWith('index=') ||
    t.startsWith('scan cap') ||
    t.startsWith('index sync')
  )
}

export function parseGlobData(tool: UiToolRow): GlobParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const pattern =
    typeof args?.pattern === 'string' ? args.pattern : tool.summary?.trim() || ''
  const content = tool.content ?? ''

  if (content.startsWith('No files match')) {
    const lines = content.split('\n')
    const start = lines.findIndex((l) => l.trim() === 'Nested matches:')
    if (start < 0) return { pattern, paths: [], truncated: false, nested: false }
    const paths: string[] = []
    let truncated = false
    for (const line of lines.slice(start + 1)) {
      const t = line.trim()
      if (isGlobFooterLine(t)) {
        if (t.startsWith('…')) truncated = true
        continue
      }
      paths.push(t)
    }
    return { pattern, paths, truncated, nested: true }
  }

  const lines = content.split('\n').filter((l) => l.trim() && !isGlobFooterLine(l))
  const truncated =
    content.includes('more (raise maxResults') || content.includes('scan cap')
  return { pattern, paths: lines, truncated, nested: false }
}
