/*
  Splitting an answer into blocks, and making the block still being written
  safe to render.

  A block is what can be parsed on its own and stay the same once written:
  memoised by its text, it never re-renders while later blocks stream in.
  A blank line usually ends one, but not when that would change the
  meaning — a loose list continues past blank lines, an indented line
  belongs to the list item above it, an indented code block keeps its blank
  lines, a fence, a <details> or an HTML comment runs to its closer, and a
  reference is parsed together with its definition. Joining two blocks is
  always safe (it only costs a re-render); splitting one never is, so every
  doubt joins.
*/

export type Block = { source: string; start: number }

type Fence = { char: string; len: number; indent: string }

/** Any indent: a fence in a nested list item is still a fence, and a false one only joins blocks. */
const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/
const LIST_ITEM = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)/
const INDENTED = /^(?: {2,}|\t)\S/
const CODE_INDENT = /^(?: {4}|\t)/
/** `[label]: url` or `[^note]: text`. */
const DEFINITION = /^ {0,3}\[(\^?[^\]]+)\]:/

function opensFence(line: string): Fence | null {
  const m = FENCE.exec(line)
  // A backtick fence's info string cannot hold a backtick.
  if (!m || (m[2]![0] === '`' && m[3]!.includes('`'))) return null
  return { char: m[2]![0]!, len: m[2]!.length, indent: m[1]! }
}

function closesFence(line: string, fence: Fence): boolean {
  const m = FENCE.exec(line)
  return !!m && m[2]![0] === fence.char && m[2]!.length >= fence.len && !m[3]!.trim()
}

/** For each line: inside a fence (its opener and closer included). */
export function fenceMask(lines: string[]): boolean[] {
  let fence: Fence | null = null
  return lines.map((line) => {
    if (fence) {
      if (closesFence(line, fence)) fence = null
      return true
    }
    fence = opensFence(line)
    return fence !== null
  })
}

const withoutCode = (line: string): string => line.replace(/(`+)[^`]*?\1/g, '')

export function splitBlocks(source: string): Block[] {
  if (!source) return []

  const lines = source.split('\n')
  const blocks: Block[] = []
  const labels = new Set<string>()
  let cur: string[] = []
  let start = 0
  let offset = 0
  let fence: Fence | null = null
  let details = 0
  let comment = false
  let list = false

  const hasText = (): boolean => cur.some((l) => l.trim())
  const flush = (at: number): void => {
    if (hasText()) blocks.push({ source: cur.join('\n'), start })
    cur = []
    start = at
    list = false
  }
  /** The next line that is not blank, from `i`. */
  const nextText = (i: number): string | undefined => {
    for (let j = i; j < lines.length; j++) if (lines[j]!.trim()) return lines[j]
    return undefined
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const at = offset
    offset += line.length + 1

    if (fence) {
      cur.push(line)
      if (closesFence(line, fence)) fence = null
      continue
    }

    const open = comment || details > 0 ? null : opensFence(line)
    if (open) {
      // A fence interrupts a paragraph and starts its own block — unless it belongs to a
      // list item, or is really an indented code line that happens to hold backticks.
      if (hasText() && !(list && /^\s/.test(line)) && !CODE_INDENT.test(line)) flush(at)
      if (!hasText()) start = at
      fence = open
      cur.push(line)
      continue
    }

    const plain = withoutCode(line)
    const def = DEFINITION.exec(line)
    if (def) labels.add(def[1]!.toLowerCase())
    if (comment) {
      if (plain.includes('-->')) comment = false
    } else {
      details += (plain.match(/<details[\s>]/gi) ?? []).length - (plain.match(/<\/details>/gi) ?? []).length
      if (details < 0) details = 0
      const lastOpen = plain.lastIndexOf('<!--')
      if (lastOpen >= 0 && !plain.includes('-->', lastOpen + 4)) comment = true
    }

    if (!line.trim()) {
      cur.push(line)
      if (details > 0 || comment) continue
      const next = nextText(i + 1)
      // A loose list or an indented continuation keeps the block open.
      if (list && next !== undefined && (LIST_ITEM.test(next) || INDENTED.test(next))) continue
      // So does an indented code block: blank lines inside it are part of the code.
      const prev = [...cur].reverse().find((l) => l.trim())
      if (prev !== undefined && next !== undefined && CODE_INDENT.test(prev) && CODE_INDENT.test(next)) continue
      flush(offset)
      continue
    }

    if (!hasText()) start = at
    if (LIST_ITEM.test(line)) list = true
    cur.push(line)
  }
  if (hasText()) blocks.push({ source: cur.join('\n'), start })

  return labels.size ? joinReferences(source, blocks, labels) : blocks
}

/**
 * A reference and its definition must be parsed together. The blocks before
 * the first one that names a defined label stay as they are (and keep their
 * memo); from that one on, the answer is one block.
 */
function joinReferences(source: string, blocks: Block[], labels: Set<string>): Block[] {
  const names = [...labels].map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const ref = new RegExp(`\\[(?:${names.join('|')})\\]`, 'i')
  const first = blocks.findIndex((b) => ref.test(b.source))
  if (first < 0) return blocks
  return [...blocks.slice(0, first), { source: source.slice(blocks[first]!.start), start: blocks[first]!.start }]
}

/** Footnote labels the answer defines so far. */
export function footnoteLabels(text: string): Set<string> {
  const out = new Set<string>()
  if (!text.includes('[^')) return out
  const lines = text.split('\n')
  const fenced = fenceMask(lines)
  lines.forEach((l, i) => {
    const m = fenced[i] ? null : DEFINITION.exec(l)
    if (m && m[1]!.startsWith('^')) out.add(m[1]!.slice(1).toLowerCase())
  })
  return out
}

/** While streaming, a footnote mark whose note has not arrived yet waits, rather than showing "[^1]". */
export function hidePendingNotes(source: string, defined: Set<string>): string {
  if (!source.includes('[^')) return source
  const lines = source.split('\n')
  const fenced = fenceMask(lines)
  return lines
    .map((l, i) => (fenced[i] ? l : l.replace(/\[\^([^\]\s]+)\](?!:)/g, (m, id: string) => (defined.has(id.toLowerCase()) ? m : ''))))
    .join('\n')
}

/*
  The block still being written. Markdown read mid-sentence lies: an opened
  `**` bolds the rest of the answer, `[text](ht` flashes as raw syntax, a
  table header without its delimiter row reads as a line of pipes, and a
  lone `-` under a line turns that line into a heading. Each is put right
  here, on this one block only — finished blocks are never touched.
*/
export function completeTail(source: string): string {
  const fence = openFence(source.split('\n'))
  // Inside a fence everything is code: only close it.
  if (fence) return `${source}${source.endsWith('\n') ? '' : '\n'}${fence.indent}${fence.char.repeat(fence.len)}`

  let s = source
  // An opener with nothing after it yet ("are **", "see `") would print as literal marks once closed.
  s = s.replace(/(^|\s)(?:\*{1,3}|_{1,3}|~{1,2}|`{1,3})$/, '$1')

  // Inside an open code span the rest is code: leave its text alone and close the span.
  const span = openCodeSpan(s.slice(scopeStart(s)))
  if (span) return s + span

  // A link or image cut short shows its words, never its syntax.
  s = s.replace(/!\[[^\]\n]*\]?\(?[^)\n]*$/, (m) => (/\)$/.test(m) ? m : ''))
  s = s.replace(/\[([^\]\n]*)\]\((?:[^()\n]|\([^()\n]*\)?)*$/, '$1')
  s = s.replace(/\[([^\]\n]*)$/, '$1')
  // Half an HTML tag or comment — only what is clearly one, so "i<n we loop" stays.
  s = s.replace(/<!--(?:(?!-->)[\s\S])*$/, '')
  s = s.replace(/<\/?([a-z][a-z0-9-]*)(\s[^<>\n]*)?$/i, (m, name: string, rest?: string) =>
    !rest || HTML_TAGS.has(name.toLowerCase()) ? '' : m
  )
  // A bare list marker, an empty heading, a setext underline in the making.
  s = s.replace(/(^|\n) {0,3}(?:[-*+]|\d{1,9}[.)])[ \t]*$/, '$1')
  s = s.replace(/(^|\n) {0,3}#{1,6}[ \t]*$/, '$1')
  s = s.replace(/\n {0,3}(?:=+|-+)[ \t]*$/, '')
  s = holdBackTable(s)

  const at = scopeStart(s)
  return s.slice(0, at) + balanceInline(s.slice(at))
}

/**
 * The last block of a finished reply, closed. A run stopped mid-sentence
 * leaves a fence, a code span or emphasis open; those close. Nothing is
 * dropped or held back — no more text is coming — and a reply that closed
 * everything comes back as it is.
 */
export function closeEnd(source: string): string {
  const fence = openFence(source.split('\n'))
  if (fence) return `${source}${source.endsWith('\n') ? '' : '\n'}${fence.indent}${fence.char.repeat(fence.len)}`
  const span = openCodeSpan(source.slice(scopeStart(source)))
  const s = source + span
  const at = scopeStart(s)
  return s.slice(0, at) + balanceInline(s.slice(at))
}

const HTML_TAGS = new Set(
  'a abbr b blockquote br code dd del details div dl dt em h1 h2 h3 h4 h5 h6 hr i img ins kbd li mark ol p pre q s samp small span strong sub summary sup table tbody td th thead tr u ul var'.split(
    ' '
  )
)

function openFence(lines: string[]): Fence | null {
  let fence: Fence | null = null
  for (const line of lines) {
    if (fence) {
      if (closesFence(line, fence)) fence = null
    } else fence = opensFence(line)
  }
  return fence
}

/**
 * Where the inline text still being written begins: the last line that
 * starts a block (a list item, heading, quote or table row), or the start of
 * the paragraph. Emphasis and code spans never cross that line, so they are
 * balanced from there — never against an earlier, finished list item.
 */
function scopeStart(s: string): number {
  let at = s.length
  for (let end = s.length; end >= 0; ) {
    const from = s.lastIndexOf('\n', end - 1) + 1
    const line = s.slice(from, end)
    if (!line.trim() && end !== s.length) break
    at = from
    if (from === 0 || LIST_ITEM.test(line) || /^\s*(?:#{1,6}\s|>|\|)/.test(line)) break
    end = from - 1
  }
  return at
}

/** The backticks that would close a code span left open in `text`, or "". */
function openCodeSpan(text: string): string {
  let open = 0
  for (const m of text.replace(/\\`/g, '').matchAll(/`+/g)) {
    if (!open) open = m[0].length
    else if (m[0].length === open) open = 0
  }
  return '`'.repeat(open)
}

const isSpace = (c: string): boolean => /\s/.test(c)
const isPunct = (c: string): boolean => /[\p{P}\p{S}]/u.test(c)

/**
 * Close the emphasis left open at the end of `text`, by CommonMark's own
 * flanking rules: `2 * 3`, `snake_case`, `src/**` and `x ~~ y` open
 * nothing, and half a closer (`**bold*`) is finished rather than doubled.
 */
function balanceInline(text: string): string {
  // Code spans, escapes and URLs hold no emphasis.
  const t = text
    .replace(/(`+)[\s\S]*?\1/g, (m) => 'x'.repeat(m.length))
    .replace(/\\./g, 'xx')
    .replace(/\b(?:https?:\/\/|www\.)\S+/g, (m) => 'x'.repeat(m.length))
  const stack: { ch: string; len: number }[] = []
  for (const m of t.matchAll(/\*+|_+|~+/g)) {
    const ch = m[0][0]!
    const len = m[0].length
    const i = m.index
    if (ch === '~' && len > 2) continue
    const prev = t[i - 1] ?? ' '
    const next = t[i + len] ?? ' '
    const left = !isSpace(next) && (!isPunct(next) || isSpace(prev) || isPunct(prev))
    const right = !isSpace(prev) && (!isPunct(prev) || isSpace(next) || isPunct(next))
    let canOpen = ch === '_' ? left && (!right || isPunct(prev)) : left
    const canClose = ch === '_' ? right && (!left || isPunct(next)) : right
    // At the very end, what follows is unknown: a run there can only close.
    if (i + len === t.length) canOpen = false
    // Only `~~` strikes through (singleTilde is off): `~2.5 hours` opens nothing,
    // though a lone `~` still finishes half a closer (`~~gone~`).
    if (ch === '~' && len === 1) canOpen = false
    let rest = len
    while (canClose && rest > 0) {
      const k = stack.map((o) => o.ch).lastIndexOf(ch)
      if (k < 0) break
      const take = Math.min(rest, stack[k]!.len)
      stack[k]!.len -= take
      rest -= take
      stack.length = stack[k]!.len ? k + 1 : k
    }
    // Only a clear opener counts: after a space or an opening bracket, never mid-word or after a slash.
    if (rest > 0 && canOpen && (i === 0 || isSpace(prev) || /[([{"'“‘]/.test(prev))) stack.push({ ch, len: rest })
  }
  if (!stack.length) return text
  // A closer right after a space closes nothing ("**more **"), so it goes against the last word.
  return (
    text.trimEnd() +
    stack
      .reverse()
      .map((o) => o.ch.repeat(o.len))
      .join('')
  )
}

const DELIMITER = /^\s*\|?\s*:?-+:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/
/** The start of a delimiter row: dashes up to a pipe or the line's end — not a "- list item". */
const DELIMITER_START = /^\s*\|?\s*:?-+:?\s*(?:\||$)/

/** Cells in a row: a pipe in a code span, or an escaped one, does not split a cell. */
function cells(line: string): number {
  return withoutCode(line)
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/).length
}
const hasPipe = (line: string): boolean => /(?<!\\)\|/.test(withoutCode(line))

/**
 * The table still being written appears once its delimiter row has, and the
 * row being typed waits for its last cell. Only the trailing run of lines is
 * looked at — a finished table above, a pipe in code, or prose that merely
 * holds a "|" is left alone.
 */
function holdBackTable(s: string): string {
  const lines = s.split('\n')
  const fenced = fenceMask(lines)
  const last = lines.length - 1
  let top = last + 1
  while (top > 0 && !fenced[top - 1] && lines[top - 1]!.trim()) top--

  for (let i = top; i <= last; i++) {
    const line = lines[i]!
    if (!hasPipe(line)) continue
    const piped = /^\s*\|/.test(line)
    // A header being typed: wait for it only when it looks like one.
    if (i === last) return piped ? lines.slice(0, i).join('\n') : s
    const delimiter = lines[i + 1]!
    if (!DELIMITER_START.test(delimiter)) continue
    const whole = DELIMITER.test(delimiter) && cells(delimiter) === cells(line)
    if (i + 1 === last) return whole ? s : lines.slice(0, i).join('\n')
    // A finished line under it that is no delimiter row: not a table after all.
    if (!whole) continue
    // A table: its last row is done at the closing pipe, or, without edge pipes, at its newline.
    if (!piped || !/(?<!\\)\|\s*$/.test(lines[last]!)) lines.pop()
    return lines.join('\n')
  }
  return s
}
