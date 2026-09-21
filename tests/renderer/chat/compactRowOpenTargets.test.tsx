/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { CompactRow, getToolHeaderMeta } from '@renderer/features/chat/toolUi'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import type { UiToolRow } from '@shared/transcript'

const WS = '/ws'

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

function renderRow(
  props: Partial<Parameters<typeof CompactRow>[0]>,
  session: Record<string, unknown> = {}
) {
  return render(
    <RunSessionProvider
      value={{ workspacePath: WS, runId: 'run1', ...session } as never}
    >
      <CompactRow
        title="Read"
        subtitle="a.ts"
        status="done"
        expanded={false}
        onToggle={() => {}}
        {...props}
      />
    </RunSessionProvider>
  )
}

describe('CompactRow file badge', () => {
  it('opens a relative path with its line', () => {
    const open = vi.fn()
    renderRow({ filePath: 'src/a.ts', fileLine: 12 }, { onOpenWorkspaceFile: open })
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts:12' }))
    expect(open).toHaveBeenCalledWith('src/a.ts', { line: 12 })
  })

  it('normalizes an absolute in-workspace path', () => {
    const open = vi.fn()
    renderRow({ filePath: '/ws/src/a.ts' }, { onOpenWorkspaceFile: open })
    fireEvent.click(screen.getByRole('button', { name: 'Open src/a.ts' }))
    expect(open).toHaveBeenCalledWith('src/a.ts')
  })

  it('stays inert for a path outside the workspace', () => {
    const open = vi.fn()
    renderRow({ filePath: '/etc/passwd' }, { onOpenWorkspaceFile: open })
    expect(screen.queryByRole('button', { name: /^Open / })).toBeNull()
  })

  it('does not swallow the disclosure toggle', () => {
    const toggle = vi.fn()
    renderRow(
      { filePath: 'src/a.ts', onToggle: toggle },
      { onOpenWorkspaceFile: vi.fn() }
    )
    fireEvent.click(screen.getByRole('button', { name: /Expand Read/i }))
    expect(toggle).toHaveBeenCalledTimes(1)
  })
})

describe('CompactRow panel icon', () => {
  it('opens the named dock panel', () => {
    const openPanel = vi.fn()
    renderRow(
      { title: 'Opened pull request', icon: 'pullRequest', opensPanel: 'pr' },
      { onOpenPanel: openPanel }
    )
    fireEvent.click(screen.getByRole('button', { name: 'Opened pull request — open panel' }))
    expect(openPanel).toHaveBeenCalledWith('pr')
  })

  it('renders a plain icon when the host provides no panel opener', () => {
    renderRow({ title: 'Opened pull request', icon: 'pullRequest', opensPanel: 'pr' })
    expect(screen.queryByRole('button', { name: /open panel/i })).toBeNull()
  })
})

describe('github PR tools declare the pr panel', () => {
  function tool(name: string): UiToolRow {
    return { id: 't', name, summary: 'feat: thing', status: 'done' }
  }

  it('maps pr_create and pr_review to the pr panel', () => {
    expect(getToolHeaderMeta(tool('github_pr_create')).opensPanel).toBe('pr')
    expect(getToolHeaderMeta(tool('github_pr_review')).opensPanel).toBe('pr')
  })

  it('leaves github_issue unlinked — an issue is not in the PR panel', () => {
    expect(getToolHeaderMeta(tool('github_issue')).opensPanel).toBeUndefined()
  })
})
