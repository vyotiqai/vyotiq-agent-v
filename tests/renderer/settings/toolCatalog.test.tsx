/**
 * @vitest-environment jsdom
 */
import { act, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolCatalogResult } from '@shared/ipc'
import { ToolCatalogCard } from '@renderer/features/settings/components/ToolCatalogCard'

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

describe('ToolCatalogCard', () => {
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
    render(<ToolCatalogCard />)
    await waitFor(() => expect(screen.getByText(/Built-in tools \(2\)/)).toBeTruthy())
    expect(screen.getByText(/2 of 4 tools active/)).toBeTruthy()
    expect(screen.getByText(/connected . loaded on demand/)).toBeTruthy()
    expect(screen.getByText(/disabled . loaded every step/)).toBeTruthy()
    expect(screen.getByText('mcp__gh__get_file_contents')).toBeTruthy()
    expect(screen.getByText('mcp__ctx__expand_chunk')).toBeTruthy()
    expect(screen.getByText('code index disabled')).toBeTruthy()
    expect(screen.getByText('server disabled')).toBeTruthy()
    // Active is the norm and carries no label; each source line counts it.
    expect(screen.queryByText('active')).toBeNull()
    expect(screen.getByText('1/2 active')).toBeTruthy()
    expect(screen.getByText('0/1 active')).toBeTruthy()
  })

  it('collapses each source to one line until opened', async () => {
    const { container } = render(<ToolCatalogCard />)
    await waitFor(() => expect(screen.getByText(/Built-in tools \(2\)/)).toBeTruthy())
    const groups = container.querySelectorAll('details')
    expect(groups.length).toBe(3)
    groups.forEach((group) => expect(group.open).toBe(false))
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
    render(<ToolCatalogCard />)
    const summary = await screen.findByText('Agent-built tools (1)')
    expect(summary.closest('details')?.open).toBe(true)
    // tests/gui-e2e/agent-built-tools.spec.ts pins this sentence.
    expect(
      screen.getByText(/each call asks you, and asks again whenever the code changes/)
    ).toBeTruthy()
    expect(screen.getByText('Count TODO comments')).toBeTruthy()
    expect(screen.getByText(/Built-in tools \(2\)/).closest('details')?.open).toBe(false)
  })

  it('updates live from push events without a refetch', async () => {
    render(<ToolCatalogCard />)
    await waitFor(() => expect(screen.getByText('mcp__gh__get_file_contents')).toBeTruthy())
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
    expect(window.vyotiq.toolsCatalogGet).toHaveBeenCalledTimes(1)
  })

  it('renders nothing before data and still updates when the first push arrives', async () => {
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({ ok: false as const, error: 'boom' }))
    const { container } = render(<ToolCatalogCard />)
    await waitFor(() => expect(window.vyotiq.toolsCatalogGet).toHaveBeenCalled())
    expect(container.innerHTML).toBe('')
    act(() => {
      pushHandler?.(payload)
    })
    await waitFor(() => expect(screen.getByText('mcp__gh__get_file_contents')).toBeTruthy())
  })
})
