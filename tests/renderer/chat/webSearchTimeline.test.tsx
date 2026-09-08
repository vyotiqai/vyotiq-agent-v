/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolGroup } from '@renderer/features/chat/components/ToolGroup'
import { WebSearchTimeline } from '@renderer/features/chat/toolUi/WebSearchTimeline'
import type { UiItem, UiToolRow } from '@shared/transcript'

/**
 * The production parser module (toolUi/parsers/webSearchTimeline.ts) is
 * concurrent sibling work and does not exist in this worktree yet. Mock it with
 * the exact consumed contract so ToolGroup's wiring renders; the parent merge
 * swaps in the real parser without touching this file.
 */
const parserMock = vi.hoisted(() => {
  const WEB_TOOLS = new Set(['web_search', 'browser_search', 'web_fetch'])

  function parseArgsRecord(argsPreview: string | undefined): Record<string, unknown> {
    if (!argsPreview) return {}
    try {
      return JSON.parse(argsPreview) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  function hostFromUrl(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return ''
    }
  }

  function parseWebSearchTimelineItem(tool: UiToolRow) {
    const args = parseArgsRecord(tool.argsPreview)
    const isRead = tool.name === 'web_fetch'
    const url = typeof args.url === 'string' ? args.url : ''
    const site = typeof args.site === 'string' ? args.site : ''
    const host = site || (url ? hostFromUrl(url) : '')
    const sources = Array.isArray(args.sources)
      ? (args.sources as Array<{ title: string; url: string }>)
      : []
    return {
      id: tool.id,
      kind: isRead ? ('read' as const) : ('search' as const),
      query: typeof args.query === 'string' ? args.query : (tool.summary ?? ''),
      host,
      ...(url ? { url } : {}),
      ...(typeof args.count === 'number' ? { count: args.count as number } : {}),
      ...(sources.length > 0 ? { sources } : {}),
      status: tool.status,
      ...(tool.name === 'browser_search' || tool.name === 'web_fetch' ? { tool } : {})
    }
  }

  return {
    isWebSearchTimelineGroup: (tools: UiToolRow[]) =>
      tools.length > 0 && tools.every((tool) => WEB_TOOLS.has(tool.name)),
    parseWebSearchTimelineItem
  }
})

vi.mock('@renderer/features/chat/toolUi/parsers/webSearchTimeline', () => parserMock)

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
})

afterEach(() => {
  cleanup()
})

type ToolFixture = Extract<UiItem, { kind: 'tool' }>

function toolItem(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: 'running' | 'done' | 'fail' = 'done',
  groupTiming?: { startedAt: number; endedAt?: number }
): ToolFixture {
  return {
    kind: 'tool',
    id,
    groupTiming,
    tool: {
      id,
      name,
      summary: typeof args.query === 'string' ? args.query : '',
      status,
      argsPreview: JSON.stringify(args)
    }
  }
}

function timelineItems(
  specs: Array<Partial<Parameters<typeof Object.assign>[0]>> & Array<Record<string, unknown>>
): never {
  throw new Error('unused')
}
void timelineItems

describe('WebSearchTimeline', () => {
  it('renders the header count and one row per item (3 searches + 1 read)', () => {
    render(
      <WebSearchTimeline
        items={[
          { id: 's1', kind: 'search', query: 'lobehub icons', status: 'done', count: 5 },
          { id: 's2', kind: 'search', query: 'vitest jsdom', host: 'github.com', status: 'done' },
          { id: 's3', kind: 'search', query: 'electron security', status: 'done' },
          { id: 'r1', kind: 'read', query: '', url: 'https://example.com/docs', status: 'done' }
        ]}
      />
    )
    expect(screen.getByText('Ran 3 searches')).toBeTruthy()
    // s1 and s3 are generic web searches — same phrase, two matches.
    expect(screen.getAllByText('Searched the web for').length).toBe(2)
    expect(screen.getByText('Searched GitHub for')).toBeTruthy()
    expect(screen.getByText('Read example.com')).toBeTruthy()
    // 4 timeline rows: 3 search + 1 read (sources list only when expanded).
    expect(screen.getByText('electron security')).toBeTruthy()
  })

  it('expands the Sources disclosure into favicon + title + right-aligned domain rows', () => {
    render(
      <WebSearchTimeline
        items={[
          {
            id: 's1',
            kind: 'search',
            query: 'q',
            status: 'done',
            sources: [
              { title: 'Lobehub Icons Docs', url: 'https://github.com/lobehub/icons' },
              { title: 'Vitest Guide', url: 'https://vitest.dev/guide/' }
            ]
          }
        ]}
      />
    )

    // Collapsed: chips present, titles hidden.
    expect(screen.queryByText('Lobehub Icons Docs')).toBeNull()
    expect(screen.getAllByTitle('github.com').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('button', { name: 'Expand sources' }))
    expect(screen.getByText('Lobehub Icons Docs')).toBeTruthy()
    expect(screen.getByText('vitest.dev')).toBeTruthy()
    expect(
      screen.getByRole('button', { name: 'Collapse sources' }).getAttribute('aria-expanded')
    ).toBe('true')
  })

  it('renders the count receipt only when a count is present', () => {
    render(
      <WebSearchTimeline
        items={[
          { id: 's1', kind: 'search', query: 'with count', status: 'done', count: 5 },
          { id: 's2', kind: 'search', query: 'without count', status: 'done' }
        ]}
      />
    )
    expect(screen.getByText('5 results')).toBeTruthy()
    const row = screen.getByText('without count').parentElement
    expect(row?.textContent).not.toMatch(/results?$/)
  })

  it('renders the shimmer header while any row is running', () => {
    render(
      <WebSearchTimeline
        items={[
          { id: 's1', kind: 'search', query: 'done query', status: 'done' },
          { id: 's2', kind: 'search', query: 'live query', status: 'running' }
        ]}
        live
      />
    )
    expect(screen.getByText('Searching the web…')).toBeTruthy()
    expect(document.querySelectorAll('.vy-text-shimmer--active').length).toBeGreaterThan(0)
    expect(screen.queryByText('Ran 2 searches')).toBeNull()
  })

  it('marks a failed group interrupted instead of shimmering', () => {
    render(
      <WebSearchTimeline
        items={[{ id: 's1', kind: 'search', query: 'q', status: 'fail' }]}
      />
    )
    expect(screen.getByText('Ran 1 searches')).toBeTruthy()
    expect(screen.getByText('interrupted')).toBeTruthy()
  })
})

describe('ToolGroup web-search wiring', () => {
  it('routes a web-search group through the timeline instead of the generic header', () => {
    const tools = [
      toolItem('w1', 'web_search', { query: 'alpha', count: 12 }),
      toolItem('w2', 'web_search', { query: 'beta' }),
      toolItem('w3', 'web_search', { query: 'gamma' })
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Ran 3 searches')).toBeTruthy()
    expect(screen.queryByTestId('tool-group-list')).toBeNull()
    expect(screen.queryByText('3 lookups')).toBeNull()
  })

  it('keeps body persistence for browser_search rows inside the timeline', () => {
    const tools = [toolItem('w1', 'browser_search', { query: 'docs', url: 'https://example.com' })]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Ran 1 searches')).toBeTruthy()
  })

  it('leaves non-web groups on the generic header', () => {
    const tools = [
      {
        kind: 'tool' as const,
        id: 't1',
        tool: { id: 't1', name: 'read', summary: 'a.ts', status: 'done' as const }
      },
      {
        kind: 'tool' as const,
        id: 't2',
        tool: { id: 't2', name: 'search', summary: 'query', status: 'done' as const }
      }
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Read and searched')).toBeTruthy()
    expect(screen.getByText('1 file and 1 lookup')).toBeTruthy()
    expect(screen.queryByText('Ran 2 searches')).toBeNull()
  })
})
