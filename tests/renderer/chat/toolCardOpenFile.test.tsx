/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ToolCard } from '@renderer/features/chat/components/ToolCard'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { firstChangedLineInDiff } from '@renderer/features/chat/toolUi'
import type { ToolItem } from '@renderer/features/chat/utils/transcriptRows'

const WS = 'C:\\ws'

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

afterEach(() => cleanup())

function editItem(args: Record<string, unknown>): ToolItem {
  return {
    kind: 'tool',
    id: 'e1',
    tool: {
      id: 'e1',
      name: 'edit',
      summary: String(args.path ?? ''),
      status: 'done',
      argsPreview: JSON.stringify(args)
    }
  }
}

function readItem(args: Record<string, unknown>): ToolItem {
  return {
    kind: 'tool',
    id: 'r1',
    tool: {
      id: 'r1',
      name: 'read',
      summary: String(args.path ?? ''),
      status: 'done',
      argsPreview: JSON.stringify(args),
      content: 'const a = 1\n'
    }
  }
}

function renderWithSession(
  item: ToolItem,
  onOpenWorkspaceFile: ReturnType<typeof vi.fn>,
  workspacePath: string | null = WS
) {
  return render(
    <RunSessionProvider
      value={{ workspacePath, runId: 'run1', onOpenWorkspaceFile }}
    >
      <ToolCard item={item} />
    </RunSessionProvider>
  )
}

describe('ToolCard file badge opens the Files panel', () => {
  it('opens a workspace-relative edit path', () => {
    const open = vi.fn()
    renderWithSession(editItem({ path: 'src/a.ts', contents: 'x\n' }), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(open).toHaveBeenCalledWith('src/a.ts')
  })

  it('normalizes an absolute path inside the workspace before opening', () => {
    const open = vi.fn()
    renderWithSession(editItem({ path: 'C:\\ws\\src\\a.ts', contents: 'x\n' }), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(open).toHaveBeenCalledWith('src/a.ts')
  })

  it('renders an inert badge for a path outside the workspace', () => {
    const open = vi.fn()
    renderWithSession(editItem({ path: 'C:\\Windows\\System32\\cmd.exe', contents: 'x\n' }), open)
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })

  it('renders an inert badge when no file-open handler is provided', () => {
    render(
      <RunSessionProvider value={{ workspacePath: WS, runId: 'run1' }}>
        <ToolCard item={editItem({ path: 'src/a.ts', contents: 'x\n' })} />
      </RunSessionProvider>
    )
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })

  it('passes the first changed line of a unified diff', () => {
    const open = vi.fn()
    const diff = ['@@ -40,6 +40,7 @@', ' ctx one', ' ctx two', '+added here', ' ctx three'].join(
      '\n'
    )
    renderWithSession(editItem({ path: 'src/a.ts', diff }), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts:42' }))
    expect(open).toHaveBeenCalledWith('src/a.ts', { line: 42 })
  })

  it('passes a requested read range start line', () => {
    const open = vi.fn()
    renderWithSession(readItem({ path: 'src/a.ts', startLine: 120, endLine: 140 }), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts:120' }))
    expect(open).toHaveBeenCalledWith('src/a.ts', { line: 120 })
  })

  it('sends no line for a whole-file read', () => {
    const open = vi.fn()
    renderWithSession(readItem({ path: 'src/a.ts' }), open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(open).toHaveBeenCalledWith('src/a.ts')
  })

  it('sends no line for str_replace, whose line numbers are not file lines', () => {
    const open = vi.fn()
    const item = editItem({ path: 'src/a.ts', old_string: 'a\nb', new_string: 'c\nd' })
    item.tool.name = 'str_replace'
    renderWithSession(item, open)
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(open).toHaveBeenCalledWith('src/a.ts')
  })

  it('still toggles the disclosure when the badge is not the click target', () => {
    const open = vi.fn()
    renderWithSession(editItem({ path: 'src/a.ts', contents: 'x\ny\n' }), open)
    const toggle = screen.getByRole('button', { name: /Expand|Collapse/i })
    const before = toggle.getAttribute('aria-expanded')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).not.toBe(before)
    expect(open).not.toHaveBeenCalled()
  })
})

describe('firstChangedLineInDiff', () => {
  it('counts context lines to reach the first addition', () => {
    const diff = ['@@ -10,4 +10,5 @@', ' one', ' two', '+new', ' three'].join('\n')
    expect(firstChangedLineInDiff(diff)).toBe(12)
  })

  it('returns the hunk start when the change is the first body line', () => {
    expect(firstChangedLineInDiff(['@@ -10,4 +10,5 @@', '+new'].join('\n'))).toBe(10)
  })

  it('lands on the new-file line for a deletion', () => {
    const diff = ['@@ -10,4 +10,3 @@', ' one', '-gone', ' two'].join('\n')
    expect(firstChangedLineInDiff(diff)).toBe(11)
  })

  it('skips the no-newline annotation without advancing', () => {
    const diff = ['@@ -1,2 +1,2 @@', ' one', '\\ No newline at end of file', '+two'].join('\n')
    expect(firstChangedLineInDiff(diff)).toBe(2)
  })

  it('handles a hunk header without line counts', () => {
    expect(firstChangedLineInDiff(['@@ -5 +7 @@', '+x'].join('\n'))).toBe(7)
  })

  it('skips git metadata preceding the first hunk', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      'index 111..222 100644',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -3,2 +3,3 @@',
      ' ctx',
      '+added'
    ].join('\n')
    expect(firstChangedLineInDiff(diff)).toBe(4)
  })

  it('returns null when there is no hunk header', () => {
    expect(firstChangedLineInDiff('just some text\n+not a diff')).toBeNull()
    expect(firstChangedLineInDiff('')).toBeNull()
  })
})
