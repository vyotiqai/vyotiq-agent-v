/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitStatus } from '@shared/ipc'
import { parseViewSpec } from '@shared/viewSpec'
import { RunSessionProvider, type RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import { ViewFence } from '@renderer/features/task/record/reply/view/ViewFence'
import { ViewEraContext } from '@renderer/features/task/record/reply/view/live'
import { PINNED_SCREENS_MAX, pinnableView, pinnedScreens, pinScreen, resetPinnedScreensForTests } from '@renderer/features/screens/screensStore'
import { ScreensSection, glanceOf } from '@renderer/features/home/components/ScreensSection'
import { resetCommitOpenRequestsForTests, takeCommitOpenRequest } from '@renderer/features/chat/commitOpenRequests'

/*
  The audit pass on views: shared reads, views in earlier answers, Data and
  Copy, links from rows, commit rows, per-task pins and Screens on Home.
*/

const file = (path: string, added: number): GitStatus['files'][number] => ({
  path,
  status: 'modified',
  added,
  removed: 0,
  addedStaged: 0,
  removedStaged: 0,
  addedUnstaged: added,
  removedUnstaged: 0,
  binary: false,
  staged: false,
  unstaged: true
})
const status = (files: GitStatus['files']): GitStatus => ({ branch: 'main', files, truncated: false, fileCount: files.length, added: 0, removed: 0, hasRemote: true, hasCommits: true })

let gitChanged: ((p: { workspacePath: string }) => void) | null = null
let api: Record<string, ReturnType<typeof vi.fn>>

beforeEach(() => {
  gitChanged = null
  api = {
    gitStatus: vi.fn().mockResolvedValue({ ok: true, data: { kind: 'ok', status: status([file('src/a.ts', 3)]) } }),
    onGitStatusChanged: vi.fn((h: (p: { workspacePath: string }) => void) => {
      gitChanged = h
      return () => {
        gitChanged = null
      }
    }),
    shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: null })
  }
  ;(window as unknown as { vyotiq: unknown }).vyotiq = api
  window.localStorage.clear()
  resetPinnedScreensForTests()
  resetCommitOpenRequestsForTests()
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { vyotiq?: unknown }).vyotiq
})

const fence = (blocks: unknown[], id = 'v'): string => JSON.stringify({ id, title: 'A view', blocks })

function inSession(node: React.ReactNode, over: Partial<RunSessionValue> = {}) {
  return (
    <RunSessionProvider value={{ workspacePath: 'C:/w', runId: 'r1', ...over }}>
      <div data-chat-pane="">{node}</div>
    </RunSessionProvider>
  )
}

const twoFiles = { ok: true, data: { kind: 'ok', status: status([file('src/a.ts', 3), file('src/b.ts', 9)]) } }

describe('reads shared between blocks', () => {
  it('reads one source once for every block that shows it', async () => {
    render(
      inSession(
        <>
          <ViewFence text={fence([{ type: 'live', source: 'git.changes' }], 'one')} streaming={false} onPlain={() => null} />
          <ViewFence text={fence([{ type: 'live', source: 'git.branch' }], 'two')} streaming={false} onPlain={() => null} />
        </>
      )
    )
    await screen.findByText('a.ts')
    await screen.findByText('Changed files')
    expect(api.gitStatus).toHaveBeenCalledTimes(1)
    // A change git reports starts the workspace over: one new read, for both.
    api.gitStatus.mockResolvedValue(twoFiles)
    await act(async () => gitChanged?.({ workspacePath: 'C:/w' }))
    await screen.findByText('b.ts')
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
  })
})

describe('a view in an earlier answer', () => {
  const view = <ViewFence text={fence([{ type: 'live', source: 'git.changes' }])} streaming={false} onPlain={() => null} />

  it('is not read until asked: what it would show now may not match the answer around it', async () => {
    render(inSession(<ViewEraContext.Provider value={false}>{view}</ViewEraContext.Provider>))
    expect(screen.getByText(/From an earlier answer/)).toBeTruthy()
    expect(api.gitStatus).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Read now' }))
    await screen.findByText('a.ts')
    expect(screen.getByText(/From git at/)).toBeTruthy()
    expect(screen.queryByText('Live from git')).toBeNull()
    // Not following: git changing does not move it.
    await act(async () => gitChanged?.({ workspacePath: 'C:/w' }))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)
  })

  it('keeps the read it had when a newer run starts, says when that was, and reads again on Refresh', async () => {
    const { rerender } = render(inSession(<ViewEraContext.Provider value>{view}</ViewEraContext.Provider>))
    await screen.findByText('a.ts')
    rerender(inSession(<ViewEraContext.Provider value={false}>{view}</ViewEraContext.Provider>))
    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText(/From git at/)).toBeTruthy()
    api.gitStatus.mockResolvedValue(twoFiles)
    await act(async () => gitChanged?.({ workspacePath: 'C:/w' }))
    expect(screen.queryByText('b.ts')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await screen.findByText('b.ts')
  })
})

describe('a view’s Data and Copy', () => {
  it('give what a live block read, not the name of its source', async () => {
    const writeClipboard = vi.fn().mockResolvedValue({ ok: true, data: null })
    api.writeClipboard = writeClipboard
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'git.changes' }, { type: 'note', text: 'One file' }])} streaming={false} onPlain={() => null} />))
    await screen.findByText('a.ts')
    // The row can paint a tick before the copy sees the read: copy until it does.
    await waitFor(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy as Markdown' }))
      expect(String(writeClipboard.mock.calls.at(-1)?.[0] ?? '')).toContain('**Uncommitted** (1)')
    })
    const copied = String(writeClipboard.mock.calls.at(-1)![0])
    expect(copied).toContain('### A view')
    expect(copied).toContain('**Uncommitted** (1)')
    expect(copied).toContain('- src/a.ts · +3 −0')
    expect(copied).toContain('One file')
    fireEvent.click(screen.getByRole('radio', { name: 'Data' }))
    const data = document.querySelector('figure pre')?.textContent ?? ''
    expect(data).toContain('"read"')
    expect(data).toContain('src/a.ts')
  })
})

describe('a web page from a row', () => {
  it('asks first, naming the site: the address came from the model', async () => {
    render(inSession(<ViewFence text={fence([{ type: 'rows', items: [{ title: 'The fix', do: { action: 'link', url: 'https://evil.example/login' } }] }])} streaming={false} onPlain={() => null} />))
    fireEvent.click(screen.getByRole('button', { name: /The fix/ }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('evil.example')
    expect(dialog.textContent).toContain('https://evil.example/login')
    expect(api.shellOpenExternal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    await waitFor(() => expect(api.shellOpenExternal).toHaveBeenCalledWith('https://evil.example/login'))
  })
})

describe('a commit row', () => {
  it('opens that commit in Changes', async () => {
    const onOpenPanel = vi.fn()
    api.gitLog = vi.fn().mockResolvedValue({ ok: true, data: [{ sha: 'abc1234def', shortSha: 'abc1234', subject: 'Fix it', author: 'A', relativeDate: 'now' }] })
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'git.commits' }])} streaming={false} onPlain={() => null} />, { onOpenPanel }))
    await screen.findByText('Fix it')
    fireEvent.click(screen.getByRole('button', { name: 'abc1234' }))
    expect(onOpenPanel).toHaveBeenCalledWith('changes')
    expect(takeCommitOpenRequest('C:/w')).toMatchObject({ sha: 'abc1234def' })
  })
})

describe('pins, per task', () => {
  const view = fence([{ type: 'live', source: 'git.changes' }, { type: 'note', text: '3 files changed' }], 'changes')

  it('keeps no note: what the model wrote goes stale on a page that reads everything live', () => {
    const kept = pinnableView(parseViewSpec(view)!)
    expect(kept?.blocks.map((b) => b.type)).toEqual(['live'])
  })

  it('tells one task’s view from another’s with the same id', async () => {
    pinScreen({ workspacePath: 'C:/w', runId: 'r1', viewId: 'changes', title: 'Mine', spec: '{}' })
    render(inSession(<ViewFence text={view} streaming={false} onPlain={() => null} />, { runId: 'r2' }))
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Home' }))
    expect(pinnedScreens().map((p) => p.runId)).toEqual(['r2', 'r1'])
  })

  it('refuses a pin past the limit rather than dropping one you chose', async () => {
    for (let i = 0; i < PINNED_SCREENS_MAX; i++) pinScreen({ workspacePath: 'C:/w', runId: `t${i}`, viewId: 'v', title: `P${i}`, spec: '{}' })
    render(inSession(<ViewFence text={view} streaming={false} onPlain={() => null} />))
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Home' }))
    expect(pinnedScreens()).toHaveLength(PINNED_SCREENS_MAX)
    expect(pinnedScreens().some((p) => p.runId === 'r1')).toBe(false)
    expect(pinnedScreens().map((p) => p.title)).toContain('P0')
  })
})

describe('Screens on Home', () => {
  const spec = JSON.stringify({ id: 'c', title: 'Changes', blocks: [{ type: 'live', source: 'git.changes' }] })

  it('says what each pin shows first, read live', async () => {
    pinScreen({ workspacePath: 'C:/w', viewId: 'c', title: 'Changes', spec })
    render(<ScreensSection openWorkspaces={['C:/w']} onOpenScreen={vi.fn()} />)
    await screen.findByText('1 uncommitted')
  })

  it('says how many wait in workspaces not open, and lets you unpin them', () => {
    pinScreen({ workspacePath: 'C:/closed', viewId: 'c', title: 'Closed one', spec })
    render(<ScreensSection openWorkspaces={['C:/w']} onOpenScreen={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: '1 pinned from a workspace not open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Unpin Closed one' }))
    expect(pinnedScreens()).toEqual([])
  })

  it('renames and reorders pins', async () => {
    pinScreen({ workspacePath: 'C:/w', viewId: 'a', title: 'First', spec })
    pinScreen({ workspacePath: 'C:/w', viewId: 'b', title: 'Second', spec })
    render(<ScreensSection openWorkspaces={['C:/w']} onOpenScreen={vi.fn()} />)
    // Newest first: Second, then First.
    fireEvent.click(screen.getByRole('button', { name: 'Second: rename, move, unpin' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Move down' }))
    expect(pinnedScreens().map((p) => p.title)).toEqual(['First', 'Second'])
    fireEvent.click(screen.getByRole('button', { name: 'First: rename, move, unpin' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }))
    const field = await screen.findByRole('textbox', { name: 'Name' })
    fireEvent.change(field, { target: { value: 'My changes' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(pinnedScreens()[0]).toMatchObject({ title: 'My changes', renamed: true })
    // Pinned again on a newer layout, it keeps the name you gave it.
    pinScreen({ workspacePath: 'C:/w', viewId: 'a', title: 'First', spec })
    expect(pinnedScreens()[0]!.title).toBe('My changes')
  })

  it('reads a glance as a few words, alarmed only by something to act on', () => {
    expect(glanceOf({ type: 'checks', items: [{ label: 'build', state: 'fail' }, { label: 'lint', state: 'pass' }] })).toEqual({ text: '1 failing', alarm: true })
    expect(glanceOf({ type: 'checks', items: [{ label: 'lint', state: 'pass' }], total: 30 })).toEqual({ text: 'All 30 passed' })
    expect(glanceOf({ type: 'note', text: 'Nothing uncommitted' })).toEqual({ text: 'Nothing uncommitted' })
  })
})
