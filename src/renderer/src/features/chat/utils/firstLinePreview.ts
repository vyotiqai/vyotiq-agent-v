/** Collapsed disclosure preview: first non-empty line, word-boundary ellipsis. */
export function firstLinePreview(content: string, maxChars = 120): string {
  const firstLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean)
    ?.replace(/\s+/g, ' ')

  if (!firstLine) return ''
  if (firstLine.length <= maxChars) return firstLine
  const cut = firstLine.slice(0, maxChars)
  const atWord = cut.lastIndexOf(' ')
  const base = (atWord > maxChars * 0.6 ? cut.slice(0, atWord) : cut).trimEnd()
  return `${base}…`
}
