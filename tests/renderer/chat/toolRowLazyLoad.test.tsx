/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { ToolRowOutput } from '@renderer/features/chat/components/ToolRow'
import { ToolBodyView } from '@renderer/features/chat/toolUi'
import { TOOL_RESULT_IPC_PREVIEW_CHARS } from '@shared/utils/toolResultIpc'

afterEach(() => {
  cleanup()
})

describe('ToolRowOutput lazy load', () => {
  it('does not fetch full content for truncated file reads', async () => {
    const preview = `${'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS)}\n…`
    const load = vi.fn().mockResolvedValue('x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS + 800))

    render(
      <ToolRowOutput
        tool={{
          id: 'call-1',
          name: 'read',
          summary: 'big.ts',
          status: 'done',
          content: preview,
          contentTruncated: true
        }}
        onLoadFullContent={load}
      />
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(load).not.toHaveBeenCalled()
  })

  it('does not fetch truncated content while collapsed', async () => {
    const preview = `${'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS)}\n…`
    const load = vi.fn().mockResolvedValue('full')

    render(
      <ToolBodyView
        context={{
          tool: {
            id: 'call-collapsed',
            name: 'read',
            summary: 'big.ts',
            status: 'done',
            content: preview,
            contentTruncated: true
          },
          expanded: false,
          onLoadFullContent: load
        }}
      />
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(load).not.toHaveBeenCalled()
  })

  it('does not fetch when content is not truncated', () => {
    const load = vi.fn()

    render(
      <ToolRowOutput
        tool={{
          id: 'call-2',
          name: 'read',
          summary: 'small.ts',
          status: 'done',
          content: 'hello'
        }}
        onLoadFullContent={load}
      />
    )

    expect(load).not.toHaveBeenCalled()
  })

  it('fetches full content for truncated non-file-read results when expanded', async () => {
    const preview = `${'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS)}\n…`
    const load = vi.fn().mockResolvedValue('x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS + 800))

    render(
      <ToolBodyView
        context={{
          tool: {
            id: 'call-search',
            name: 'search',
            summary: 'Audit',
            status: 'done',
            content: preview,
            contentTruncated: true
          },
          expanded: true,
          onLoadFullContent: load
        }}
      />
    )

    await waitFor(() => {
      expect(load).toHaveBeenCalledWith('call-search')
    })
  })
})
