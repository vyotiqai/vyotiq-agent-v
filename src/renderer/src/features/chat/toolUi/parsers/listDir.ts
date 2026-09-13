import type { UiToolRow } from '@shared/transcript'
import { formatDisplaySize } from '@shared/utils/displayPath'
import { parseArgsRecord } from '@shared/toolSummary'

export type DirEntry = {
  kind: 'dir' | 'file'
  name: string
  size: string
}

export type ListDirParsed = {
  path: string
  totalEntries: number
  entries: DirEntry[]
  truncated: boolean
}

export function parseListDirData(tool: UiToolRow): ListDirParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const path =
    typeof args?.path === 'string' && args.path.trim() ? args.path : '.'
  const content = tool.content ?? ''

  if (content.endsWith('is empty')) {
    return { path, totalEntries: 0, entries: [], truncated: false }
  }

  const lines = content.split('\n')
  const header = lines[0] ?? ''
  const countMatch = header.match(/\((\d+) entries\)/)
  const totalEntries = countMatch ? Number(countMatch[1]) : 0
  const truncated = content.includes('more entries')

  const entries: DirEntry[] = []
  for (const line of lines.slice(1)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('…')) continue

    const dirMatch = trimmed.match(/^\[dir\]\s+(.+?)\/?$/)
    if (dirMatch) {
      entries.push({ kind: 'dir', name: dirMatch[1]!, size: '' })
      continue
    }

    const fileWithSize = trimmed.match(/^\[file\]\s+(.+)\s+\(([^)]+)\)$/)
    if (fileWithSize) {
      entries.push({
        kind: 'file',
        name: fileWithSize[1]!.trim(),
        size: formatDisplaySize(fileWithSize[2]!)
      })
      continue
    }

    const fileBare = trimmed.match(/^\[file\]\s+(.+)$/)
    if (fileBare) {
      entries.push({ kind: 'file', name: fileBare[1]!.trim(), size: '' })
    }
  }

  return { path, totalEntries, entries, truncated }
}
