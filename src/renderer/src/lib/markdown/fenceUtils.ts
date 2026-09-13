export type FenceOpen = { char: '`' | '~'; length: number }

type ParsedFenceLine = { open: FenceOpen; isCloser: boolean; indent: string }

/** Parse a line that may start an indented CommonMark fence (up to 3 spaces). */
export function parseFenceLine(line: string): ParsedFenceLine | null {
  const match = /^ {0,3}(`{3,}|~{3,})([^\S\n]*)(.*)$/.exec(line)
  if (!match) return null
  const marker = match[1]!
  const rest = match[3] ?? ''
  const char = marker[0] as '`' | '~'
  return {
    open: { char, length: marker.length },
    isCloser: rest.trim() === '',
    indent: line.slice(0, line.length - line.trimStart().length)
  }
}

function isFenceCloser(line: string, open: FenceOpen): boolean {
  const parsed = parseFenceLine(line)
  if (!parsed?.isCloser) return false
  return parsed.open.char === open.char && parsed.open.length >= open.length
}

export { isFenceCloser }

/** Walk lines and return the still-open fence, if any. */
export function scanOpenFence(content: string): FenceOpen | null {
  const lines = content.split('\n')
  let open: FenceOpen | null = null

  for (const line of lines) {
    const parsed = parseFenceLine(line)
    if (!parsed) continue
    if (open === null) {
      open = parsed.open
      continue
    }
    if (isFenceCloser(line, open)) {
      open = null
    }
  }

  return open
}

/** Body of the fence still streaming, or null when every fence is closed. */
export function trailingOpenFenceBody(content: string): string | null {
  const lines = content.split('\n')
  let open: FenceOpen | null = null
  let openIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const parsed = parseFenceLine(lines[i]!)
    if (!parsed) continue
    if (open === null) {
      open = parsed.open
      openIndex = i
      continue
    }
    if (isFenceCloser(lines[i]!, open)) {
      open = null
      openIndex = -1
    }
  }

  if (open === null || openIndex < 0) return null
  return lines.slice(openIndex + 1).join('\n')
}

/** Close an unclosed fence so streaming partials still parse as code. */
export function closeOpenFence(content: string): string {
  const lines = content.split('\n')
  let open: FenceOpen | null = null

  for (const line of lines) {
    const parsed = parseFenceLine(line)
    if (!parsed) continue
    if (open === null) {
      open = parsed.open
      continue
    }
    if (isFenceCloser(line, open)) {
      open = null
    }
  }

  if (!open) return content

  // Always append a closer. Replacing a last-line opener (e.g. ```js while a
  // fence is already open) dropped that line for a frame and stripped info strings.
  return `${content}\n${open.char.repeat(open.length)}`
}

function balanceInlineSegment(text: string): string {
  let result = text
  const doubleStars = (result.match(/(?<!\\)\*\*/g) ?? []).length
  if (doubleStars % 2 === 1) result += '**'
  const withoutDouble = result.replace(/(?<!\\)\*\*/g, '\u0000')
  const singles = (withoutDouble.match(/(?<!\\)\*/g) ?? []).length
  if (singles % 2 === 1) result += '*'
  const backticks = (result.match(/(?<!\\)`/g) ?? []).length
  if (backticks % 2 === 1) result += '`'
  return result
}

/** Balance unclosed inline markdown outside fenced regions when a stream completes. */
export function balanceOutsideFences(content: string): string {
  const closed = closeOpenFence(content)
  const lines = closed.split('\n')
  const out: string[] = []
  let open: FenceOpen | null = null
  let outside: string[] = []

  const flushOutside = (): void => {
    if (!outside.length) return
    out.push(...balanceInlineSegment(outside.join('\n')).split('\n'))
    outside = []
  }

  for (const line of lines) {
    if (open === null) {
      const parsed = parseFenceLine(line)
      if (parsed) {
        flushOutside()
        out.push(line)
        open = parsed.open
        continue
      }
      outside.push(line)
      continue
    }

    if (isFenceCloser(line, open)) {
      out.push(line)
      open = null
      continue
    }
    out.push(line)
  }

  flushOutside()
  return out.join('\n')
}
