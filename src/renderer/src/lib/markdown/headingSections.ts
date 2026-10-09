import { isFenceCloser, parseFenceLine, type FenceOpen } from './fenceUtils'

const HEADING_LINE = /^ {0,3}(#{1,6})[ \t]+\S/

/**
 * Each heading's section, by the line it is on: the heading and everything
 * under it up to the next heading of its level or above, as written. Headings
 * inside a fence are code, not sections.
 */
export function headingSections(markdown: string): Map<number, string> {
  const lines = markdown.split('\n')
  const heads: { line: number; level: number }[] = []
  let open: FenceOpen | null = null
  lines.forEach((text, i) => {
    if (open) {
      if (isFenceCloser(text, open)) open = null
      return
    }
    const fence = parseFenceLine(text)
    if (fence) {
      open = fence.open
      return
    }
    const m = HEADING_LINE.exec(text)
    if (m) heads.push({ line: i, level: m[1]!.length })
  })
  const out = new Map<number, string>()
  heads.forEach((head, k) => {
    const next = heads.slice(k + 1).find((h) => h.level <= head.level)
    out.set(head.line, lines.slice(head.line, next ? next.line : lines.length).join('\n').trim())
  })
  return out
}
