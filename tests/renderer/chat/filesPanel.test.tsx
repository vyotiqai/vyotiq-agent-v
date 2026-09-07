/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { FilesPanel } from '@renderer/features/chat/components/FilesPanel'
import { HexEditor } from '@renderer/features/chat/components/HexEditor'
import { TextCodeEditor } from '@renderer/features/chat/components/TextCodeEditor'
import {
  clearFileSession,
  getFileSession
} from '@renderer/features/chat/components/fileSessionStore'

const workspacePath = 'C:/fixtures/files-panel'
const secondWorkspacePath = 'C:/fixtures/second-files-panel'
const binaryContent = btoa(String.fromCharCode(1, 2, 3))
const recoverySessionToken = 'session-token-for-tests'

const api = {
  workspaceFileList: vi.fn(),
  workspaceFileRead: vi.fn(),
  workspaceFileSave: vi.fn(),
  workspaceFileCreate: vi.fn(),
  workspaceFileMove: vi.fn(),
  workspaceFileDelete: vi.fn(),
  workspaceEditorRecoverySave: vi.fn(),
  workspaceEditorRecoveryLoad: vi.fn(),
  workspaceEditorRecoveryClear: vi.fn(),
  workspaceFileReveal: vi.fn(),
  workspaceFormatterStatus: vi.fn(),
  workspaceFormatFile: vi.fn(),
  workspaceLspStatus: vi.fn(),
  workspaceLspRequest: vi.fn(),
  workspaceInlineComplete: vi.fn(async () => ({ ok: true as const, data: { text: '' } })),
  workspaceInlineCompleteAbort: vi.fn(async () => ({ ok: true as const, data: true })),
  gitDiff: vi.fn(),
  gitBlame: vi.fn(),
  writeClipboard: vi.fn(() => true),
  slashCommandsOpenFile: vi.fn()
}

beforeEach(() => {
  if (typeof Range !== 'undefined') {
    Object.defineProperty(Range.prototype, 'getClientRects', {
      configurable: true,
      value: () => [] as unknown as DOMRectList
    })
    Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: () =>
        ({
          x: 0,
          y: 0,
          top: 0,
          right: 0,
          bottom: 0,
          left: 0,
          width: 0,
          height: 0,
          toJSON: () => ({})
        }) as DOMRect
    })
  }
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: api
  })
  api.workspaceFileList.mockImplementation(({ path }: { path: string }) =>
    Promise.resolve({
      ok: true,
      data:
        path === ''
          ? {
              path: '',
              entries: [
                {
                  name: 'src',
                  path: 'src',
                  kind: 'directory',
                  size: 0,
                  mtimeMs: 1,
                  hidden: false,
                  symlinkTargetInsideWorkspace: null
                },
                {
                  name: '.git',
                  path: '.git',
                  kind: 'directory',
                  size: 0,
                  mtimeMs: 1,
                  hidden: true,
                  symlinkTargetInsideWorkspace: null
                },
                {
                  name: 'README.md',
                  path: 'README.md',
                  kind: 'file',
                  size: 12,
                  mtimeMs: 1,
                  hidden: false,
                  symlinkTargetInsideWorkspace: null
                }
              ],
              total: 3,
              nextOffset: null,
              truncated: false
            }
          : {
              path,
              entries: [
                {
                  name: 'note.ts',
                  path: 'src/note.ts',
                  kind: 'file',
                  size: 5,
                  mtimeMs: 1,
                  hidden: false,
                  symlinkTargetInsideWorkspace: null
                }
              ],
              total: 1,
              nextOffset: null,
              truncated: false
            }
    })
  )
  api.workspaceFileRead.mockResolvedValue({
    ok: true,
    data: {
      path: 'src/note.ts',
      kind: 'text',
      content: 'hello',
      encoding: 'utf8',
      eol: 'lf',
      bom: false,
      size: 5,
      version: {
        size: 5,
        mtimeMs: 1,
        sha256: 'a'.repeat(64)
      },
      truncated: false
    }
  })
  api.workspaceFileSave.mockResolvedValue({
    ok: true,
    data: {
      path: 'src/note.ts',
      size: 5,
      version: {
        size: 5,
        mtimeMs: 2,
        sha256: 'b'.repeat(64)
      }
    }
  })
  api.workspaceFileCreate.mockResolvedValue({
    ok: true,
    data: {
      entry: {
        name: 'created.ts',
        path: 'created.ts',
        kind: 'file',
        size: 0,
        mtimeMs: 2,
        hidden: false,
        symlinkTargetInsideWorkspace: null
      }
    }
  })
  api.workspaceFileMove.mockResolvedValue({
    ok: true,
    data: {
      entry: {
        name: 'renamed.ts',
        path: 'renamed.ts',
        kind: 'file',
        size: 5,
        mtimeMs: 2,
        hidden: false,
        symlinkTargetInsideWorkspace: null
      }
    }
  })
  api.workspaceFileDelete.mockResolvedValue({
    ok: true,
    data: { path: 'created.ts', kind: 'file' }
  })
  api.workspaceEditorRecoveryLoad.mockResolvedValue({
    ok: true,
    data: { snapshot: null, source: 'none', sessionToken: recoverySessionToken, generation: 0 }
  })
  api.workspaceEditorRecoverySave.mockResolvedValue({ ok: true, data: true })
  api.workspaceEditorRecoveryClear.mockResolvedValue({ ok: true, data: true })
  api.workspaceFileReveal.mockResolvedValue({ ok: true, data: true })
  api.workspaceFormatterStatus.mockResolvedValue({
    ok: true,
    data: { kind: 'unavailable', detail: 'No formatter configured' }
  })
  api.workspaceFormatFile.mockResolvedValue({
    ok: true,
    data: { kind: 'unavailable', detail: 'No formatter configured' }
  })
  api.workspaceLspStatus.mockResolvedValue({
    ok: true,
    data: { kind: 'unavailable', detail: 'No language server detected' }
  })
  api.workspaceLspRequest.mockResolvedValue({
    ok: true,
    data: { kind: 'diagnostics', items: [] }
  })
  api.gitDiff.mockResolvedValue({ ok: true, data: { content: '' } })
  api.gitBlame.mockResolvedValue({
    ok: true,
    data: { kind: 'unavailable', detail: 'No git history' }
  })
  vi.spyOn(window, 'confirm').mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
  clearFileSession(workspacePath)
  clearFileSession(secondWorkspacePath)
  vi.restoreAllMocks()
})

describe('FilesPanel', () => {
  it('shows a visible loading state before the workspace root arrives', async () => {
    api.workspaceFileList.mockImplementationOnce(() => new Promise(() => {}))
    render(<FilesPanel workspacePath={workspacePath} active />)
    expect((await screen.findByRole('status')).textContent).toContain('Loading files…')
  })

  it('loads all workspace entries and opens a text tab', async () => {
    render(<FilesPanel workspacePath={workspacePath} active onGitMutated={vi.fn()} />)

    expect(await screen.findByText('README.md')).toBeTruthy()
    expect(screen.getByRole('separator', { name: 'Resize Files explorer' })).toBeTruthy()
    // Ignored dependency/build noise is hidden until "Show ignored files" is on.
    expect(screen.queryByText('.git')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Workspace actions' }))
    fireEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Show ignored files' }))
    expect(await screen.findByText('.git')).toBeTruthy()
    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('note.ts')).toBeTruthy()
    fireEvent.click(screen.getByText('note.ts'))

    expect(await screen.findByRole('tab', { name: /note\.ts/i })).toBeTruthy()
    expect(api.workspaceFileRead).toHaveBeenCalledWith({
      workspacePath,
      path: 'src/note.ts'
    })
  })

  it('does not poll disk while the Files panel is hidden', async () => {
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    await screen.findByRole('tab', { name: /note\.ts/i })
    api.workspaceFileRead.mockClear()

    view.rerender(<FilesPanel workspacePath={workspacePath} active={false} />)
    await act(async () => {
      await Promise.resolve()
    })
    vi.useFakeTimers()
    await act(async () => {
      vi.advanceTimersByTime(4_000)
    })
    expect(api.workspaceFileRead).not.toHaveBeenCalled()

    view.rerender(<FilesPanel workspacePath={workspacePath} active />)
    await act(async () => {
      await Promise.resolve()
    })
    expect(api.workspaceFileRead).toHaveBeenCalledTimes(1)

    api.workspaceFileRead.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(2_000)
    })
    expect(api.workspaceFileRead).not.toHaveBeenCalled()
  })

  it('polls disk every 2s while the active tab is dirty and focused', async () => {
    api.workspaceFileRead.mockResolvedValue({
      ok: true,
      data: {
        path: 'src/note.ts',
        kind: 'binary',
        content: binaryContent,
        encoding: 'binary',
        eol: 'none',
        bom: false,
        size: 3,
        version: {
          size: 3,
          mtimeMs: 1,
          sha256: 'a'.repeat(64)
        },
        truncated: false
      }
    })
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    await screen.findByRole('tab', { name: /note\.ts/i })
    fireEvent.click(screen.getByRole('button', { name: 'Editor actions' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Auto Save' }))
    const byte = await screen.findByRole('textbox', { name: 'Byte 0' })
    vi.useFakeTimers()
    fireEvent.change(byte, { target: { value: 'ff' } })
    api.workspaceFileRead.mockClear()
    await act(async () => {
      vi.advanceTimersByTime(2_000)
      await Promise.resolve()
    })
    expect(api.workspaceFileRead).toHaveBeenCalled()
  })

  it('autosaves an accepted edit after one second of idle time', async () => {
    api.workspaceFileRead.mockResolvedValueOnce({
      ok: true,
      data: {
        path: 'src/note.ts',
        kind: 'binary',
        content: binaryContent,
        encoding: 'binary',
        eol: 'none',
        bom: false,
        size: 3,
        version: {
          size: 3,
          mtimeMs: 1,
          sha256: 'a'.repeat(64)
        },
        truncated: false
      }
    })
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    const byte = await screen.findByRole('textbox', { name: 'Byte 0' })
    api.workspaceFileSave.mockClear()
    vi.useFakeTimers()
    fireEvent.change(byte, { target: { value: 'ff' } })
    expect(api.workspaceFileSave).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(999)
      await Promise.resolve()
    })
    expect(api.workspaceFileSave).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.workspaceFileSave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        path: 'src/note.ts',
        kind: 'binary',
        content: btoa(String.fromCharCode(255, 2, 3)),
        expectedVersion: expect.objectContaining({ sha256: 'a'.repeat(64) })
      })
    )
  })

  it('keeps local edits protected when autosave detects an external change', async () => {
    api.workspaceFileRead.mockResolvedValueOnce({
      ok: true,
      data: {
        path: 'src/note.ts',
        kind: 'binary',
        content: binaryContent,
        encoding: 'binary',
        eol: 'none',
        bom: false,
        size: 3,
        version: {
          size: 3,
          mtimeMs: 1,
          sha256: 'a'.repeat(64)
        },
        truncated: false
      }
    })
    api.workspaceFileSave.mockResolvedValueOnce({
      ok: false,
      code: 'FILE_CONFLICT',
      error: 'The file changed externally.'
    })
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    const byte = await screen.findByRole('textbox', { name: 'Byte 0' })
    vi.useFakeTimers()
    fireEvent.change(byte, { target: { value: 'ff' } })
    await act(async () => {
      vi.advanceTimersByTime(1000)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByText('Changed externally')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Overwrite' })).toBeTruthy()
  })

  it('does not replace a tab opened while recovery is reading disk', async () => {
    let resolveRecoveryRead!: (
      result: Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
    ) => void
    const pendingRecoveryRead = new Promise<
      Awaited<ReturnType<typeof window.vyotiq.workspaceFileRead>>
    >((resolve) => {
      resolveRecoveryRead = resolve
    })
    api.workspaceEditorRecoveryLoad.mockResolvedValueOnce({
      ok: true,
      data: {
        source: 'app',
        sessionToken: recoverySessionToken,
        generation: 0,
        snapshot: {
          version: 1,
          activeTabId: 'recovered-tab',
          savedAt: new Date().toISOString(),
          tabs: [
            {
              id: 'recovered-tab',
              path: 'README.md',
              kind: 'text',
              content: 'draft',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 0 }],
              bookmarks: [],
              template: null
            }
          ]
        }
      }
    })
    api.workspaceFileRead.mockImplementation((payload: { path: string }) =>
      payload.path === 'README.md'
        ? pendingRecoveryRead
        : Promise.resolve({
            ok: true,
            data: {
              path: 'src/note.ts',
              kind: 'text',
              content: 'hello',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              size: 5,
              version: {
                size: 5,
                mtimeMs: 1,
                sha256: 'a'.repeat(64)
              },
              truncated: false
            }
          })
    )

    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    await screen.findByRole('tab', { name: /note\.ts/i })
    resolveRecoveryRead({
      ok: true,
      data: {
        path: 'README.md',
        kind: 'text',
        content: 'disk',
        encoding: 'utf8',
        eol: 'lf',
        bom: false,
        size: 4,
        version: {
          size: 4,
          mtimeMs: 2,
          sha256: 'b'.repeat(64)
        },
        truncated: false
      }
    })

    await waitFor(() => {
      expect(getFileSession(workspacePath).tabs.map((tab) => tab.path)).toEqual(['src/note.ts'])
    })
  })

  it('rejects an open-file request owned by another workspace', async () => {
    const handled = vi.fn()
    api.workspaceFileRead.mockClear()
    render(
      <FilesPanel
        workspacePath={workspacePath}
        active
        openPath={{ workspacePath: secondWorkspacePath, path: 'src/note.ts' }}
        onOpenPathHandled={handled}
      />
    )

    await screen.findByText('README.md')
    await waitFor(() => {
      expect(handled).toHaveBeenCalledWith({
        workspacePath: secondWorkspacePath,
        path: 'src/note.ts'
      })
    })
    expect(api.workspaceFileRead).not.toHaveBeenCalled()
  })

  it('uses real file-management IPC for creating a file', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')

    fireEvent.click(screen.getByRole('button', { name: /create file/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Prompt input' }), {
      target: { value: 'created.ts' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    await waitFor(() => {
      expect(api.workspaceFileCreate).toHaveBeenCalledWith({
        workspacePath,
        parentPath: '',
        name: 'created.ts',
        kind: 'file',
        replaceExisting: false
      })
    })
  })

  it('opens a target-aware context menu for a workspace entry', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    const readme = await screen.findByText('README.md')
    fireEvent.contextMenu(readme)
    expect(screen.getByRole('menu', { name: 'Files actions' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Open' })).toBeTruthy()
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy relative path' }))
    expect(api.writeClipboard).toHaveBeenCalledWith('README.md')
  })

  it('does not apply a mutation completion after switching workspaces', async () => {
    type CreateResult = Awaited<ReturnType<typeof window.vyotiq.workspaceFileCreate>>
    let resolveCreate!: (result: CreateResult) => void
    const pending = new Promise<CreateResult>((resolve) => {
      resolveCreate = resolve
    })
    api.workspaceFileCreate.mockReturnValueOnce(pending)
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByRole('button', { name: /create file/i }))
    fireEvent.change(await screen.findByRole('textbox', { name: 'Prompt input' }), {
      target: { value: 'created.ts' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    view.rerender(<FilesPanel workspacePath={secondWorkspacePath} active />)
    await screen.findByText('second-files-panel')
    resolveCreate({
      ok: true,
      data: {
        entry: {
          name: 'created.ts',
          path: 'created.ts',
          kind: 'file',
          size: 0,
          mtimeMs: 2,
          hidden: false,
          symlinkTargetInsideWorkspace: null
        }
      }
    })
    await waitFor(() => {
      expect(getFileSession(secondWorkspacePath).tabs).toHaveLength(0)
      expect(getFileSession(secondWorkspacePath).selectedPath).toBeNull()
    })
  })

  it('persists the previous workspace session before switching workspaces', async () => {
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    await screen.findByRole('tab', { name: /note\.ts/i })
    api.workspaceEditorRecoverySave.mockClear()

    view.rerender(<FilesPanel workspacePath={secondWorkspacePath} active />)
    await screen.findByText('second-files-panel')

    expect(api.workspaceEditorRecoverySave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        snapshot: expect.objectContaining({
          tabs: [expect.objectContaining({ path: 'src/note.ts' })]
        })
      })
    )
  })

  it('does not intercept chat-level shortcuts outside the Files surface', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    api.workspaceFileSave.mockClear()
    fireEvent.keyDown(document.body, { key: 's', ctrlKey: true })
    fireEvent.keyDown(document.body, { key: 'w', ctrlKey: true })
    expect(api.workspaceFileSave).not.toHaveBeenCalled()
  })

  it('renders and retries child-directory listing errors', async () => {
    const defaultList = api.workspaceFileList.getMockImplementation()
    let failed = true
    api.workspaceFileList.mockImplementation((payload: { path: string }) => {
      if (payload.path === 'src' && failed) {
        failed = false
        return Promise.resolve({ ok: false, error: 'Child directory unavailable' })
      }
      return defaultList?.(payload)
    })
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('Child directory unavailable')).toBeTruthy()
    fireEvent.click(screen.getByRole('link', { name: 'Retry' }))
    expect(await screen.findByText('note.ts')).toBeTruthy()
  })

  it('hydrates multiple recovered tabs from the main-process recovery store', async () => {
    api.workspaceEditorRecoveryLoad.mockResolvedValueOnce({
      ok: true,
      data: {
        source: 'app',
        sessionToken: recoverySessionToken,
        generation: 0,
        snapshot: {
          version: 1,
          activeTabId: 'tab-b',
          savedAt: new Date().toISOString(),
          tabs: [
            {
              id: 'tab-a',
              path: 'README.md',
              kind: 'text',
              content: 'draft',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 0 }],
              bookmarks: [],
              template: null
            },
            {
              id: 'tab-b',
              path: 'image.dat',
              kind: 'binary',
              content: binaryContent,
              encoding: 'binary',
              eol: 'none',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 1 }],
              bookmarks: [0],
              template: 'header'
            }
          ]
        }
      }
    })

    render(<FilesPanel workspacePath={workspacePath} active />)
    expect(await screen.findByRole('tab', { name: /README\.md/i })).toBeTruthy()
    const binaryTab = screen.getByRole('tab', { name: /image\.dat/i })
    expect(binaryTab).toBeTruthy()
    expect(binaryTab.getAttribute('aria-controls')).toBe('workspace-file-editor-panel')
    expect(screen.getByRole('tabpanel')).toBeTruthy()
    expect(screen.getByRole('tab', { name: /image\.dat/i }).getAttribute('tabindex')).toBe('0')
  })

  it('reconciles a recovered draft that is already present on disk', async () => {
    api.workspaceEditorRecoveryLoad.mockResolvedValueOnce({
      ok: true,
      data: {
        source: 'app',
        sessionToken: recoverySessionToken,
        generation: 0,
        snapshot: {
          version: 1,
          activeTabId: 'tab-recovered',
          savedAt: new Date().toISOString(),
          tabs: [
            {
              id: 'tab-recovered',
              path: 'README.md',
              kind: 'text',
              content: 'hello',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 0 }],
              bookmarks: [],
              template: null
            }
          ]
        }
      }
    })
    api.workspaceFileSave.mockClear()
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByRole('tab', { name: /README\.md/i })
    await waitFor(() => {
      expect(getFileSession(workspacePath).tabs[0]?.dirty).toBe(false)
    })
    expect(api.workspaceFileSave).not.toHaveBeenCalled()
  })

  it('does not clear recovery after a failed load', async () => {
    api.workspaceEditorRecoveryLoad.mockRejectedValueOnce(new Error('temporary recovery failure'))
    api.workspaceEditorRecoveryClear.mockClear()
    render(<FilesPanel workspacePath={workspacePath} active />)
    expect(await screen.findByText(/Recovery warning: temporary recovery failure/i)).toBeTruthy()
    expect(api.workspaceEditorRecoveryClear).not.toHaveBeenCalled()
  })

  it('flushes the current recovery snapshot before panel unmount', async () => {
    api.workspaceEditorRecoveryLoad.mockResolvedValueOnce({
      ok: true,
      data: {
        source: 'app',
        sessionToken: recoverySessionToken,
        generation: 4,
        snapshot: {
          version: 1,
          activeTabId: 'tab-1',
          savedAt: new Date().toISOString(),
          tabs: [
            {
              id: 'tab-1',
              path: 'README.md',
              kind: 'text',
              content: 'draft',
              encoding: 'utf8',
              eol: 'lf',
              bom: false,
              version: null,
              dirty: true,
              cursor: 0,
              selections: [{ from: 0, to: 0 }],
              bookmarks: [],
              template: null
            }
          ]
        }
      }
    })
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    expect(await screen.findByRole('tab', { name: /README\.md/i })).toBeTruthy()
    api.workspaceEditorRecoverySave.mockClear()
    view.unmount()
    expect(api.workspaceEditorRecoverySave).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath,
        sessionToken: recoverySessionToken,
        snapshot: expect.objectContaining({
          activeTabId: 'tab-1',
          selectedPath: 'README.md',
          expandedPaths: [''],
          treeSort: 'name',
          wordWrap: false
        })
      })
    )
  })

  it('keeps one workspace session across panel remounts and persists its view state', async () => {
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    fireEvent.click(await screen.findByText('note.ts'))
    await screen.findByRole('tab', { name: /note\.ts/i })
    fireEvent.click(screen.getByRole('button', { name: 'Sort workspace files' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Type' }))
    fireEvent.click(screen.getByRole('button', { name: 'Wrap' }))

    expect(getFileSession(workspacePath).selectedPath).toBe('src/note.ts')
    expect(getFileSession(workspacePath).expandedPaths).toContain('src')
    expect(getFileSession(workspacePath).treeSort).toBe('kind')
    expect(getFileSession(workspacePath).wordWrap).toBe(true)

    api.workspaceFileList.mockClear()
    api.workspaceEditorRecoverySave.mockClear()
    view.unmount()
    expect(api.workspaceEditorRecoverySave).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          selectedPath: 'src/note.ts',
          expandedPaths: ['', 'src'],
          treeSort: 'kind',
          wordWrap: true
        })
      })
    )

    render(<FilesPanel workspacePath={workspacePath} active />)
    expect(await screen.findByRole('tab', { name: /note\.ts/i })).toBeTruthy()
    expect(
      (await screen.findByRole('button', { name: 'Sort workspace files' })).textContent
    ).toContain('Type')
    expect(screen.getByRole('button', { name: 'Wrap' }).getAttribute('aria-pressed')).toBe('true')
    await waitFor(() => {
      expect(api.workspaceFileList).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath, path: 'src' })
      )
    }    )
  })

  it('refreshes expanded directories from the toolbar button', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('src'))
    await screen.findByText('note.ts')
    api.workspaceFileList.mockClear()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh files' }))
    await waitFor(() => {
      expect(api.workspaceFileList).toHaveBeenCalledWith(
        expect.objectContaining({ workspacePath, path: 'src' })
      )
    })
  })

  it('shows a synthetic load-more row for paginated directories', async () => {
    api.workspaceFileList.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        ok: true,
        data:
          path === ''
            ? {
                path: '',
                entries: [
                  {
                    name: 'big',
                    path: 'big',
                    kind: 'directory',
                    size: 0,
                    mtimeMs: 1,
                    hidden: false,
                    symlinkTargetInsideWorkspace: null
                  }
                ],
                total: 1,
                nextOffset: null,
                truncated: false
              }
            : {
                path,
                entries: Array.from({ length: 200 }, (_, index) => ({
                  name: `file-${index}.txt`,
                  path: `${path}/file-${index}.txt`,
                  kind: 'file' as const,
                  size: 1,
                  mtimeMs: 1,
                  hidden: false,
                  symlinkTargetInsideWorkspace: null
                })),
                total: 400,
                nextOffset: 200,
                truncated: false
              }
      })
    )
    render(<FilesPanel workspacePath={workspacePath} active />)
    fireEvent.click(await screen.findByText('big'))
    expect(await screen.findByRole('button', { name: /Load more \(200\/400\)/i })).toBeTruthy()
  })

  it('applies accent selection styling to the active tree row', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    const readme = await screen.findByText('README.md')
    fireEvent.click(readme)
    await waitFor(() => {
      expect(readme.closest('button')?.className).toContain('ring-accent/35')
    })
  })

  it('exposes editor actions and persists editor settings in the session', async () => {
    const view = render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('README.md'))
    await screen.findByRole('tab', { name: /README\.md/i })
    fireEvent.click(screen.getByRole('button', { name: 'Editor actions' }))

    expect(screen.getByRole('menu', { name: 'Editor actions' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Diff View' })).toBeTruthy()
    expect(screen.getByRole('menuitem', { name: 'Git Blame' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Line numbers' })).toBeTruthy()
    expect(screen.getByRole('menuitemcheckbox', { name: 'Auto Save' })).toBeTruthy()
    expect(
      screen.getByRole('menuitemcheckbox', { name: 'Format on Save' }).getAttribute('aria-disabled')
    ).toBe('true')

    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Auto Save' }))
    expect(getFileSession(workspacePath).autoSave).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Editor actions' }))
    fireEvent.click(screen.getByRole('menuitemcheckbox', { name: 'Line numbers' }))
    expect(getFileSession(workspacePath).showLineNumbers).toBe(false)
    view.unmount()
    expect(api.workspaceEditorRecoverySave).toHaveBeenCalledWith(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          showLineNumbers: false,
          autoSave: false
        })
      })
    )
  })

  it('opens find in files when findInFilesNonce increments', async () => {
    const view = render(<FilesPanel workspacePath={workspacePath} active findInFilesNonce={0} />)
    await screen.findByText('README.md')
    expect(screen.queryByPlaceholderText('Find in files')).toBeNull()
    view.rerender(<FilesPanel workspacePath={workspacePath} active findInFilesNonce={1} />)
    expect(await screen.findByPlaceholderText('Find in files')).toBeTruthy()
  })

  it('opens a PNG as an image preview', async () => {
    const png =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    api.workspaceFileList.mockImplementation(({ path }: { path: string }) =>
      Promise.resolve({
        ok: true,
        data:
          path === ''
            ? {
                path: '',
                entries: [
                  {
                    name: 'logo.png',
                    path: 'logo.png',
                    kind: 'file',
                    size: 70,
                    mtimeMs: 1,
                    hidden: false,
                    symlinkTargetInsideWorkspace: null
                  }
                ],
                total: 1,
                nextOffset: null,
                truncated: false
              }
            : { path, entries: [], total: 0, nextOffset: null, truncated: false }
      })
    )
    api.workspaceFileRead.mockResolvedValue({
      ok: true,
      data: {
        path: 'logo.png',
        kind: 'binary',
        content: png,
        encoding: 'binary',
        eol: 'none',
        bom: false,
        size: 70,
        version: { size: 70, mtimeMs: 1, sha256: 'c'.repeat(64) },
        truncated: false
      }
    })
    render(<FilesPanel workspacePath={workspacePath} active />)
    fireEvent.click(await screen.findByText('logo.png'))
    await waitFor(() => {
      expect(document.querySelector('[data-file-preview="image"]')).toBeTruthy()
    })
    fireEvent.click(screen.getByRole('button', { name: 'Show source' }))
    expect(await screen.findByRole('textbox', { name: 'Byte 0' })).toBeTruthy()
  })

  it('toggles markdown preview from the source editor', async () => {
    render(<FilesPanel workspacePath={workspacePath} active />)
    await screen.findByText('README.md')
    fireEvent.click(screen.getByText('README.md'))
    await screen.findByRole('tab', { name: /README\.md/i })
    fireEvent.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(document.querySelector('[data-file-preview="markdown"]')).toBeTruthy()
  })
})

describe('HexEditor', () => {
  it('edits bytes and supports virtualized binary operations', () => {
    const onChange = vi.fn()
    render(
      <HexEditor
        value={binaryContent}
        bookmarks={[]}
        selections={[{ from: 0, to: 1 }]}
        template={null}
        onChange={onChange}
        onMetaChange={vi.fn()}
      />
    )

    expect(screen.getByRole('list', { name: 'Hex editor' })).toBeTruthy()
    fireEvent.change(screen.getByRole('textbox', { name: 'Byte 0' }), {
      target: { value: 'ff' }
    })
    expect(onChange).toHaveBeenCalledWith(btoa(String.fromCharCode(255, 2, 3)))
    fireEvent.click(screen.getByRole('button', { name: 'Insert' }))
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('uses arrow navigation and can clear the hex selection', async () => {
    const onMetaChange = vi.fn()
    render(
      <HexEditor
        value={binaryContent}
        bookmarks={[]}
        selections={[{ from: 0, to: 1 }]}
        template={null}
        onChange={vi.fn()}
        onMetaChange={onMetaChange}
      />
    )
    const first = screen.getByRole('textbox', { name: 'Byte 0' })
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Byte 1' })).toBe(document.activeElement)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Clear hex selection' }))
    expect(onMetaChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ selections: [] })
    )
  })

  it('roves Tab focus through both byte columns', async () => {
    render(
      <HexEditor
        value={binaryContent}
        bookmarks={[]}
        selections={[{ from: 0, to: 1 }]}
        template={null}
        onChange={vi.fn()}
        onMetaChange={vi.fn()}
      />
    )
    const byte = screen.getByRole('textbox', { name: 'Byte 0' })
    byte.focus()
    fireEvent.keyDown(byte, { key: 'Tab' })
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'ASCII byte 0' })).toBe(document.activeElement)
    )
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'ASCII byte 0' }), { key: 'Tab' })
    await waitFor(() =>
      expect(screen.getByRole('textbox', { name: 'Byte 1' })).toBe(document.activeElement)
    )
  })

  it('rejects malformed and oversized find patterns', async () => {
    const onChange = vi.fn()
    render(
      <HexEditor
        value={binaryContent}
        bookmarks={[]}
        selections={[{ from: 0, to: 1 }]}
        template={null}
        onChange={onChange}
        onMetaChange={vi.fn()}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Find/replace' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Prompt input' }), {
      target: { value: '1z' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect((await screen.findByRole('alert')).textContent).toContain(
      'valid hexadecimal bytes'
    )
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('TextCodeEditor', () => {
  it('does not report a programmatic reload as a user edit', async () => {
    const onChange = vi.fn()
    const view = render(
      <TextCodeEditor
        path="note.ts"
        value="before"
        cursor={0}
        selections={[{ from: 0, to: 0 }]}
        onChange={onChange}
        onMetaChange={vi.fn()}
      />
    )
    view.rerender(
      <TextCodeEditor
        path="note.ts"
        value="after"
        cursor={0}
        selections={[{ from: 0, to: 0 }]}
        onChange={onChange}
        onMetaChange={vi.fn()}
      />
    )
    await waitFor(() => expect(onChange).not.toHaveBeenCalled())
  })
})
