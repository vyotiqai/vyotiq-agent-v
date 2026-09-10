/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownContent } from '@renderer/lib/ui/MarkdownContent'
import {
  highlightSanitizeSchema,
  markdownSanitizeSchema,
  sanitizeHighlightedHtml
} from '@renderer/lib/markdown/markdownSanitize'
import { defaultSchema } from 'hast-util-sanitize'

afterEach(() => {
  cleanup()
})

function renderMarkdown(content: string): HTMLElement {
  return render(<MarkdownContent content={content} />).container
}

describe('markdown sanitization — url protocols', () => {
  it('drops javascript: link hrefs', () => {
    const container = renderMarkdown('[click me](javascript:alert(1))')

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click me')
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it('drops javascript: image sources', () => {
    const container = renderMarkdown('![boom](javascript:alert(1))')

    expect(container.querySelector('img')?.getAttribute('src')).toBeNull()
    expect(container.innerHTML).not.toContain('javascript:')
  })

  it('drops data:text/html link hrefs', () => {
    const container = renderMarkdown(
      '[click](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'
    )

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
    expect(container.innerHTML).not.toContain('data:text/html')
  })

  it('drops vbscript: link hrefs', () => {
    const container = renderMarkdown('[click](vbscript:msgbox("x"))')

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
    expect(container.innerHTML).not.toContain('vbscript:')
  })

  it('drops entity-obfuscated javascript: hrefs', () => {
    const container = renderMarkdown('[click](&#106;avascript:alert(1))')

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toContain('click')
    expect(container.innerHTML.toLowerCase()).not.toContain('javascript:')
  })

  it('keeps http and https link hrefs', () => {
    const container = renderMarkdown('[docs](https://example.com/a)')

    expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com/a')
  })
})

describe('markdown sanitization — raw html', () => {
  const vectors: Array<[string, string]> = [
    ['script', '<script>window.__pwned = true</script>'],
    ['iframe', '<iframe src="https://evil.test"></iframe>'],
    ['object', '<object data="https://evil.test"></object>'],
    ['embed', '<embed src="https://evil.test">'],
    ['form + formaction', '<form action="https://evil.test"><button formaction="javascript:alert(1)">go</button></form>'],
    ['event handler', '<img src="x" onerror="window.__pwned = true">'],
    ['inline style url()', '<div style="background-image:url(javascript:alert(1))">styled</div>'],
    ['inline style expression()', '<span style="width:expression(alert(1))">styled</span>'],
    ['srcset', '<img srcset="x 1x" src="x">'],
    ['picture source srcset', '<picture><source srcset="x"><img src="x"></picture>'],
    ['svg script', '<svg><script>window.__pwned = true</script></svg>'],
    ['svg animate onbegin', '<svg><animate onbegin="window.__pwned = true" attributeName="x"></animate></svg>'],
    ['svg xlink:href', '<svg><a xlink:href="javascript:alert(1)"><text>go</text></a></svg>'],
    ['base href', '<base href="https://evil.test/">'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">']
  ]

  for (const [name, markup] of vectors) {
    it(`neutralizes ${name}`, () => {
      const container = renderMarkdown(markup)
      const html = container.innerHTML.toLowerCase()

      expect(container.querySelector('script,iframe,object,embed,form,base,meta,svg,animate')).toBeNull()
      expect(html).not.toContain('onerror')
      expect(html).not.toContain('onbegin')
      expect(html).not.toContain('formaction')
      expect(html).not.toContain('srcset')
      expect(html).not.toContain('javascript:')
      expect(html).not.toContain('expression(')
      expect((window as unknown as { __pwned?: boolean }).__pwned).toBeUndefined()
    })
  }

  it('renders raw html as inert text rather than markup', () => {
    const container = renderMarkdown('before <b>bold</b> after')

    expect(container.querySelector('b')).toBeNull()
  })
})

describe('markdown sanitization — schema', () => {
  it('does not allow style attributes through the schema', () => {
    const attributes = markdownSanitizeSchema.attributes as Record<string, unknown[]>
    for (const [tag, list] of Object.entries(attributes)) {
      expect(list.includes('style'), `${tag} allows style`).toBe(false)
    }
  })

  it('only allows language-* class names on code', () => {
    const codeAttributes = (markdownSanitizeSchema.attributes as Record<string, unknown[]>).code
    expect(codeAttributes.includes('className')).toBe(false)
  })
})

describe('highlightSanitizeSchema — belt 1 structural pass', () => {
  it('keeps the schema on GitHub defaults for markdown-body rendering', () => {
    expect(markdownSanitizeSchema).toBe(defaultSchema)
    expect(highlightSanitizeSchema.tagNames).toEqual(defaultSchema.tagNames)
    expect(highlightSanitizeSchema.protocols).toEqual(defaultSchema.protocols)
  })

  it('drops script content entirely (strip list) from highlighted HTML', () => {
    const out = sanitizeHighlightedHtml(
      '<pre><code>ok<script>window.__pwned = true</script>x</code></pre>'
    )
    expect(out).not.toContain('script')
    expect(out).not.toContain('pwned')
  })

  it('drops event-handler attributes in the structural pass', () => {
    const out = sanitizeHighlightedHtml(
      '<span class="line" onerror="alert(1)">x</span>'
    )
    expect(out).not.toContain('onerror')
    expect(out).toContain('class="line"')
  })

  it('drops foreign tags Shiki never emits (structural, not value-level)', () => {
    const out = sanitizeHighlightedHtml(
      '<iframe src="https://evil.test"></iframe><span class="line">x</span>'
    )
    expect(out).not.toContain('iframe')
    expect(out).toContain('<span class="line">x</span>')
  })

  it('preserves shiki structure through the structural pass', () => {
    const out = sanitizeHighlightedHtml(
      '<pre class="shiki github-light" style="background-color:#fff;color:#24292e" tabindex="0"><code><span class="line" style="color:#d73a49">const</span></code></pre>'
    )
    expect(out).toContain('class="shiki github-light"')
    expect(out).toContain('class="line"')
    expect(out).toContain('background-color:#fff')
    expect(out).toContain('tabindex')
  })

  it('applies the same host-page CSP rules to the schema', () => {
    const schema = highlightSanitizeSchema.attributes as Record<string, string[]>
    expect(schema.pre).toEqual(['className', 'style', 'tabIndex'])
    expect(schema.span).toEqual(['className', 'style'])
  })
})

describe('sanitizeHighlightedHtml', () => {
  it('keeps class and style used by Shiki spans', () => {
    const out = sanitizeHighlightedHtml(
      '<pre class="shiki"><code><span class="line" style="color:#fff">x</span></code></pre>'
    )
    expect(out).toContain('class="shiki"')
    expect(out).toContain('class="line"')
    expect(out).toContain('style="color:#fff"')
  })

  it('strips event-handler attributes on allowed tags', () => {
    const out = sanitizeHighlightedHtml(
      '<span class="tok" onclick="alert(1)" onmouseover="alert(2)">hi</span>'
    )
    expect(out).toBe('<span class="tok">hi</span>')
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('onmouseover')
  })

  it('drops javascript: hrefs on anchors', () => {
    const out = sanitizeHighlightedHtml('<a href="javascript:alert(1)">go</a>')
    expect(out).toBe('<a>go</a>')
  })

  it('drops protocol-relative // hrefs on anchors', () => {
    const out = sanitizeHighlightedHtml('<a href="//evil.example/phish">click</a>')
    expect(out).toBe('<a>click</a>')
    expect(out).not.toContain('//evil.example')
  })

  it('keeps absolute-path hrefs on anchors', () => {
    const out = sanitizeHighlightedHtml('<a href="/docs/guide">guide</a>')
    expect(out).toContain('href="/docs/guide"')
  })

  it('removes disallowed tags entirely (open + close)', () => {
    const out = sanitizeHighlightedHtml('<div>ok<iframe src="x"></iframe></div>')
    expect(out).toBe('<div>ok</div>')
  })

  it('drops dangerous style payloads', () => {
    const out = sanitizeHighlightedHtml(
      '<span style="width:expression(alert(1))">x</span>'
    )
    expect(out).toBe('<span>x</span>')
  })

  it('drops style url() payloads while keeping safe declarations', () => {
    const out = sanitizeHighlightedHtml(
      '<span style="color:#fff;background-image:url(https://evil.test/t)">x</span>'
    )
    expect(out).toBe('<span style="color:#fff">x</span>')
    expect(out).not.toContain('url(')
  })

  it('drops unknown style properties Shiki never emits', () => {
    const out = sanitizeHighlightedHtml('<span style="position:fixed;color:#0f0">x</span>')
    expect(out).toBe('<span style="color:#0f0">x</span>')
  })

  it('drops CSS escape obfuscation in style values', () => {
    const out = sanitizeHighlightedHtml('<span style="color:u\\72 l(javascript:1)">x</span>')
    expect(out).toBe('<span>x</span>')
  })

  it('keeps font declarations Shiki themes emit', () => {
    const out = sanitizeHighlightedHtml(
      '<span style="color:#e06c75;font-style:italic;font-weight:bold">x</span>'
    )
    expect(out).toContain('font-style:italic')
    expect(out).toContain('font-weight:bold')
  })
})

describe('highlighted code output', () => {
  it('escapes html inside a highlighted fence', async () => {
    const { container } = render(
      <MarkdownContent content={'```js\nconst a = "<img src=x onerror=alert(1)>"\n```'} />
    )

    await waitFor(() => {
      expect(container.querySelector('pre.shiki')).toBeTruthy()
    })
    expect(container.querySelector('img')).toBeNull()
    expect(container.innerHTML).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(container.textContent).toContain('const a = "<img src=x onerror=alert(1)>"')
  })
})

describe('link handling', () => {
  it('opens external links in a new context with noopener', () => {
    const container = renderMarkdown('[docs](https://example.com)')

    const anchor = container.querySelector('a')
    expect(anchor?.getAttribute('target')).toBe('_blank')
    expect(anchor?.getAttribute('rel')).toContain('noopener')
    expect(anchor?.getAttribute('rel')).toContain('noreferrer')
  })
})
