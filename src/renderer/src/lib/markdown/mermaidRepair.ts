/**
 * The slips models make in a mermaid flowchart that mermaid refuses outright,
 * put right so the diagram draws instead of "could not be drawn". Tried only
 * after the source as written fails, so a diagram that parses is never
 * touched; a repair that is wrong just fails again.
 *
 * - Two statements on one line, set apart by spaces: `A --> B  C --> D`.
 * - An unquoted label holding brackets, braces or `@`: `A[loop.ts (runAgent)]`,
 *   `A -->|calls (x)| B`, `A[@scope/pkg]`.
 * - `end` as a node name, which mermaid reads as closing a subgraph.
 */

const OPEN_CLOSE: Record<string, string> = { '[': ']', '(': ')', '{': '}' }
/** A label that needs quotes to parse. */
const RISKY_LABEL = /[()[\]{}@]/
/** Lines that are not node or edge statements. */
const NOT_A_STATEMENT = /^(?:%%|subgraph\b|end\s*;?\s*$|direction\b|classDef\b|class\b|style\b|linkStyle\b|click\b|acc(?:Title|Descr)\b)/
const ID_CHAR = /[\w.-]/
/** A statement's start: a node, then its shape or a link. */
const STATEMENT_START = /^[A-Za-z_][\w.-]*\s*(?:[[({]|--|==|-\.|~~|&)/

export function repairMermaid(source: string): string {
  const lines = source.split('\n')
  const head = lines.findIndex((l) => l.trim() !== '' && !l.trim().startsWith('%%'))
  if (head < 0 || !/^\s*(?:flowchart|graph)\b/.test(lines[head]!)) return source
  const out = lines.slice(0, head + 1)
  for (const line of lines.slice(head + 1)) out.push(...repairLine(line))
  return out.join('\n')
}

function repairLine(line: string): string[] {
  const body = line.trim()
  if (!body || NOT_A_STATEMENT.test(body)) return [line]
  const indent = line.slice(0, line.length - line.trimStart().length)
  const { text, gaps } = repairStatement(body)
  const pieces: string[] = []
  let from = 0
  for (const [start, end] of gaps) {
    const left = text.slice(from, start)
    const right = text.slice(end)
    // Only between two whole statements: the left ends on a node (not inside
    // a link or an old-style `A -- text --> B` label), the right starts one.
    const leftWhole = /[\w)\]}"]$/.test(left) && !/(?:--|==|-\.|&)$/.test(left) && !/\s(?:--|==)\s+[^-=>]*$/.test(left)
    if (leftWhole && STATEMENT_START.test(right)) {
      pieces.push(left)
      from = end
    }
  }
  pieces.push(text.slice(from))
  // Nothing to put right: the line exactly as written, trailing spaces too.
  if (pieces.length === 1 && text === body) return [line]
  return pieces.map((p) => indent + p.trim())
}

/** Quote risky labels, rename `end`, and note the top-level runs of 2+ spaces. */
function repairStatement(body: string): { text: string; gaps: [number, number][] } {
  let text = ''
  const gaps: [number, number][] = []
  let i = 0
  while (i < body.length) {
    const ch = body[i]!
    if (ch === '"') {
      const close = body.indexOf('"', i + 1)
      const end = close < 0 ? body.length : close + 1
      text += body.slice(i, end)
      i = end
      continue
    }
    if (ch === '|') {
      // An edge label: |text|.
      const close = body.indexOf('|', i + 1)
      if (close < 0) {
        text += body.slice(i)
        break
      }
      text += `|${quoteIfRisky(body.slice(i + 1, close))}|`
      i = close + 1
      continue
    }
    const closer = OPEN_CLOSE[ch]
    if (closer && i > 0 && ID_CHAR.test(body[i - 1]!)) {
      const close = matching(body, i, ch, closer)
      if (close < 0) {
        text += body.slice(i)
        break
      }
      const inner = body.slice(i + 1, close)
      // A shape of its own ([( )], (( )), {{ }}, [/ /], [" "]) stays as written.
      text += ch + (/^[[({/\\"]/.test(inner) ? inner : quoteIfRisky(inner)) + closer
      i = close + 1
      continue
    }
    if (/\s/.test(ch)) {
      let end = i
      while (end < body.length && /\s/.test(body[end]!)) end++
      if (end - i >= 2 && end < body.length) gaps.push([text.length, text.length + (end - i)])
      text += body.slice(i, end)
      i = end
      continue
    }
    if (/\w/.test(ch) && (i === 0 || !ID_CHAR.test(body[i - 1]!))) {
      let end = i
      while (end < body.length && /\w/.test(body[end]!)) end++
      const word = body.slice(i, end)
      // `end` as a whole node name: not `end.ts`, `end-x` or `endpoint`.
      const next = body.slice(end, end + 2)
      const whole = !/^[.\w]/.test(next) && (!next.startsWith('-') || /^-[-.>]/.test(next))
      text += word === 'end' && whole ? 'End' : word
      i = end
      continue
    }
    text += ch
    i++
  }
  return { text, gaps }
}

/** The index of the bracket closing the one at `at`, counting nesting, past quotes. */
function matching(s: string, at: number, open: string, close: string): number {
  let depth = 0
  for (let i = at; i < s.length; i++) {
    const c = s[i]
    if (c === '"') {
      const q = s.indexOf('"', i + 1)
      if (q < 0) return -1
      i = q
    } else if (c === open) depth++
    else if (c === close && --depth === 0) return i
  }
  return -1
}

function quoteIfRisky(label: string): string {
  const t = label.trim()
  if (t.startsWith('"') || !RISKY_LABEL.test(t)) return label
  return `"${t.replace(/"/g, '#quot;')}"`
}

type MermaidRender = { render: (id: string, text: string) => Promise<{ svg: string }> }

/** Mermaid's stray temp nodes for a render id (`d…` div, `i…` sandbox iframe). */
function removeStrays(id: string): void {
  document.getElementById(`d${id}`)?.remove()
  document.getElementById(`i${id}`)?.remove()
}

/**
 * Draw `source`; if mermaid refuses it, draw its repair once. Rejects with the
 * first error when there is nothing to repair or the repair fails too, and
 * leaves no temp nodes behind either way.
 */
export async function renderMermaid(mermaid: MermaidRender, id: string, source: string): Promise<{ svg: string }> {
  try {
    return await mermaid.render(id, source)
  } catch (error) {
    removeStrays(id)
    const repaired = repairMermaid(source)
    if (repaired === source) throw error
    try {
      return await mermaid.render(`${id}-r`, repaired)
    } catch {
      removeStrays(`${id}-r`)
      throw error
    }
  }
}
