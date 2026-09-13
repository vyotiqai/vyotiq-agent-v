export function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

export type LineSpan = { text: string; start: number }

/** Last `maxLines` of `text` without splitting the whole document. */
export function splitLinesTail(text: string, maxLines: number): LineSpan[] {
  if (!text || maxLines <= 0) return []
  let end = text.length
  if (text[end - 1] === '\n') end -= 1
  if (end === 0) return []
  const parts: LineSpan[] = []
  let cursor = end
  while (parts.length < maxLines) {
    const nl = text.lastIndexOf('\n', cursor - 1)
    const start = nl < 0 ? 0 : nl + 1
    parts.push({ text: text.slice(start, cursor), start })
    if (nl < 0) break
    cursor = nl
  }
  parts.reverse()
  return parts
}

export function countLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) n++
  }
  if (text.charCodeAt(text.length - 1) === 10) n--
  return n
}

export function truncateText(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 3)}...`
}
