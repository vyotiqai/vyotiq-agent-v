import { describe, expect, it } from 'vitest'
import {
  isWebSearchTimelineGroup,
  isWebSearchTimelineToolName,
  parseWebSearchTimelineItem
} from '@renderer/features/chat/toolUi/parsers/webSearchTimeline'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return { id: 't1', summary: '', status: 'done', ...overrides }
}

describe('web_search timeline parsing', () => {
  it('parses legacy numbered hits into sources with domains', () => {
    const item = parseWebSearchTimelineItem(
      tool({
        name: 'web_search',
        argsPreview: JSON.stringify({ query: 'vyotiq agent' }),
        content: [
          '# Web search: vyotiq agent',
          '',
          'Found 2 result(s):',
          '',
          '1. First Hit',
          '   https://example.com/a',
          '   Alpha snippet',
          '',
          '2. Second Hit',
          '   https://example.com/b'
        ].join('\n')
      })
    )
    expect(item.kind).toBe('search')
    expect(item.query).toBe('vyotiq agent')
    expect(item.host).toBe('')
    expect(item.count).toBe(2)
    expect(item.failed).toBe(false)
    expect(item.sources).toEqual([
      { title: 'First Hit', url: 'https://example.com/a', domain: 'example.com' },
      { title: 'Second Hit', url: 'https://example.com/b', domain: 'example.com' }
    ])
  })

  it('reports count 0 for an explicit "No results." hit list and null without one', () => {
    const none = parseWebSearchTimelineItem(
      tool({
        name: 'web_search',
        summary: 'empty',
        content: '# Web search: empty\n\nNo results.'
      })
    )
    expect(none.count).toBe(0)
    expect(none.sources).toEqual([])

    const blank = parseWebSearchTimelineItem(tool({ name: 'web_search', content: '' }))
    expect(blank.count).toBeNull()
    expect(blank.sources).toEqual([])
  })

  it('falls back to summary for the query and keeps failed status', () => {
    const item = parseWebSearchTimelineItem(
      tool({
        name: 'web_search',
        summary: 'electron security hardening',
        content: '# Web search: electron security hardening\n\n1. Hardening guide\n   https://example.com/guide',
        status: 'fail'
      })
    )
    expect(item.query).toBe('electron security hardening')
    expect(item.status).toBe('fail')
    expect(item.failed).toBe(true)
    expect(item.count).toBe(1)
    expect(item.sources[0]?.domain).toBe('example.com')
  })
})

describe('browser_search timeline parsing', () => {
  const content = [
    'Navigated to https://duckduckgo.com/?q=component+library+pricing',
    'Title: component library pricing at DuckDuckGo',
    'tab_id: 3',
    '',
    '- @e1 link "Radix UI pricing"',
    '- @e2 link "shadcn/ui"',
    'Page text without any literal result count.'
  ].join('\n')

  it('takes the host from the Navigated-to line and leaves count null', () => {
    const item = parseWebSearchTimelineItem(
      tool({
        name: 'browser_search',
        argsPreview: JSON.stringify({ query: 'component library pricing' }),
        content
      })
    )
    expect(item.kind).toBe('search')
    expect(item.host).toBe('duckduckgo.com')
    expect(item.query).toBe('component library pricing')
    expect(item.count).toBeNull()
    expect(item.sources).toEqual([])
    expect(item.failed).toBe(false)
  })

  it('counts only when the snapshot literally states a result count', () => {
    const item = parseWebSearchTimelineItem(
      tool({
        name: 'browser_search',
        argsPreview: JSON.stringify({ query: 'component library pricing' }),
        content: `${content}\nAbout 1,230 results.`
      })
    )
    expect(item.count).toBe(1230)
  })

  it('falls back to the summary for the query when args are missing', () => {
    const item = parseWebSearchTimelineItem(
      tool({ name: 'browser_search', summary: 'tailwind v4 features', content })
    )
    expect(item.query).toBe('tailwind v4 features')
  })
})

describe('web_fetch timeline parsing', () => {
  it('treats the fetch as a read with host and query from args.url', () => {
    const item = parseWebSearchTimelineItem(
      tool({
        name: 'web_fetch',
        argsPreview: JSON.stringify({ url: 'https://www.reddit.com/r/reactjs/comments/abc' }),
        content: '<html>…</html>'
      })
    )
    expect(item.kind).toBe('read')
    expect(item.host).toBe('www.reddit.com')
    expect(item.query).toBe('https://www.reddit.com/r/reactjs/comments/abc')
    expect(item.sources).toEqual([])
    expect(item.failed).toBe(false)
  })
})

describe('timeline tool-name/group guards', () => {
  it('accepts exactly the three timeline tool names', () => {
    expect(isWebSearchTimelineToolName('web_search')).toBe(true)
    expect(isWebSearchTimelineToolName('browser_search')).toBe(true)
    expect(isWebSearchTimelineToolName('web_fetch')).toBe(true)
    expect(isWebSearchTimelineToolName('browser_snapshot')).toBe(false)
    expect(isWebSearchTimelineToolName('grep')).toBe(false)
    expect(isWebSearchTimelineToolName('')).toBe(false)
  })

  it('requires a non-empty group of only timeline tools', () => {
    expect(isWebSearchTimelineGroup([])).toBe(false)
    expect(isWebSearchTimelineGroup([{ name: 'web_search' }])).toBe(true)
    expect(
      isWebSearchTimelineGroup([
        { name: 'web_search' },
        { name: 'browser_search' },
        { name: 'web_fetch' }
      ])
    ).toBe(true)
    expect(isWebSearchTimelineGroup([{ name: 'web_search' }, { name: 'grep' }])).toBe(false)
  })
})
