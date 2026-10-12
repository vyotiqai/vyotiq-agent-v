/**
 * Which pieces of workspace text bear on one instruction. Plain word overlap,
 * not embeddings: the structurer runs on a click and must answer in seconds,
 * and what it needs is "the rule about the composer" for a composer request,
 * not a ranking good enough for search.
 */

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can could did do does doing done for from get got had has have how i if in ' +
    'into is it its just let like make me more most my need no not now of on or our out please should so some ' +
    'than that the their them then there these they this those to too up us use very want was we were what when ' +
    'where which while who why will with would you your yours also all any each every thing things stuff really ' +
    'actually maybe kind sort way want wants wanted know okay ok yeah hey hi hello thanks thank'
  ).split(' ')
)

/** One word to its comparable stem: lowercase, a few English suffixes off. */
function stem(word: string): string {
  let w = word.toLowerCase()
  if (w.length > 5 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`
  else if (w.length > 5 && w.endsWith('ing')) w = w.slice(0, -3)
  else if (w.length > 4 && w.endsWith('ed')) w = w.slice(0, -2)
  // "fixes" → "fix", but "files" → "file".
  else if (w.length > 4 && /(?:sh|ch|x|ss|z)es$/.test(w)) w = w.slice(0, -2)
  else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1)
  return w
}

/**
 * The significant words of a text as stems. camelCase and path segments split,
 * so `ComposerMentionInput.tsx` matches "composer" and "mention".
 */
export function significantTerms(text: string): Set<string> {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
  const out = new Set<string>()
  for (const raw of spaced.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 3) continue
    const lower = raw.toLowerCase()
    if (STOPWORDS.has(lower) || /^\d+$/.test(lower)) continue
    out.add(stem(lower))
  }
  return out
}

/** How many of the query's terms the text holds. */
export function overlapScore(query: ReadonlySet<string>, text: string | ReadonlySet<string>): number {
  if (query.size === 0) return 0
  const terms = typeof text === 'string' ? significantTerms(text) : text
  let score = 0
  for (const term of query) if (terms.has(term)) score += 1
  return score
}

export type Chunk = { text: string; heading?: string }

/** Markdown split at its headings; each chunk keeps its heading line. */
export function chunkMarkdown(text: string): Chunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const chunks: Chunk[] = []
  let current: string[] = []
  let heading: string | undefined
  let inFence = false
  const flush = (): void => {
    const body = current.join('\n').trim()
    if (body) chunks.push(heading ? { text: body, heading } : { text: body })
    current = []
  }
  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence
    const h = !inFence ? /^(#{1,4})\s+(.+?)\s*#*\s*$/.exec(line) : null
    if (h) {
      flush()
      heading = h[2]
    }
    current.push(line)
  }
  flush()
  return chunks
}

/** Cut at a line boundary, saying how much is left. */
export function capAtLine(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.lastIndexOf('\n', max)
  const head = text.slice(0, cut > max * 0.5 ? cut : max).trimEnd()
  return `${head}\n… (${text.length - head.length} more characters)`
}

/**
 * The chunks that bear on the query, best first until the budget is spent,
 * then put back in their original order so they still read as written. A
 * chunk's heading counts double: "## Composer" is about the composer.
 * Everything fits → everything goes, in order; nothing matches → nothing.
 */
export function selectRelevant<T extends Chunk>(chunks: readonly T[], query: ReadonlySet<string>, budget: number): T[] {
  const total = chunks.reduce((sum, c) => sum + c.text.length + 2, 0)
  if (total <= budget) return [...chunks]
  const scored = chunks
    .map((chunk, index) => ({
      chunk,
      index,
      score: overlapScore(query, chunk.text) + (chunk.heading ? overlapScore(query, chunk.heading) : 0)
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
  const kept: Array<{ chunk: T; index: number }> = []
  let room = budget
  for (const s of scored) {
    if (room <= 200) break
    const text = s.chunk.text.length + 2 <= room ? s.chunk.text : capAtLine(s.chunk.text, room - 2)
    kept.push({ chunk: { ...s.chunk, text }, index: s.index })
    room -= text.length + 2
  }
  return kept.sort((a, b) => a.index - b.index).map((k) => k.chunk)
}
