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
    expect(screen.getAllByText('active').length).toBe(2)
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
