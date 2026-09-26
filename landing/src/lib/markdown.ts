/**
 * Renders a GitHub release body to HTML for /changelog.
 *
 * Release notes are written to a small, fixed shape, the one the in-app update
 * card also parses: a lede paragraph, `## ` headings and `- ` bullets, with
 * **bold**, `code` and [links](https://...) inline. This handles exactly that
 * shape. Everything is
 * escaped before any markup is added, so nothing in a release body can inject
 * HTML into the page; anything outside the shape renders as plain text.
 *
 * `##` becomes an h3 (and `###` an h4) because the release itself is the h2 on
 * the changelog page; verify-site.mjs fails a page that skips a heading level.
 */

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function inline(text: string): string {
  let html = escape(text)
  // Code first, so markup characters inside it stay literal.
  const codes: string[] = []
  html = html.replace(/`([^`]+)`/g, (_, code: string) => {
    codes.push(`<code>${code}</code>`)
    return `\u0000${codes.length - 1}\u0000`
  })
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_, label: string, href: string) => `<a href="${href}" rel="noopener noreferrer">${label}</a>`
  )
  return html.replace(/\u0000(\d+)\u0000/g, (_, i: string) => codes[Number(i)])
}

export function renderReleaseNotes(body: string): string {
  const lines = body.replace(/\r\n/g, '\n').split('\n')
  const out: string[] = []
  let paragraph: string[] = []
  let list: string[] | null = null

  const flushParagraph = () => {
    if (paragraph.length > 0) out.push(`<p>${inline(paragraph.join(' '))}</p>`)
    paragraph = []
  }
  const flushList = () => {
    if (list) out.push(`<ul>${list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`)
    list = null
  }

  for (const raw of lines) {
    const line = raw.trimEnd()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)

    if (line.trim() === '') {
      flushParagraph()
      flushList()
    } else if (heading) {
      flushParagraph()
      flushList()
      const level = heading[1].length >= 3 ? 4 : 3
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`)
    } else if (bullet) {
      flushParagraph()
      list ??= []
      list.push(bullet[1])
    } else if (list && list.length > 0 && /^\s+/.test(raw)) {
      // An indented line continues the bullet above it.
      list[list.length - 1] += ` ${line.trim()}`
    } else {
      flushList()
      paragraph.push(line.trim())
    }
  }
  flushParagraph()
  flushList()
  return out.join('\n')
}
