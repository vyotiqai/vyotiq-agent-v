import type { Schema } from 'hast-util-sanitize'
import { markdownSanitizeSchema } from '@renderer/lib/markdown/markdownSanitize'

/*
  Small tree passes around the sanitizer — no raw HTML parser, no new
  dependency.

  Before it (`rehypeAllowed`): the three HTML tags an answer may use —
  <kbd>, <details>, <summary> — become real elements, and a fence's info
  string beyond the language (a path, a line range) is kept as `data-meta`.
  Any other HTML stays raw and the sanitizer drops it, as before.

  After it (`rehypeDecorate`): GitHub alerts (`> [!WARNING]`) are marked on
  their blockquote, and table columns that hold only numbers are marked so
  they right-align. Both only add data attributes to what the sanitizer let
  through.
*/

type Text = { type: 'text'; value: string }
type Raw = { type: 'raw'; value: string }
type Element = { type: 'element'; tagName: string; properties: Record<string, unknown>; children: Node[]; data?: { meta?: string } }
type Node = Text | Raw | Element | { type: string; children?: Node[] }
type Parent = { children: Node[] }

const isElement = (n: Node | undefined, tag?: string): n is Element => n?.type === 'element' && (!tag || (n as Element).tagName === tag)
const el = (tagName: string, children: Node[], properties: Record<string, unknown> = {}): Element => ({ type: 'element', tagName, properties, children })
const stripTags = (s: string): string => s.replace(/<[^>]*>/g, '').trim()

/**
 * The schema: the app's markdown schema (GitHub's), plus `data-meta` on code, and data:/blob:
 * image sources — images the app made itself (Img still loads only those, and
 * ReplyMarkdown's urlTransform lets only image data: through).
 */
export const SANITIZE_SCHEMA: Schema = {
  ...markdownSanitizeSchema,
  attributes: { ...markdownSanitizeSchema.attributes, code: [...(markdownSanitizeSchema.attributes?.code ?? []), 'dataMeta'] },
  protocols: { ...markdownSanitizeSchema.protocols, src: [...(markdownSanitizeSchema.protocols?.src ?? []), 'data', 'blob'] }
}

const DETAILS_OPEN = /^<details(\s+open)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?\s*$/i
const DETAILS_CLOSE = /^\s*<\/details>\s*$/i
const DETAILS_INLINE = /^<details(\s+open)?\s*>\s*(?:<summary>([\s\S]*?)<\/summary>)?([\s\S]*?)<\/details>$/i

function walk(parent: Parent): void {
  const out: Node[] = []
  const kids = parent.children
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i]!
    if (n.type === 'raw') {
      const value = (n as Raw).value
      // <kbd>Ctrl</kbd>: an opening tag, its text, a closing tag.
      if (/^<kbd>$/i.test(value)) {
        const close = kids.findIndex((k, j) => j > i && k.type === 'raw' && /^<\/kbd>$/i.test((k as Raw).value))
        if (close > i) {
          const inner = kids.slice(i + 1, close).map((k) => ('value' in k ? stripTags(String(k.value)) : '')).join('')
          out.push(el('kbd', [{ type: 'text', value: inner }]))
          i = close
          continue
        }
      }
      // A fold written on one line is one raw node; its body is plain text, as GitHub shows it.
      const inline = DETAILS_INLINE.exec(value.trim())
      if (inline) {
        const body = stripTags(inline[3] ?? '')
        const summary = el('summary', [{ type: 'text', value: stripTags(inline[2] ?? '') || 'Details' }])
        out.push(el('details', body ? [summary, el('p', [{ type: 'text', value: body }])] : [summary], inline[1] ? { open: true } : {}))
        continue
      }
      // <details><summary>…</summary> … </details>, with markdown between.
      const open = DETAILS_OPEN.exec(value.trim())
      if (open) {
        let close = kids.findIndex((k, j) => j > i && k.type === 'raw' && DETAILS_CLOSE.test((k as Raw).value))
        if (close < 0) close = kids.length
        const body: Parent = { children: kids.slice(i + 1, close) }
        walk(body)
        const summary = stripTags(open[2] ?? '') || 'Details'
        out.push(el('details', [el('summary', [{ type: 'text', value: summary }]), ...body.children], open[1] ? { open: true } : {}))
        i = close
        continue
      }
      out.push(n)
      continue
    }
    if (isElement(n, 'code') && n.data?.meta) n.properties = { ...n.properties, dataMeta: n.data.meta }
    if ('children' in n && n.children) walk(n as Parent)
    out.push(n)
  }
  parent.children = out
}

export function rehypeAllowed() {
  return (tree: Parent): void => walk(tree)
}

const ALERT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*\n?/i
const NUMERIC = /^(?:[~≈<>≤≥]\s?)?[-−+]?[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|pp|ns|µs|us|ms|s|sec|m|min|h|hr|d|x|×|k|K|M|B|KB|MB|GB|TB|kB|KiB|MiB|GiB|TiB|px|rem|em|fps|req\/s|ops\/s|tok\/s|°)?$/
/** Cells that hold no value and so neither make nor break a numeric column. */
const PLACEHOLDER = /^(?:[-–—?…]|n\/a|na|none|tbd)$/i

function decorate(node: Node): void {
  if (!isElement(node)) {
    if ('children' in node && node.children) node.children.forEach(decorate)
    return
  }
  if (node.tagName === 'blockquote') markAlert(node)
  if (node.tagName === 'table') markNumbers(node)
  node.children.forEach(decorate)
}

function markAlert(quote: Element): void {
  const p = quote.children.find((c): c is Element => isElement(c))
  const first = p && isElement(p, 'p') ? p.children[0] : undefined
  if (!p || first?.type !== 'text') return
  const m = ALERT.exec((first as Text).value)
  if (!m) return
  ;(first as Text).value = (first as Text).value.slice(m[0].length)
  // A marker alone on its line leaves an empty first paragraph (or a stray <br>).
  if (isElement(p.children[1], 'br') && !(first as Text).value.trim()) p.children.splice(0, 2)
  if (!p.children.some((c) => c.type !== 'text' || (c as Text).value.trim())) quote.children = quote.children.filter((c) => c !== p)
  quote.properties = { ...quote.properties, dataAlert: m[1]!.toLowerCase() }
}

const textOf = (n: Node): string => (n.type === 'text' ? (n as Text).value : 'children' in n && n.children ? n.children.map(textOf).join('') : '')
const rowsOf = (section: Element | undefined): Element[] => (section ? section.children.filter((c): c is Element => isElement(c, 'tr')) : [])
const cellsOf = (row: Element): Element[] => row.children.filter((c): c is Element => isElement(c, 'td') || isElement(c, 'th'))

function markNumbers(table: Element): void {
  const head = rowsOf(table.children.find((c): c is Element => isElement(c, 'thead')))
  const body = rowsOf(table.children.find((c): c is Element => isElement(c, 'tbody')))
  if (!body.length) return
  const width = Math.max(...body.map((r) => cellsOf(r).length))
  for (let col = 0; col < width; col++) {
    const values = body.map((r) => textOf(cellsOf(r)[col] ?? el('td', [])).trim()).filter((t) => t && !PLACEHOLDER.test(t))
    if (!values.length || !values.every((t) => NUMERIC.test(t))) continue
    for (const row of [...head, ...body]) {
      const cell = cellsOf(row)[col]
      if (cell) cell.properties = { ...cell.properties, dataNum: '' }
    }
  }
}

export function rehypeDecorate() {
  return (tree: Node): void => decorate(tree)
}
