/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ToolGroup } from '@renderer/features/chat/components/ToolGroup'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import type { UiItem } from '@shared/transcript'

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

function toolItem(
  id: string,
  name: string,
  summary: string,
  status: 'running' | 'done' | 'fail' = 'done',
  groupTiming?: { startedAt: number; endedAt?: number }
): Extract<UiItem, { kind: 'tool' }> {
  return {
    kind: 'tool',
    id,
    groupTiming,
    tool: { id, name, summary, status }
  }
}

describe('ToolGroup', () => {
  it('shows shimmer label while pending', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'running', { startedAt: Date.now() }),
      toolItem('t2', 'search', 'query', 'running')
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Reading and searching')).toBeTruthy()
    expect(screen.getByText('1 file and 1 lookup')).toBeTruthy()
  })

  it('lists the calls as they land while the group is still running', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: Date.now() }),
      toolItem('t2', 'read', 'b.ts', 'running')
    ]
    render(<ToolGroup tools={tools} />)

    const toggle = screen.getByRole('button', { name: /Reading: 2 files/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(document.querySelectorAll('.vy-text-shimmer--active').length).toBeGreaterThan(1)
    const list = screen.getByTestId('tool-group-list')
    expect(list.className).not.toMatch(/overflow-y-auto/)
  })

  it('shows completed label and summary when group is closed', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 7_000 }),
      toolItem('t2', 'search', 'query', 'done')
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Read and searched')).toBeTruthy()
    expect(screen.getByText('1 file and 1 lookup')).toBeTruthy()
    expect(screen.getByText('6s')).toBeTruthy()
    expect(screen.queryByText('a.ts')).toBeNull()
    expect(screen.queryByTestId('tool-group-list')).toBeNull()
  })

  it('keeps nested rows visible when a grouped tool failed', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'write_file_check', 'placeholder', 'fail')
    ]
    tools[1]!.tool.content =
      'Unknown tool "write_file_check". Use edit or str_replace to change files.'
    render(<ToolGroup tools={tools} />)
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()
    expect(screen.getAllByText(/Write file check/i).length).toBeGreaterThan(0)
    expect(screen.queryByRole('button', { name: /^placeholder$/i })).toBeNull()
  })

  it('folds after tools finish even while the chat run is still live', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    tools[0]!.tool.content = 'alpha output'
    tools[1]!.tool.content = 'beta output'
    render(<ToolGroup tools={tools} live />)

    expect(screen.getByRole('button', { name: /Read: 2 files/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(screen.queryByTestId('tool-group-list')).toBeNull()
    expect(screen.queryByText('alpha output')).toBeNull()
    expect(screen.queryByText('beta output')).toBeNull()
  })

  it('stays folded after settle when live clears', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    const { rerender } = render(<ToolGroup tools={tools} live />)
    expect(screen.queryByTestId('tool-group-list')).toBeNull()

    rerender(<ToolGroup tools={tools} live={false} />)
    expect(screen.queryByTestId('tool-group-list')).toBeNull()
  })

  it('folds when the last pending tool finishes', async () => {
    const pending = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000 }),
      toolItem('t2', 'read', 'b.ts', 'running')
    ]
    const settled = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    const { rerender } = render(<ToolGroup tools={pending} live />)
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()

    rerender(<ToolGroup tools={settled} live={false} />)
    await waitFor(() => {
      expect(screen.queryByTestId('tool-group-list')).toBeNull()
    })
  })

  it('keeps the nested list in the transcript flow while pending', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000 }),
      toolItem('t2', 'read', 'b.ts', 'running')
    ]
    const { rerender } = render(<ToolGroup tools={tools} live />)
    const liveList = screen.getByTestId('tool-group-list')
    expect(liveList.className).not.toMatch(/overflow-y-auto/)
    expect(liveList.getAttribute('data-viewport-capped')).toBeNull()

    rerender(<ToolGroup tools={tools} live={false} groupExpanded />)
    expect(screen.getByTestId('tool-group-list').className).not.toMatch(/overflow-y-auto/)
  })

  it('unmounts the nested list after collapse when motion is reduced', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {}
      })
    })
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    const onGroupToggle = vi.fn()
    const { rerender } = render(
      <ToolGroup tools={tools} groupExpanded onGroupToggle={onGroupToggle} />
    )
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()
    expect(screen.getByText('a.ts')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Read: 2 files/i }))
    expect(onGroupToggle).toHaveBeenCalledWith(false)

    rerender(<ToolGroup tools={tools} groupExpanded={false} onGroupToggle={onGroupToggle} />)
    expect(screen.queryByTestId('tool-group-list')).toBeNull()
    expect(screen.queryByText('a.ts')).toBeNull()
  })

  it('unmounts the nested list after the close fallback when motion is on', async () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    const onGroupToggle = vi.fn()
    const { rerender } = render(
      <ToolGroup tools={tools} groupExpanded onGroupToggle={onGroupToggle} />
    )
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Read: 2 files/i }))
    rerender(<ToolGroup tools={tools} groupExpanded={false} onGroupToggle={onGroupToggle} />)

    const panel = document.querySelector('.tool-expand')
    expect(panel?.getAttribute('data-open')).toBe('false')
    expect(panel?.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('tool-group-list')).toBeTruthy()

    await waitFor(() => {
      expect(screen.queryByTestId('tool-group-list')).toBeNull()
    })
  })

  it('unmounts on grid-template-rows transitionend before the fallback timer', async () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts', 'done')
    ]
    const onGroupToggle = vi.fn()
    const { rerender } = render(
      <ToolGroup tools={tools} groupExpanded onGroupToggle={onGroupToggle} />
    )
    fireEvent.click(screen.getByRole('button', { name: /Read: 2 files/i }))
    rerender(<ToolGroup tools={tools} groupExpanded={false} onGroupToggle={onGroupToggle} />)

    const panel = document.querySelector('.tool-expand')
    expect(panel).toBeTruthy()
    fireEvent.transitionEnd(panel!, { propertyName: 'grid-template-rows' })
    await waitFor(() => {
      expect(screen.queryByTestId('tool-group-list')).toBeNull()
    })
  })

  it('marks an interrupted group without hiding what it did', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'fail', { startedAt: 1_000, endedAt: 2_000 })
    ]
    tools[0]!.tool.content = 'Cancelled'
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('interrupted')).toBeTruthy()
    // In-progress verb: work did not complete.
    expect(screen.getByText('Reading')).toBeTruthy()
    expect(screen.queryByText('Read')).toBeNull()
    expect(screen.getByText(/a\.ts/)).toBeTruthy()
  })

  it('shows Asking interrupted for cancelled ask_question, not Asked', () => {
    const tools = [
      toolItem('t1', 'ask_question', 'Pick one', 'fail', { startedAt: 1_000, endedAt: 2_000 })
    ]
    tools[0]!.tool.content = 'Cancelled'
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('interrupted')).toBeTruthy()
    expect(screen.getByText('Asking')).toBeTruthy()
    expect(screen.queryByText('Asked')).toBeNull()
  })

  it('marks only the cancelled nested tool as interrupted, not completed siblings', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 1_500 }),
      toolItem('t2', 'ask_question', 'Pick one', 'fail', { startedAt: 1_500, endedAt: 2_000 })
    ]
    tools[1]!.tool.content = 'Cancelled'
    render(<ToolGroup tools={tools} groupExpanded />)
    const interrupted = screen.getAllByText('interrupted')
    // Group header + cancelled nested row only.
    expect(interrupted).toHaveLength(2)
    const doneRow = screen.getByLabelText('a.ts')
    const cancelledRow = screen.getByLabelText(/Pick one/)
    expect(doneRow.textContent).not.toContain('interrupted')
    expect(cancelledRow.textContent).toContain('interrupted')
  })

  it('does not duplicate list_dir path in the expanded body when shown as activity', () => {
    const tools = [
      toolItem('t1', 'list_dir', 'src', 'done', { startedAt: 1_000, endedAt: 2_000 })
    ]
    tools[0]!.tool.content = JSON.stringify({
      path: 'src',
      entries: [{ name: 'a.ts', type: 'file' }]
    })
    tools[0]!.tool.argsPreview = '{"path":"src"}'
    render(<ToolGroup tools={tools} groupExpanded />)
    // Path appears in the compact subtitle; body keeps Directory chrome only.
    expect(screen.getByText('Directory')).toBeTruthy()
    expect(screen.getAllByText(/src/).length).toBe(1)
  })

  it('does not duplicate grep pattern chip when shown in a multi-tool group', () => {
    const tools = [
      toolItem('g1', 'grep', 'TODO', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('r1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 })
    ]
    tools[0]!.tool.argsPreview = '{"pattern":"TODO"}'
    tools[0]!.tool.content = JSON.stringify({
      pattern: 'TODO',
      matchCount: 1,
      groups: [{ file: 'a.ts', matches: [{ line: 1, text: 'TODO' }] }]
    })
    tools[0]!.toolExpanded = true
    tools[1]!.tool.content = 'file'
    render(<ToolGroup tools={tools} groupExpanded />)
    // Pattern is the nested row title; body must not repeat /TODO/ chip.
    expect(screen.getAllByText(/TODO/).length).toBe(1)
  })

  it('honors persisted groupExpanded=false for nested tools in a multi-tool group', () => {
    const tools = [
      toolItem('t1', 'todo_write', 'Plan', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 })
    ]
    tools[0]!.tool.content = '{"items":[]}'
    tools[1]!.tool.content = 'file contents'
    tools[0]!.groupExpanded = false
    render(<ToolGroup tools={tools} groupExpanded={false} />)
    expect(screen.queryByText('file contents')).toBeNull()
  })

  it('honors persisted groupExpanded=false while a tool is still running', () => {
    const tools = [toolItem('t1', 'terminal', 'npm test', 'running')]
    tools[0]!.tool.content = 'live output'
    tools[0]!.groupExpanded = false
    render(<ToolGroup tools={tools} groupExpanded={false} />)
    expect(screen.queryByText('live output')).toBeNull()
  })

  it('honors persisted groupExpanded for a lone idle tool', () => {
    const tools = [toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 })]
    tools[0]!.tool.content = 'file contents'
    const { rerender } = render(<ToolGroup tools={tools} groupExpanded={false} />)
    expect(screen.queryByText('file contents')).toBeNull()

    rerender(<ToolGroup tools={tools} groupExpanded />)
    expect(screen.getByText('file contents')).toBeTruthy()
  })

  it('names the group after a single kind of work', () => {
    render(
      <ToolGroup
        tools={[
          toolItem('t1', 'terminal', 'npm run build'),
          toolItem('t2', 'terminal', 'npm test')
        ]}
      />
    )
    expect(screen.getByText('Ran')).toBeTruthy()
    expect(screen.getByText('2 commands')).toBeTruthy()
  })

  it('keeps every opened call open, not just the first', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'read', 'b.ts'),
      toolItem('t3', 'read', 'c.ts')
    ]
    tools[0]!.tool.content = 'alpha output'
    tools[1]!.tool.content = 'beta output'
    tools[2]!.tool.content = 'gamma output'
    tools[0]!.toolExpanded = true
    tools[2]!.toolExpanded = true

    render(
      <ToolGroup tools={tools} groupExpanded />
    )

    expect(screen.getByText('alpha output')).toBeTruthy()
    expect(screen.getByText('gamma output')).toBeTruthy()
    expect(screen.queryByText('beta output')).toBeNull()
  })

  it('follows the host disclosure state instead of local state', () => {
    const tools = [toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 })]
    tools[0]!.tool.content = 'alpha output'
    const onToolToggle = vi.fn()

    const { rerender } = render(<ToolGroup tools={tools} onToolToggle={onToolToggle} />)
    fireEvent.click(screen.getByRole('button', { name: /Read/i }))

    expect(onToolToggle).toHaveBeenCalledWith('t1', true)
    // Still closed: the host owns toolExpanded and has not applied the change yet.
    expect(screen.queryByText('alpha output')).toBeNull()

    tools[0]!.toolExpanded = true
    rerender(<ToolGroup tools={[...tools]} onToolToggle={onToolToggle} />)
    expect(screen.getByText('alpha output')).toBeTruthy()
  })

  it('spans elapsed time across batches that only carry partial timing', () => {
    render(
      <ToolGroup
        tools={[
          toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 3_000 }),
          toolItem('t2', 'read', 'b.ts'),
          toolItem('t3', 'read', 'c.ts', 'done', { startedAt: 4_000, endedAt: 9_000 })
        ]}
      />
    )
    expect(screen.getByText('8s')).toBeTruthy()
  })

  it('keeps nested file-read bodies collapsed while a sibling is still running', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: Date.now() }),
      toolItem('t2', 'read', 'b.ts', 'running')
    ]
    tools[0]!.tool.content = 'alpha output'
    tools[1]!.tool.content = 'beta output'

    render(<ToolGroup tools={tools} />)

    expect(screen.getByRole('button', { name: /Reading: 2 files/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByText(/a\.ts/)).toBeTruthy()
    expect(screen.getByText(/b\.ts/)).toBeTruthy()
    expect(screen.queryByText('alpha output')).toBeNull()
    expect(screen.queryByText('beta output')).toBeNull()
  })



  it('omits status dots on compact rows', () => {
    const tools = [
      toolItem('t1', 'read', 'a.ts', 'done', { startedAt: 1_000, endedAt: 2_000 }),
      toolItem('t2', 'search', 'query', 'done')
    ]
    render(<ToolGroup tools={tools} />)
    fireEvent.click(screen.getByRole('button', { name: /Read and searched/i }))
    const fileRow = screen.getByRole('button', { name: /a\.ts/i })
    expect(fileRow.querySelector('.rounded-full')).toBeNull()
  })

  it('keeps auto-expand for running siblings when another tool has explicit toolExpanded', () => {
    const tools = [
      { ...toolItem('s1', 'grep', 'TODO', 'done'), toolExpanded: true },
      toolItem('s2', 'grep', 'FIXME', 'running')
    ]
    tools[0]!.tool.argsPreview = '{"pattern":"TODO"}'
    tools[0]!.tool.content = 'a.ts:1: match-alpha'
    tools[1]!.tool.argsPreview = '{"pattern":"FIXME"}'
    tools[1]!.tool.content = 'b.ts:2: match-beta'

    render(<ToolGroup tools={tools} />)

    // Explicit expand on s1 must not suppress defaultExpanded for running s2.
    expect(screen.getByText('match-alpha')).toBeTruthy()
    expect(screen.getByText('match-beta')).toBeTruthy()
  })

  it('auto-expands a failed read so the error is visible', () => {
    const tools = [toolItem('t1', 'read', 'missing.ts', 'fail')]
    tools[0]!.tool.content = 'ENOENT: no such file'

    render(<ToolGroup tools={tools} />)

    expect(screen.getByText('ENOENT: no such file')).toBeTruthy()
  })

  it('still renders a single tool when item id and tool id diverge', () => {
    const tools = [
      {
        kind: 'tool' as const,
        id: 'ui-item-id',
        tool: {
          id: 'tool-row-id',
          name: 'read',
          summary: 'a.ts',
          status: 'done' as const,
          content: 'file body'
        },
        toolExpanded: true
      }
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText('Read')).toBeTruthy()
    expect(screen.getByText('file body')).toBeTruthy()
  })

  it('opens a nested file from a sibling control instead of a nested button', () => {
    const openFile = vi.fn()
    const tools = [
      toolItem(
        't1',
        'read',
        'src/renderer/src/features/chat/SessionChatColumn.tsx',
        'running',
        { startedAt: Date.now() }
      ),
      toolItem(
        't2',
        'read',
        'src/renderer/src/features/chat/ChatView.tsx',
        'running'
      )
    ]
    tools[0]!.tool.argsPreview = JSON.stringify({
      path: 'src/renderer/src/features/chat/SessionChatColumn.tsx'
    })
    render(
      <RunSessionProvider
        value={{
          workspacePath: '/ws/demo',
          runId: 'run-1',
          onOpenWorkspaceFile: openFile
        }}
      >
        <ToolGroup tools={tools} />
      </RunSessionProvider>
    )

    const openBtn = screen.getByRole('button', {
      name: 'Open src/renderer/src/features/chat/SessionChatColumn.tsx'
    })
    expect(openBtn.parentElement?.tagName).not.toBe('BUTTON')
    fireEvent.click(openBtn)
    expect(openFile).toHaveBeenCalledWith(
      'src/renderer/src/features/chat/SessionChatColumn.tsx'
    )
  })
})
