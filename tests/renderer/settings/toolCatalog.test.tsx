/**
 * @vitest-environment jsdom
 */
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCatalogResult } from '@shared/ipc'
import {
  ToolCatalog,
  toolCatalogSummary,
  useToolCatalog
} from '@renderer/features/settings/components/ToolCatalog'

const payload: ToolCatalogResult = {
  codeIndexEnabled: true,
  autoModeSwitch: true,
  fingerprint: 'tc1',
  servers: [
    { id: 'gh', name: 'GitHub', enabled: true, connected: true, loading: 'on-demand' as const },
    {
      id: 'ctx',
      name: 'Context',
      enabled: false,
      connected: false,
      loading: 'every-step' as const
    }
  ],
  entries: [
    {
      name: 'read_file',
      description: 'Read a workspace file',
      source: 'builtin',
      modes: ['ask', 'plan', 'agent'],
      active: true
    },
    {
      name: 'codebase_search',
      description: 'Search the code index',
      source: 'builtin',
      modes: ['plan', 'agent'],
      active: false,
      reason: 'code-index-off'
    },
    {
      name: 'mcp__gh__get_file_contents',
      description: 'Read a file from GitHub',
      source: 'mcp',
      serverId: 'gh',
      serverName: 'GitHub',
      modes: ['agent'],
      active: true
    },
    {
      name: 'mcp__ctx__expand_chunk',
      description: 'Expand a chunk',
      source: 'mcp',
      serverId: 'ctx',
      serverName: 'Context',
      modes: ['agent'],
      active: false,
      reason: 'server-disabled'
    }
  ]
}

/** The Tools section's wiring: the hook's snapshot, its summary, the list. */
function Catalog() {
  const catalog = useToolCatalog()
  return catalog ? (
    <section>
      <p>{toolCatalogSummary(catalog)}</p>
      <ToolCatalog catalog={catalog} />
    </section>
  ) : null
}

function group(title: string): HTMLElement {
  return document.querySelector(`[data-tool-group="${title}"]`) as HTMLElement
}

describe('ToolCatalog', () => {
  let pushHandler: ((payload: ToolCatalogResult) => void) | null

  beforeEach(() => {
    pushHandler = null
    // @ts-expect-error test bridge
    window.vyotiq = {
      toolsCatalogGet: vi.fn(async () => ({ ok: true as const, data: payload })),
      onToolsCatalogChanged: vi.fn((handler: (payload: ToolCatalogResult) => void) => {
        pushHandler = handler
        return () => {}
      })
    }
  })

  it('renders the live catalog from the initial snapshot', async () => {
    render(<Catalog />)
    await waitFor(() => expect(group('Built-in tools')).toBeTruthy())
    expect(screen.getByText('2 of 4 tools active')).toBeTruthy()
    // Each source is one line: what state it is in, and how much of it is live.
    expect(within(group('Built-in tools')).getByText('1 of 2 active')).toBeTruthy()
    expect(within(group('GitHub')).getByText('Connected · loaded on demand')).toBeTruthy()
    expect(within(group('GitHub')).getByText('1 of 1 active')).toBeTruthy()
    expect(within(group('Context')).getByText('Disabled')).toBeTruthy()
    expect(within(group('Context')).getByText('0 of 1 active')).toBeTruthy()
    // Built-ins start open. An active tool lists the modes it runs in — Plan
    // folds into Agent, so it is not one of them — and an inactive one says
    // why in their place.
    const builtins = group('Built-in tools')
    expect(within(builtins).getByText('read_file')).toBeTruthy()
    expect(within(builtins).getByText('agent · ask')).toBeTruthy()
    expect(within(builtins).getByText('code index disabled')).toBeTruthy()
    expect(screen.queryByText(/plan/)).toBeNull()
  })

  it('keeps servers closed until opened, then names tools without the server prefix', async () => {
    render(<Catalog />)
    await waitFor(() => expect(group('GitHub')).toBeTruthy())
    const toggle = within(group('GitHub')).getByRole('button', { expanded: false })
    expect(within(group('GitHub')).queryByText('get_file_contents')).toBeNull()
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const name = within(group('GitHub')).getByText('get_file_contents')
    // The whole name stays on hover: it is what a policy or a log names.
    expect(name.getAttribute('title')).toBe('mcp__gh__get_file_contents')
  })

  it('lists a configured server that is not connected, and flags it', async () => {
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...payload,
        servers: [
          ...payload.servers,
          { id: 'lin', name: 'Linear', enabled: true, connected: false, loading: 'on-demand' as const }
        ]
      }
    }))
    render(<Catalog />)
    await waitFor(() => expect(group('Linear')).toBeTruthy())
    expect(within(group('Linear')).getByText('Not connected').classList.contains('text-warning')).toBe(true)
    // With no tools to list it is a line, not a toggle.
    expect(within(group('Linear')).queryByRole('button')).toBeNull()
  })

  it('lists the first rows of a long group and the rest on request', async () => {
    const many = Array.from({ length: 11 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Tool ${i}`,
      source: 'builtin' as const,
      modes: ['agent' as const],
      active: true
    }))
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({
      ok: true as const,
      data: { ...payload, servers: [], entries: many }
    }))
    render(<Catalog />)
    await waitFor(() => expect(group('Built-in tools')).toBeTruthy())
    expect(within(group('Built-in tools')).getByText('tool_7')).toBeTruthy()
    expect(within(group('Built-in tools')).queryByText('tool_8')).toBeNull()
    fireEvent.click(within(group('Built-in tools')).getByRole('button', { name: '… 3 more' }))
    expect(within(group('Built-in tools')).getByText('tool_10')).toBeTruthy()
  })

  it('opens agent-built tools and says how their calls are gated', async () => {
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...payload,
        entries: [
          ...payload.entries,
          {
            name: 'count_todos',
            description: 'Count TODO comments',
            source: 'agent' as const,
            modes: ['agent' as const],
            active: true
          }
        ]
      }
    }))
    render(<Catalog />)
    await waitFor(() => expect(group('Agent-built tools')).toBeTruthy())
    expect(within(group('Agent-built tools')).getByRole('button').getAttribute('aria-expanded')).toBe('true')
    // tests/gui-e2e/agent-built-tools.spec.ts pins this sentence.
    expect(
      screen.getByText(/each call asks you, and asks again whenever the code changes/)
    ).toBeTruthy()
    expect(screen.getByText('Count TODO comments')).toBeTruthy()
  })

  it('updates live from push events without a refetch', async () => {
    render(<Catalog />)
    await waitFor(() => expect(group('GitHub')).toBeTruthy())
    fireEvent.click(within(group('GitHub')).getByRole('button', { expanded: false }))
    expect(window.vyotiq.toolsCatalogGet).toHaveBeenCalledTimes(1)
    expect(pushHandler).toBeTypeOf('function')
    act(() => {
      pushHandler?.({
        ...payload,
        fingerprint: 'tc2',
        entries: payload.entries.map((entry) =>
          entry.name === 'mcp__gh__get_file_contents'
            ? { ...entry, active: false, reason: 'denied-by-policy' }
            : entry
        )
      })
    })
    await waitFor(() => expect(screen.getByText('denied by server tool policy')).toBeTruthy())
    expect(within(group('GitHub')).getByText('0 of 1 active')).toBeTruthy()
    expect(window.vyotiq.toolsCatalogGet).toHaveBeenCalledTimes(1)
  })

  it('renders nothing before data and still updates when the first push arrives', async () => {
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({ ok: false as const, error: 'boom' }))
    const { container } = render(<Catalog />)
    await waitFor(() => expect(window.vyotiq.toolsCatalogGet).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    expect(toolCatalogSummary(null)).toBeUndefined()
    act(() => {
      pushHandler?.(payload)
    })
    await waitFor(() => expect(group('GitHub')).toBeTruthy())
  })
})
