/** Top-level harness section tags. Cap/split only these — never arbitrary `<tag>` (the spine cites `mcp__<serverId>__<toolName>`). */
export const HARNESS_SECTION_TAGS = [
  'role',
  'capabilities',
  'tool_policy',
  'constraints',
  'work_style',
  'memory',
  'compaction',
  'output_format',
  'patterns',
  'reference_points',
  'scope_boundaries',
  'aliases',
  'examples',
  'workspace_harness'
] as const

export type HarnessSectionTag = (typeof HARNESS_SECTION_TAGS)[number]

const HARNESS_TAG_SET: ReadonlySet<string> = new Set(HARNESS_SECTION_TAGS)

export type HarnessSectionChunk = {
  /** XML tag, markdown heading text, or empty for a title/prefix chunk. */
  name: string
  text: string
}

function harnessOpenTagRe(): RegExp {
  return new RegExp(`<(${HARNESS_SECTION_TAGS.join('|')})>`, 'g')
}

function isHarnessSectionTag(value: string): value is HarnessSectionTag {
  return HARNESS_TAG_SET.has(value)
}

function findNextXmlOpen(
  text: string,
  from: number
): { index: number; tag: HarnessSectionTag } | null {
  const re = harnessOpenTagRe()
  re.lastIndex = from
  const m = re.exec(text)
  const tag = m?.[1]
  if (!m || tag === undefined || !isHarnessSectionTag(tag)) return null
  return { index: m.index, tag }
}

function findNextMarkdownHeading(
  text: string,
  from: number
): { index: number; heading: string } | null {
  const re = /^##\s+(.+)$/gm
  re.lastIndex = from
  const m = re.exec(text)
  if (!m || m[1] === undefined) return null
  return { index: m.index, heading: m[1].trim() }
}

function skipNewlines(text: string, from: number): number {
  let i = from
  while (i < text.length && (text[i] === '\n' || text[i] === '\r')) i += 1
  return i
}

function hasPairedHarnessTag(text: string): boolean {
  for (const tag of HARNESS_SECTION_TAGS) {
    const open = `<${tag}>`
    const start = text.indexOf(open)
    if (start < 0) continue
    if (text.indexOf(`</${tag}>`, start + open.length) >= 0) return true
  }
  return false
}

/** Markdown heading or a paired allowlist XML tag (workspace copies may use either). */
export function isWellFormedHarness(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  return /^#{1,6}\s+/m.test(t) || hasPairedHarnessTag(t)
}

/**
 * Split a harness into XML allowlist sections and leftover `##` markdown chunks.
 * Unclosed allowlist tags consume the remainder of the string.
 */
export function splitHarnessSections(text: string): HarnessSectionChunk[] {
  if (!text) return []
  const chunks: HarnessSectionChunk[] = []
  let i = 0

  const nextBoundary = (
    from: number
  ):
    | { kind: 'xml'; index: number; tag: HarnessSectionTag }
    | { kind: 'md'; index: number; heading: string }
    | null => {
    const xml = findNextXmlOpen(text, from)
    const md = findNextMarkdownHeading(text, from)
    if (xml && md) {
      if (xml.index <= md.index) return { kind: 'xml', index: xml.index, tag: xml.tag }
      return { kind: 'md', index: md.index, heading: md.heading }
    }
    if (xml) return { kind: 'xml', index: xml.index, tag: xml.tag }
    if (md) return { kind: 'md', index: md.index, heading: md.heading }
    return null
  }

  while (i < text.length) {
    const next = nextBoundary(i)
    if (!next) {
      const rest = text.slice(i).trimEnd()
      if (rest) chunks.push({ name: '', text: rest })
      break
    }
    if (next.index > i) {
      const prefix = text.slice(i, next.index).trimEnd()
      if (prefix) chunks.push({ name: '', text: prefix })
    }
    if (next.kind === 'xml') {
      const open = `<${next.tag}>`
      const close = `</${next.tag}>`
      const closeAt = text.indexOf(close, next.index + open.length)
      const end = closeAt >= 0 ? closeAt + close.length : text.length
      chunks.push({ name: next.tag, text: text.slice(next.index, end).trimEnd() })
      i = skipNewlines(text, end)
      continue
    }
    const following = nextBoundary(next.index + 1)
    const end = following ? following.index : text.length
    chunks.push({ name: next.heading, text: text.slice(next.index, end).trimEnd() })
    i = skipNewlines(text, end)
  }

  return chunks.filter((c) => c.text.length > 0)
}
