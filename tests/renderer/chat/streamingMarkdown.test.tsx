/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import {
  MarkdownContent,
  balanceIncompleteMarkdown,
  prepareStreamingMarkdown,
  splitMarkdownBlocks,
  trailingOpenFenceBody,
  HIGHLIGHT_CACHE_MAX_ENTRIES,
  setHighlightCacheEntry,
  getHighlightCacheEntry,
  clearHighlightCacheForTests,
  highlightCacheSizeForTests
} from '@renderer/lib/ui/MarkdownContent'

beforeEach(() => {
  clearHighlightCacheForTests()
  vi.stubGlobal(
    'navigator',
    Object.assign({}, navigator, {
      clipboard: { writeText: vi.fn().mockResolvedValue(undefined) }
    })
  )
})

afterEach(() => {
  clearHighlightCacheForTests()
  cleanup()
  vi.unstubAllGlobals()
})

describe('prepareStreamingMarkdown', () => {
  it('closes an unclosed fence without balancing inline markdown', () => {
    expect(prepareStreamingMarkdown('```\nx = a**b')).toBe('```\nx = a**b\n```')
  })

  it('balances bold while streaming', () => {
    expect(prepareStreamingMarkdown('Partial **bold')).toBe('Partial **bold**')
  })
})

describe('prepareStreamingMarkdown fence nesting', () => {
  it('does not open a stray tilde fence for a tilde line inside a backtick fence', () => {
    expect(prepareStreamingMarkdown('```\n~~~\nstill inside')).toBe('```\n~~~\nstill inside\n```')
  })

  it('closes a four-backtick fence with a matching four-backtick marker', () => {
    expect(prepareStreamingMarkdown('````md\n```js\nconst x = 1\n```')).toBe(
      '````md\n```js\nconst x = 1\n```\n````'
    )
  })

  it('leaves a closed indented fence alone', () => {
    expect(prepareStreamingMarkdown('  ```js\n  const x = 1\n  ```')).toBe(
      '  ```js\n  const x = 1\n  ```'
    )
  })

  it('keeps a nested fence opener while the outer fence is still streaming', () => {
    expect(prepareStreamingMarkdown('```md\nHere is the patch:\n```ts')).toBe(
      '```md\nHere is the patch:\n```ts\n```'
    )
  })

  it('closes a language fence that is only the opener so far', () => {
    expect(prepareStreamingMarkdown('```js')).toBe('```js\n```')
  })
})

describe('splitMarkdownBlocks fences', () => {
  it('keeps nested triple backticks inside a four-backtick fence as one block', () => {
    const source = '````md\n```js\nconst x = 1\n```\n````\n\nAfter'
    const blocks = splitMarkdownBlocks(source)
    expect(blocks[0]?.source).toContain('````md')
    expect(blocks[0]?.source).toContain('```js')
    expect(blocks[0]?.source).toContain('````')
    expect(blocks.some((b) => b.source.includes('After'))).toBe(true)
  })

  it('treats indented fences as a single block', () => {
    const blocks = splitMarkdownBlocks('  ```js\n  const x = 1\n  ```\n\nNext')
    expect(blocks[0]?.source.startsWith('  ```js')).toBe(true)
    expect(blocks[0]?.source).toContain('  ```')
  })
})

describe('trailingOpenFenceBody', () => {
  it('returns nothing when every fence is closed', () => {
    expect(trailingOpenFenceBody('```js\nconst x = 1\n```\ndone')).toBeNull()
  })

  it('returns only the body of the fence still streaming', () => {
    expect(trailingOpenFenceBody('```js\nconst x = 1\n```\n\n```ts\nlet y')).toBe('let y')
  })

  it('ignores a tilde fence inside an open backtick fence', () => {
    expect(trailingOpenFenceBody('```\n~~~\nstill inside')).toBe('~~~\nstill inside')
  })
})

describe('balanceIncompleteMarkdown', () => {
  it('balances bold outside fences when a stream completes', () => {
    expect(balanceIncompleteMarkdown('Partial **bold')).toBe('Partial **bold**')
  })

  it('ignores backticks that live inside a closed fence', () => {
    expect(balanceIncompleteMarkdown('```\nfoo ` bar\n```')).toBe('```\nfoo ` bar\n```')
  })

  it('ignores asterisks that live inside a closed fence', () => {
    expect(balanceIncompleteMarkdown('```\na ** b\n```')).toBe('```\na ** b\n```')
  })

  it('still balances bold that follows a closed fence', () => {
    expect(balanceIncompleteMarkdown('```\ncode\n```\n\nthen **bold')).toBe(
      '```\ncode\n```\n\nthen **bold**'
    )
  })

  it('balances italic outside fences when a stream completes', () => {
    expect(balanceIncompleteMarkdown('Partial *italic')).toBe('Partial *italic*')
  })

  it('closes an open fence when a stream completes', () => {
    expect(balanceIncompleteMarkdown('```ts\nconst x = 1')).toBe('```ts\nconst x = 1\n```')
  })
})

describe('MarkdownContent streaming', () => {
  it('renders first streaming frame immediately', () => {
    render(<MarkdownContent content="Hello" streaming />)

    expect(screen.getByText('Hello')).toBeTruthy()
  })

  it('balances partial bold while streaming', () => {
    render(<MarkdownContent content="Partial **bold" streaming />)

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByText('Partial **bold')).toBeNull()
  })

  it('keeps bold after streaming completes', () => {
    const { rerender } = render(<MarkdownContent content="Partial **bold" streaming />)

    expect(screen.getByText('bold').tagName).toBe('STRONG')

    rerender(<MarkdownContent content="Partial **bold" streaming={false} />)

    expect(screen.getByText('bold').tagName).toBe('STRONG')
    expect(screen.queryByText('Partial **bold')).toBeNull()
  })

  it('closes an unclosed fence as a partial code block', () => {
    render(<MarkdownContent content={'```js\nconst x = 1'} streaming />)

    expect(screen.getByText('const x = 1')).toBeTruthy()
    expect(screen.queryByText('```js')).toBeNull()
  })

  it('keeps plain code visible until highlight is ready after stream ends', async () => {
    const { container, rerender } = render(
      <MarkdownContent content={'```js\nconst x = 1'} streaming />
    )

    expect(container.textContent).toContain('const x = 1')
    expect(container.querySelector('pre.shiki')).toBeNull()

    rerender(<MarkdownContent content={'```js\nconst x = 1\n```'} streaming={false} />)

    // Soft swap: plain shell stays until highlight HTML arrives — never an empty shell.
    expect(container.textContent).toContain('const x = 1')
    expect(container.querySelector('.group\\/code')).toBeTruthy()

    await waitFor(
      () => {
        expect(container.querySelector('pre.shiki')).toBeTruthy()
      },
      { timeout: 5000 }
    )
    expect(container.textContent).toContain('const x = 1')
  })

  it('keeps an earlier finished fence highlighted across streaming deltas', async () => {
    const { container, rerender } = render(
      <MarkdownContent
        content={'```js\nconst done = 1\n```\n\nMore text'}
        streaming
      />
    )

    await waitFor(() => {
      expect(container.querySelector('pre.shiki')).toBeTruthy()
    })
    const finished = container.querySelector('pre.shiki')

    rerender(
      <MarkdownContent
        content={'```js\nconst done = 1\n```\n\nMore text grows'}
        streaming
      />
    )

    expect(container.querySelector('pre.shiki')).toBe(finished)
  })

  it('renders GFM tables', () => {
    render(
      <MarkdownContent
        content={'| A | B |\n| --- | --- |\n| 1 | 2 |'}
        streaming={false}
      />
    )

    expect(screen.getByRole('table')).toBeTruthy()
    expect(screen.getByText('A')).toBeTruthy()
    expect(screen.getByText('2')).toBeTruthy()
    expect(document.querySelector('[data-markdown-table-scroll]')).toBeTruthy()
  })

  it('keeps wide GFM tables scrollable in a narrow container', () => {
    const wide =
      '| Risk | Likelihood | Impact | Mitigation |\n' +
      '| --- | --- | --- | --- |\n' +
      '| PowerShell execution policy blocks scripts | Medium | High | Set Bypass for the session |\n' +
      '| Permission issues accessing process data | Low | Medium | Run elevated when required |\n'
    const { container } = render(
      <div style={{ width: 360 }}>
        <MarkdownContent content={wide} streaming={false} />
      </div>
    )
    const scroll = container.querySelector('[data-markdown-table-scroll]')
    expect(scroll).toBeTruthy()
    expect(scroll?.className).toMatch(/overflow-x-auto/)
    expect(container.querySelector('table')).toBeTruthy()
    expect(container.querySelector('.markdown-body')?.className).toMatch(
      /\[&_td\]:\[overflow-wrap:normal\]/
    )
  })

  it('copies fenced code from the code block button', async () => {
    render(
      <MarkdownContent
        content={'```js\nconst copied = true\n```'}
        streaming={false}
      />
    )

    const copyButton = await screen.findByRole('button', { name: 'Copy code' })
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('const copied = true')
    })
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeTruthy()
  })

  it('copies bare fenced code without a language tag', async () => {
    render(
      <MarkdownContent content={'```\nplain fence\n```'} streaming={false} />
    )

    const copyButton = await screen.findByRole('button', { name: 'Copy code' })
    fireEvent.click(copyButton)

    await waitFor(() => {
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('plain fence')
    })
  })

  it('closes an unclosed tilde fence while streaming', () => {
    render(<MarkdownContent content={'~~~\nconst y = 2'} streaming />)

    expect(screen.getByText('const y = 2')).toBeTruthy()
    expect(screen.queryByText('~~~')).toBeNull()
  })

  it('highlights a fence that already closed while a later one still streams', async () => {
    const { container } = render(
      <MarkdownContent
        content={'```js\nconst done = 1\n```\n\n```js\nconst still'}
        streaming
      />
    )

    await waitFor(() => {
      expect(container.querySelectorAll('pre.shiki').length).toBe(1)
    })
    expect(container.querySelectorAll('pre').length).toBe(2)
    expect(screen.getByText('const still')).toBeTruthy()
  })

  it('keeps a finished code block highlighted as later tokens arrive', async () => {
    const { container, rerender } = render(
      <MarkdownContent content={'```js\nconst done = 1\n```\n\n```js\nconst still'} streaming />
    )

    await waitFor(() => {
      expect(container.querySelectorAll('pre.shiki').length).toBe(1)
    })

    rerender(
      <MarkdownContent content={'```js\nconst done = 1\n```\n\n```js\nconst still = 2'} streaming />
    )

    expect(container.querySelectorAll('pre.shiki').length).toBe(1)
  })

  it('never shows a stale highlight from previous content', async () => {
    const { container, rerender } = render(
      <MarkdownContent content={'```js\nconst first = 1\n```'} streaming={false} />
    )

    await waitFor(() => {
      expect(container.querySelector('pre.shiki')).toBeTruthy()
    })

    rerender(<MarkdownContent content={'```js\nconst second = 2\n```'} streaming={false} />)

    expect(container.textContent).not.toContain('const first = 1')
    expect(container.textContent).toContain('const second = 2')
  })

  it('renders one code block for a tilde line inside a streaming backtick fence', () => {
    const { container } = render(<MarkdownContent content={'```\n~~~\nstill inside'} streaming />)

    expect(container.querySelectorAll('pre').length).toBe(1)
  })

  it('does not leak react-markdown node props onto code elements', () => {
    const { container } = render(
      <MarkdownContent content="inline `code` here" streaming={false} />
    )
    const code = container.querySelector('code')
    expect(code).toBeTruthy()
    expect(code?.getAttribute('node')).toBeNull()
  })

  it('renders no caret or markdown body when streaming with empty content', () => {
    const { container } = render(<MarkdownContent content="" streaming />)
    expect(container.querySelector('.markdown-body')).toBeNull()
    expect(container.querySelector('.streaming-caret-inline')).toBeNull()
  })

  it('renders no caret or markdown body when streaming with whitespace-only content', () => {
    const { container } = render(<MarkdownContent content={' \n'} streaming />)
    expect(container.querySelector('.markdown-body')).toBeNull()
    expect(container.querySelector('.streaming-caret-inline')).toBeNull()
  })

  it('never renders a streaming caret while text is streaming', () => {
    const { container } = render(<MarkdownContent content="After an" streaming />)
    expect(screen.getByText('After an')).toBeTruthy()
    expect(container.querySelector('.streaming-caret-inline')).toBeNull()
  })
})

describe('highlightCache bounds', () => {
  it('evicts oldest entries when the cache exceeds the max', () => {
    for (let i = 0; i < HIGHLIGHT_CACHE_MAX_ENTRIES + 3; i++) {
      setHighlightCacheEntry(`key-${i}`, `<pre>html-${i}</pre>`)
    }

    expect(highlightCacheSizeForTests()).toBe(HIGHLIGHT_CACHE_MAX_ENTRIES)
    expect(getHighlightCacheEntry('key-0')).toBeUndefined()
    expect(getHighlightCacheEntry('key-1')).toBeUndefined()
    expect(getHighlightCacheEntry('key-2')).toBeUndefined()
    expect(getHighlightCacheEntry('key-3')).toBe(`<pre>html-3</pre>`)
    expect(
      getHighlightCacheEntry(`key-${HIGHLIGHT_CACHE_MAX_ENTRIES + 2}`)
    ).toBe(`<pre>html-${HIGHLIGHT_CACHE_MAX_ENTRIES + 2}</pre>`)
  })
})
