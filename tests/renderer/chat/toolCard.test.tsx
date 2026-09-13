/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard } from '@renderer/features/chat/components/ToolCard'
import type { ToolItem } from '@renderer/features/chat/utils/transcriptRows'
import { TOOL_TERMINAL_VIEWPORT_MAX_PX } from '@renderer/lib/utils/layout'

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
  vi.useRealTimers()
})

function editItem(status: 'running' | 'done' | 'fail'): ToolItem {
  return {
    kind: 'tool',
    id: 'e1',
    tool: {
      id: 'e1',
      name: 'edit',
      summary: 'src/a.ts',
      status,
      argsPreview: JSON.stringify({ path: 'src/a.ts', contents: 'hello\nworld\n' })
    }
  }
}

function terminalItem(
  status: 'running' | 'done' | 'fail',
  overrides?: Partial<ToolItem['tool']>,
  itemOverrides?: Partial<Pick<ToolItem, 'at' | 'groupTiming'>>
): ToolItem {
  return {
    kind: 'tool',
    id: 't1',
    tool: {
      id: 't1',
      name: 'terminal',
      summary: 'pnpm test',
      status,
      argsPreview: JSON.stringify({ command: 'pnpm test' }),
      presentation: 'prominent',
      content:
        status === 'running'
          ? 'line\n'.repeat(40)
          : 'cwd: /ws\nshell: powershell\n\nok\nexit_code: 0',
      ...overrides
    },
    ...itemOverrides
  }
}

describe('ToolCard expand', () => {
  it('keeps done edits collapsed by default (14-line peek, not full patch)', () => {
    render(<ToolCard item={editItem('done')} />)
    const toggle = screen.getByRole('button', { name: /Expand Edited/i })
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(document.querySelector('.mask-fade-bottom')).toBeTruthy()
  })

  it('honors an explicit expanded prop', () => {
    render(<ToolCard item={editItem('done')} expanded />)
    expect(screen.getByRole('button', { name: /Collapse Edited/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(document.querySelector('.mask-fade-bottom')).toBeNull()
  })

  it('folds terminal body after finish via ExpandPanel (no clamp peek)', () => {
    render(<ToolCard item={terminalItem('done')} />)
    expect(screen.getByRole('button', { name: /Expand Ran/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(document.querySelector('[data-tool-card-body]')).toBeNull()
    expect(document.querySelector('.mask-fade-bottom')).toBeNull()
  })

  it('auto-expands a running terminal', () => {
    render(<ToolCard item={terminalItem('running')} />)
    expect(screen.getByRole('button', { name: /Collapse Running/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(document.querySelector('[data-tool-card-body]')).toBeTruthy()
    expect(document.querySelector('.tool-expand')?.getAttribute('data-open')).toBe('true')
  })

  it('keeps a failed terminal expanded after settle', () => {
    render(<ToolCard item={terminalItem('fail')} />)
    expect(screen.getByRole('button', { name: /Collapse Failed/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
  })

  it('auto-expands failed edits and shows the error before the proposed patch', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-fail',
      tool: {
        id: 'e-fail',
        name: 'edit',
        summary: 'index.html',
        status: 'fail',
        content: 'No unified-diff hunks found (need @@ headers)',
        argsPreview: JSON.stringify({
          path: 'index.html',
          diff: '@@\n-old\n+new\n'
        })
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.getByRole('button', { name: /Collapse Failed/i }).getAttribute('aria-expanded')).toBe(
      'true'
    )
    expect(screen.getByText(/No unified-diff hunks found/i)).toBeTruthy()
    expect(screen.getByText('Not applied')).toBeTruthy()
    expect(screen.queryByText('+2')).toBeNull()
  })

  it('shows a Material file-type icon for edit cards', () => {
    render(<ToolCard item={editItem('done')} />)
    const icon = document.querySelector('img[src*="file-icons"]') as HTMLImageElement | null
    expect(icon).toBeTruthy()
    expect(icon!.getAttribute('src') ?? '').toMatch(/typescript\.svg/)
  })

  it('keeps path-only streaming args as a header without raw JSON in the body', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-stream',
      tool: {
        id: 'e-stream',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: '{"path":"a.ts","di'
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.queryByTestId('edit-live-stream')).toBeNull()
    expect(screen.queryByText('Receiving edit…')).toBeNull()
    expect(screen.queryByText('Streaming change…')).toBeNull()
    expect(screen.queryByText('Editing a.ts…')).toBeNull()
    expect(screen.getByRole('button', { name: /^Editing a\.ts$/i })).toBeTruthy()
  })

  it('keeps chrome-only empty args as a header without an empty diff panel', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-empty',
      tool: {
        id: 'e-empty',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: ''
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.queryByText('Receiving edit…')).toBeNull()
    expect(screen.queryByTestId('edit-live-stream')).toBeNull()
    expect(screen.queryByText('file')).toBeNull()
    expect(screen.getByRole('button', { name: /^Editing$/i })).toBeTruthy()
  })

  it('does not paint a JSON opener as the diff body', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-brace',
      tool: {
        id: 'e-brace',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: '{'
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.queryByTestId('edit-live-stream')).toBeNull()
    expect(screen.queryByText('Receiving edit…')).toBeNull()
    expect(screen.getByRole('button', { name: /^Editing$/i })).toBeTruthy()
  })

  it('does not paint a hunk header alone as the diff body', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-hunk',
      tool: {
        id: 'e-hunk',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: '{"path":"a.ts","diff":"@@'
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.queryByText('@@')).toBeNull()
    expect(screen.queryByText('Receiving edit…')).toBeNull()
    expect(screen.queryByText('Streaming change…')).toBeNull()
    expect(screen.getByRole('button', { name: /^Editing a\.ts$/i })).toBeTruthy()
  })

  it('paints diff lines while argsPreview JSON is still incomplete', () => {
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-live',
      tool: {
        id: 'e-live',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: '{"path":"src/live.ts","diff":"@@\\n-old\\n+streamed line'
      }
    }
    const { rerender } = render(<ToolCard item={item} />)
    // Collapsed peek — but body stays mounted and unclamped so newest lines paint.
    expect(screen.getByRole('button', { name: /Expand/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
    expect(document.querySelector('.mask-fade-bottom')).toBeNull()
    expect(screen.queryByText('Streaming change…')).toBeNull()
    expect(screen.getByText('streamed line')).toBeTruthy()
    expect(screen.getByText('old')).toBeTruthy()
    // Header badge and the new diff gutter sign both read "+1" now.
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getByText('-1')).toBeTruthy()

    rerender(
      <ToolCard
        item={{
          ...item,
          tool: {
            ...item.tool,
            argsPreview: '{"path":"src/live.ts","diff":"@@\\n-old\\n+streamed line\\n+second'
          }
        }}
      />
    )
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.getAllByText('+2').length).toBeGreaterThan(0)
  })

  it('follows newest lines in the peek after a dumped patch has been revealed', () => {
    vi.useFakeTimers()
    const adds = Array.from({ length: 20 }, (_, i) => `+line-${i + 1}`).join('\\n')
    const item: ToolItem = {
      kind: 'tool',
      id: 'e-tail',
      tool: {
        id: 'e-tail',
        name: 'edit',
        summary: 'big.ts',
        status: 'running',
        argsPreview: `{"path":"big.ts","diff":"@@\\n${adds}`
      }
    }
    render(<ToolCard item={item} />)
    expect(screen.queryByText('line-20')).toBeNull()
    act(() => {
      vi.advanceTimersByTime(2000)
    })
    expect(screen.getByText('line-20')).toBeTruthy()
    expect(screen.getByText('line-7')).toBeTruthy()
    // Head of the stream is outside the 14-line peek.
    expect(screen.queryByText('line-1')).toBeNull()
    expect(screen.queryByText('line-6')).toBeNull()
    // No bottom fade while running — newest line must stay visible.
    expect(document.querySelector('.mask-fade-bottom')).toBeNull()
    vi.useRealTimers()
  })
})

describe('ToolCard terminal fixed viewport', () => {
  it('keeps long streaming output inside a capped scroll viewport', () => {
    render(<ToolCard item={terminalItem('running')} />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.className).toMatch(/max-h-/)
    expect(viewport.className).toMatch(/overflow-y-auto/)
    expect(screen.getByText('$ pnpm test')).toBeTruthy()
    // Many output lines must not remove the height cap.
    expect(viewport.textContent).toContain('line')
  })

  it('shows command + meta in the viewport before streams arrive', () => {
    render(
      <ToolCard
        item={terminalItem('running', {
          content: undefined,
          argsPreview: JSON.stringify({ command: 'Get-ChildItem' })
        })}
      />
    )
    expect(screen.getByTestId('terminal-viewport')).toBeTruthy()
    expect(screen.getByText('$ Get-ChildItem')).toBeTruthy()
  })

  it('renders settled cwd/shell meta with dashed dividers and $ command', () => {
    render(<ToolCard item={terminalItem('done')} expanded />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.textContent).toContain('cwd: /ws')
    expect(viewport.textContent).toContain('shell: powershell')
    expect(viewport.textContent).toContain('---')
    expect(viewport.textContent).toContain('$ pnpm test')
    expect(viewport.textContent).toContain('ok')
  })

  it('prefers started_at / ran_for_ms when ToolItem timing exists', () => {
    const startedAt = Date.parse('2026-08-01T09:02:08.030Z')
    render(
      <ToolCard
        item={terminalItem('done', undefined, {
          groupTiming: { startedAt, endedAt: startedAt + 580931 }
        })}
        expanded
      />
    )
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.textContent).toContain('started_at: 2026-08-01T09:02:08.030Z')
    expect(viewport.textContent).toContain('ran_for_ms: 580931')
    // Timing and workspace meta both show when available.
    expect(viewport.textContent).toContain('cwd: /ws')
    expect(viewport.textContent).toContain('shell: powershell')
    expect(viewport.getAttribute('role')).toBe('region')
    expect(viewport.getAttribute('aria-label')).toBe('Terminal output')
  })

  it('hides the exit badge for an in-progress session frame (placeholder exit_code: -1)', () => {
    render(
      <ToolCard
        item={terminalItem('running', {
          content:
            'session_id: abc\nstatus: running\ncommand: pnpm test\ncwd: /ws\nshell: powershell\nexit_code: -1'
        })}
      />
    )
    expect(screen.queryByText('failed (-1)')).toBeNull()
  })

  it('still flags a finished session that closed with the placeholder exit code', () => {
    render(
      <ToolCard
        item={terminalItem('done', {
          content:
            'session_id: abc\nstatus: aborted\ncommand: pnpm test\ncwd: /ws\nshell: powershell\nexit_code: -1'
        })}
      />
    )
    expect(screen.getByText('failed (-1)')).toBeTruthy()
  })

  it('shows multi-line command as first line + N+ in the header secondary', () => {
    render(
      <ToolCard
        item={terminalItem('done', {
          argsPreview: JSON.stringify({ command: 'Get-ChildItem\nSelect-Object\nFormat-List' }),
          content: 'cwd: /ws\nshell: powershell\n\nok\nexit_code: 0'
        })}
        expanded
      />
    )
    expect(screen.getByText('Get-ChildItem, 2+')).toBeTruthy()
    expect(screen.getByText(/\$ Get-ChildItem/)).toBeTruthy()
  })

  it('auto-scrolls to the bottom while running when pinned', () => {
    const { rerender } = render(<ToolCard item={terminalItem('running', { content: 'a\n' })} />)
    const viewport = screen.getByTestId('terminal-viewport')
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 192 })
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => (viewport as HTMLElement & { _scrollTop?: number })._scrollTop ?? 0,
      set: (v: number) => {
        ;(viewport as HTMLElement & { _scrollTop?: number })._scrollTop = v
      }
    })

    rerender(
      <ToolCard item={terminalItem('running', { content: `${'line\n'.repeat(60)}` })} />
    )
    expect(viewport.scrollTop).toBe(800)
  })

  it('stops auto-follow after the user scrolls up inside the viewport', () => {
    const { rerender } = render(
      <ToolCard item={terminalItem('running', { content: 'start\n' })} />
    )
    const viewport = screen.getByTestId('terminal-viewport')
    Object.defineProperty(viewport, 'scrollHeight', { configurable: true, get: () => 800 })
    Object.defineProperty(viewport, 'clientHeight', { configurable: true, get: () => 192 })
    let scrollTop = 0
    Object.defineProperty(viewport, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (v: number) => {
        scrollTop = v
      }
    })

    scrollTop = 10
    fireEvent.scroll(viewport)
    rerender(
      <ToolCard item={terminalItem('running', { content: `${'more\n'.repeat(40)}` })} />
    )
    // Pinned latch cleared — effect must not force scrollTop to scrollHeight.
    expect(scrollTop).toBe(10)
  })

  it('keeps the viewport cap after the turn settles while still expanded', () => {
    render(<ToolCard item={terminalItem('done')} expanded />)
    const viewport = screen.getByTestId('terminal-viewport')
    expect(viewport.className).toMatch(/max-h-/)
    // Constant stays aligned with layout token used by the virtualizer.
    expect(TOOL_TERMINAL_VIEWPORT_MAX_PX).toBe(192)
  })
})
