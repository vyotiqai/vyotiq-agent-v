/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, renderHook, waitFor, cleanup } from '@testing-library/react'
import { FilesPanel } from '@renderer/features/chat/components/FilesPanel'
import { useAgentFileFocus } from '@renderer/features/chat/components/ChatStreamLeaves'
import { clearFileSession } from '@renderer/features/chat/components/fileSessionStore'
import type { UiItem } from '@shared/transcript'

const workspacePath = 'C:/fixtures/follow-agent'

function toolItem(
  id: string,
  name: string,
  args: Record<string, unknown>,
  status: UiItem extends { kind: 'tool'; tool: infer T }
    ? T extends { status: infer S }
      ? S
      : never
    : never = 'done' as never
): UiItem {
  return {
    kind: 'tool',
    id,
    tool: {
      id,
      name,
      summary: String(args.path ?? ''),
      status,
      argsPreview: JSON.stringify(args)
    }
  } as UiItem
}

function fileRead(path: string) {
  return {
    ok: true,
    data: {
      path,
      kind: 'text',
      content: `// ${path}\n`,
      encoding: 'utf8',
      eol: 'lf',
      bom: false,
      size: 8,
      version: { size: 8, mtimeMs: 1, sha256: 'a'.repeat(64) },
      truncated: false
    }
  }
}

const api = {
  workspaceFileList: vi.fn(() =>
    Promise.resolve({ ok: true, data: { path: '', entries: [], hasMore: false } })
  ),
  workspaceFileRead: vi.fn((payload: { path: string }) =>
    Promise.resolve(fileRead(payload.path))
  ),
  workspaceEditorRecoverySave: vi.fn(),
  workspaceEditorRecoveryClear: vi.fn()
}

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: api
  })
  localStorage.clear()
  clearFileSession(workspacePath)
  api.workspaceFileRead.mockClear()
  api.workspaceFileList.mockClear()
})

afterEach(() => {
  cleanup()
  clearFileSession(workspacePath)
  localStorage.clear()
})

describe('useAgentFileFocus', () => {
  it('reports nothing before the run starts writing', () => {
    const { result } = renderHook(() => useAgentFileFocus(false, [], undefined))
    expect(result.current).toBeNull()
  })

  it('reports the most recent write target', () => {
    const items = [
      toolItem('1', 'edit', { path: 'src/a.ts' }),
      toolItem('2', 'edit', { path: 'src/b.ts' })
    ]
    const { result } = renderHook(() => useAgentFileFocus(true, items, undefined))
    expect(result.current?.path).toBe('src/b.ts')
  })

  it('ignores reads — following them would thrash the editor', () => {
    const items = [
      toolItem('1', 'edit', { path: 'src/a.ts' }),
      toolItem('2', 'read', { path: 'src/noise.ts' })
    ]
    const { result } = renderHook(() => useAgentFileFocus(true, items, undefined))
    expect(result.current?.path).toBe('src/a.ts')
  })

  it('follows str_replace as well as edit', () => {
    const items = [toolItem('1', 'str_replace', { path: 'src/c.ts' })]
    const { result } = renderHook(() => useAgentFileFocus(true, items, undefined))
    expect(result.current?.path).toBe('src/c.ts')
  })

  it('bumps the token only when the path changes', () => {
    const first = [toolItem('1', 'edit', { path: 'src/a.ts' })]
    const { result, rerender } = renderHook(
      ({ items }: { items: UiItem[] }) => useAgentFileFocus(true, items, undefined),
      { initialProps: { items: first } }
    )
    const token = result.current?.token
    expect(token).toBeDefined()

    rerender({ items: [...first, toolItem('2', 'edit', { path: 'src/a.ts' })] })
    expect(result.current?.token).toBe(token)

    rerender({ items: [...first, toolItem('3', 'edit', { path: 'src/b.ts' })] })
    expect(result.current?.token).toBe((token ?? 0) + 1)
    expect(result.current?.path).toBe('src/b.ts')
  })

  it('re-follows the same file when a new run starts', () => {
    const items = [toolItem('1', 'edit', { path: 'src/a.ts' })]
    const { result, rerender } = renderHook(
      ({ running }: { running: boolean }) => useAgentFileFocus(running, items, undefined),
      { initialProps: { running: true } }
    )
    const token = result.current?.token ?? 0
    rerender({ running: false })
    rerender({ running: true })
    expect(result.current?.token).toBe(token + 1)
  })

  it('reads a path out of streaming, still-incomplete edit arguments', () => {
    const partial: UiItem = {
      kind: 'tool',
      id: 's1',
      tool: {
        id: 's1',
        name: 'edit',
        summary: '',
        status: 'running',
        argsPreview: '{"path":"src/streaming.ts","diff":"@@'
      }
    } as UiItem
    const { result } = renderHook(() => useAgentFileFocus(true, [partial], undefined))
    expect(result.current?.path).toBe('src/streaming.ts')
  })
})

describe('FilesPanel follow mode', () => {
  function renderPanel(props: Record<string, unknown>) {
    return render(
      <FilesPanel workspacePath={workspacePath} active {...props} />
    )
  }

  it('opens the file the agent is writing when follow is on', async () => {
    localStorage.setItem('vyotiq.files.followAgent', '1')
    renderPanel({ agentFocus: { path: 'src/a.ts', token: 1 } })
    await waitFor(() => {
      expect(api.workspaceFileRead).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/a.ts' })
      )
    })
  })

  it('stays put when follow is off', async () => {
    localStorage.setItem('vyotiq.files.followAgent', '0')
    renderPanel({ agentFocus: { path: 'src/a.ts', token: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.workspaceFileRead).not.toHaveBeenCalled()
  })

  it('normalizes an absolute in-workspace path before opening', async () => {
    localStorage.setItem('vyotiq.files.followAgent', '1')
    renderPanel({ agentFocus: { path: 'C:/fixtures/follow-agent/src/deep.ts', token: 1 } })
    await waitFor(() => {
      expect(api.workspaceFileRead).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/deep.ts' })
      )
    })
  })

  it('ignores a focus path outside the workspace', async () => {
    localStorage.setItem('vyotiq.files.followAgent', '1')
    renderPanel({ agentFocus: { path: 'C:/Windows/System32/cmd.exe', token: 1 } })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(api.workspaceFileRead).not.toHaveBeenCalled()
  })

  it('exposes the toggle as a switch', async () => {
    localStorage.setItem('vyotiq.files.followAgent', '1')
    const { findByRole } = renderPanel({})
    const toggle = await findByRole('switch', { name: 'Follow agent edits' })
    expect(toggle.getAttribute('aria-checked')).toBe('true')
  })
})

describe('FilesPanel refreshes every open tab, not just the focused one', () => {
  it('re-reads all open tabs when the git revision bumps', async () => {
    const { rerender } = render(
      <FilesPanel
        workspacePath={workspacePath}
        active
        gitRevision={0}
        openPath={{ workspacePath, path: 'src/a.ts' }}
      />
    )
    await waitFor(() => {
      expect(api.workspaceFileRead).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/a.ts' })
      )
    })

    rerender(
      <FilesPanel
        workspacePath={workspacePath}
        active
        gitRevision={0}
        openPath={{ workspacePath, path: 'src/b.ts' }}
      />
    )
    await waitFor(() => {
      expect(api.workspaceFileRead).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'src/b.ts' })
      )
    })

    // src/a.ts is now a background tab. A run that edits it must still refresh
    // it, which is what the old active-tab-only probe missed.
    api.workspaceFileRead.mockClear()
    rerender(
      <FilesPanel
        workspacePath={workspacePath}
        active
        gitRevision={1}
        openPath={{ workspacePath, path: 'src/b.ts' }}
      />
    )

    await waitFor(() => {
      const paths = api.workspaceFileRead.mock.calls.map((call) => call[0].path)
      expect(paths).toContain('src/a.ts')
      expect(paths).toContain('src/b.ts')
    })
  })
})
