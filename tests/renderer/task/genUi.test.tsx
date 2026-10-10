/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GitStatus } from '@shared/ipc'
import type { UiItem } from '@shared/transcript'
import { RunSessionProvider, type RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import { ViewFence } from '@renderer/features/task/record/reply/view/ViewFence'
import { RunViews, runViews } from '@renderer/features/task/record/RunViews'
import { AskQuestionPanel } from '@renderer/features/chat/components/AskQuestionPanel'
import { ScreenPage } from '@renderer/features/screens/ScreenPage'
import { pinnedScreens, pinScreen, resetPinnedScreensForTests } from '@renderer/features/screens/screensStore'
import { ScreensSection } from '@renderer/features/home/components/ScreensSection'
import { CommandPalette } from '@renderer/features/commandPalette/CommandPalette'
import { readFailure } from '@renderer/features/task/record/reply/view/live'
import type { RecordRun, WorkItem } from '@renderer/features/task/recordModel'

const terminal = vi.hoisted(() => ({ requestRunInTerminal: vi.fn() }))
vi.mock('@renderer/features/chat/terminalRequests', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/features/chat/terminalRequests')>()),
  requestRunInTerminal: terminal.requestRunInTerminal
}))

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
    gitStagePaths: vi.fn().mockResolvedValue({ ok: true, data: { staged: true, detail: 'ok' } }),
    gitUnstagePaths: vi.fn().mockResolvedValue({ ok: true, data: { unstaged: true, detail: 'ok' } }),
    shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: null })
  }
  ;(window as unknown as { vyotiq: unknown }).vyotiq = api
  terminal.requestRunInTerminal.mockReset()
  window.localStorage.clear()
  resetPinnedScreensForTests()
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

describe('a live block', () => {
  it('draws the app’s own read, says where it comes from, and reads again when git says the workspace changed', async () => {
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'git.changes' }])} streaming={false} onPlain={() => null} />))
    await screen.findByText('a.ts')
    expect(screen.getByText('Live from git')).toBeTruthy()
    expect(api.gitStatus).toHaveBeenCalledWith('C:/w')
    expect(document.querySelector('[data-live] .tnum')?.textContent).toBe('1')

    // Another workspace changing is not this one.
    api.gitStatus.mockResolvedValue({ ok: true, data: { kind: 'ok', status: status([file('src/a.ts', 3), file('src/b.ts', 9)]) } })
    await act(async () => gitChanged?.({ workspacePath: 'C:/other' }))
    expect(api.gitStatus).toHaveBeenCalledTimes(1)
    await act(async () => gitChanged?.({ workspacePath: 'C:/w' }))
    await screen.findByText('b.ts')
  })

  it('says why it shows nothing rather than drawing zeros', async () => {
    api.gitStatus.mockResolvedValue({ ok: true, data: { kind: 'not_repo' } })
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'git.changes' }])} streaming={false} onPlain={() => null} />))
    await screen.findByText('This workspace is not a git repository')
    expect(screen.queryByText('Live from git')).toBeNull()
  })

  it('reads a task’s own changes only inside a task', async () => {
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'task.changes' }])} streaming={false} onPlain={() => null} />, { runId: null }))
    await screen.findByText('Only a task has changes of its own')
  })
})

describe('a click the app carries out', () => {
  it('opens a row’s diff', async () => {
    const onOpen = vi.fn()
    render(inSession(<ViewFence text={fence([{ type: 'live', source: 'git.changes' }])} streaming={false} onPlain={() => null} />, { onOpenWorkspaceFile: onOpen }))
    fireEvent.click(await screen.findByRole('button', { name: /a\.ts/ }))
    expect(onOpen).toHaveBeenCalledWith('src/a.ts', { mode: 'diff' })
  })

  it('asks before running a command, shows it, and runs it in your terminal only on Run', async () => {
    const onOpenPanel = vi.fn()
    render(
      inSession(<ViewFence text={fence([{ type: 'actions', actions: [{ label: 'Run tests', do: { action: 'run', command: 'pnpm test' } }] }])} streaming={false} onPlain={() => null} />, {
        onOpenPanel
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run tests' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain('pnpm test')
    expect(terminal.requestRunInTerminal).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Run' }))
    await waitFor(() => expect(terminal.requestRunInTerminal).toHaveBeenCalledWith('C:/w', 'pnpm test'))
    expect(onOpenPanel).toHaveBeenCalledWith('terminal')
  })

  it('runs nothing when the command is cancelled', async () => {
    render(
      inSession(<ViewFence text={fence([{ type: 'actions', actions: [{ label: 'Run tests', do: { action: 'run', command: 'pnpm test' } }] }])} streaming={false} onPlain={() => null} />, {
        onOpenPanel: vi.fn()
      })
    )
    fireEvent.click(screen.getByRole('button', { name: 'Run tests' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(terminal.requestRunInTerminal).not.toHaveBeenCalled()
  })

  it('stages files and opens a web page', async () => {
    render(
      inSession(
        <ViewFence
          text={fence([
            {
              type: 'actions',
              actions: [
                { label: 'Stage both', do: { action: 'stage', paths: ['a.ts', 'b.ts'] } },
                { label: 'Open CI', do: { action: 'link', url: 'https://github.com/o/r/actions' } }
              ]
            }
          ])}
          streaming={false}
          onPlain={() => null}
        />
      )
    )
    fireEvent.click(screen.getByRole('button', { name: 'Stage both' }))
    await waitFor(() => expect(api.gitStagePaths).toHaveBeenCalledWith({ workspacePath: 'C:/w', paths: ['a.ts', 'b.ts'] }))
    // The button names the site it opens, so it opens without asking.
    fireEvent.click(screen.getByRole('button', { name: 'Open CI github.com' }))
    expect(api.shellOpenExternal).toHaveBeenCalledWith('https://github.com/o/r/actions')
  })

  it('offers nothing it cannot do here: a tab this record cannot open is a disabled button', () => {
    render(inSession(<ViewFence text={fence([{ type: 'actions', actions: [{ label: 'Open terminal', do: { action: 'panel', panel: 'terminal' } }] }])} streaming={false} onPlain={() => null} />))
    expect((screen.getByRole('button', { name: 'Open terminal' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

type ToolItem = Extract<UiItem, { kind: 'tool' }>
const viewCall = (id: string, args: string, status: 'running' | 'done' | 'fail' = 'done'): ToolItem => ({
  kind: 'tool',
  id,
  tool: { id, name: 'show_view', summary: '', status, argsPreview: args }
})
const work = (...tools: ToolItem[]): WorkItem[] => tools.map((t) => ({ kind: 'view', id: t.id, tool: t }))

describe('views drawn while the run works', () => {
  const rows = (titles: string[]): string => fence([{ type: 'rows', items: titles.map((title) => ({ title, state: 'done' })) }], 'progress')

  it('shows each view once, its newest copy, in the order the views first appeared', () => {
    const list = runViews(work(viewCall('1', rows(['a'])), viewCall('2', fence([{ type: 'note', text: 'n' }], 'other')), viewCall('3', rows(['a', 'b']))))
    expect(list.map((t) => t.id)).toEqual(['3', '2'])
  })

  it('keeps the copy before an update on screen until the update has something to draw', () => {
    const half = '{"id":"progress","title":"A view","blocks":[{"type":"rows","items":[{"title":"a"'
    expect(runViews(work(viewCall('1', rows(['a'])), viewCall('2', half, 'running'))).map((t) => t.id)).toEqual(['1'])
    expect(runViews(work(viewCall('1', rows(['a'])), viewCall('2', rows(['a', 'b']).slice(0, -2), 'running'))).map((t) => t.id)).toEqual(['2'])
  })

  it('never draws a call that failed', () => {
    expect(runViews(work(viewCall('1', rows(['a']), 'fail')))).toEqual([])
  })

  it('draws them after the work, above the answer', () => {
    const run = { setup: [], steps: [], after: work(viewCall('1', rows(['first row']))) } as unknown as RecordRun
    render(inSession(<RunViews run={run} />))
    expect(document.querySelector('[data-kind="view"][data-view-id="progress"]')?.textContent).toContain('first row')
  })
})

describe('a question with a view', () => {
  it('lays out what the choice is between above the question, and keeps focus on the question', async () => {
    render(
      inSession(
        <AskQuestionPanel
          question={{
            requestId: 'q1',
            toolCallId: 't1',
            questions: [{ id: 'pick', prompt: 'Which one?', type: 'single', options: ['date-fns', 'dayjs'] }],
            view: fence([{ type: 'table', columns: [{ id: 'lib', label: 'Library' }, { id: 'kb', label: 'Size' }], rows: [{ cells: { lib: 'date-fns', kb: '13 kB' }, say: 'Use date-fns' }] }], 'libs')
          }}
          onSubmit={vi.fn()}
        />,
        { onSay: vi.fn() }
      )
    )
    expect(document.querySelector('[data-kind="view"]')?.textContent).toContain('13 kB')
    await waitFor(() => expect(document.activeElement?.closest('[data-kind="view"]')).toBeNull())
  })
})

describe('pinning a view to Home', () => {
  const answer = fence(
    [
      { type: 'stats', items: [{ label: 'Files', value: '12' }] },
      { type: 'live', source: 'git.changes' },
      { type: 'live', source: 'task.changes' },
      { type: 'actions', actions: [{ label: 'Explain', say: 'explain' }, { label: 'Stage all', do: { action: 'stage', paths: ['src/a.ts'] } }, { label: 'Open a.ts', do: { action: 'open', path: 'src/a.ts' } }] }
    ],
    'uncommitted'
  )

  it('keeps a view the agent answered with: its live parts only, tied to the task it came from', async () => {
    render(inSession(<ViewFence text={answer} streaming={false} onPlain={() => null} />))
    await screen.findByText('a.ts')
    fireEvent.click(screen.getByRole('button', { name: 'Pin to Home' }))
    const [p] = pinnedScreens()
    expect(p).toMatchObject({ workspacePath: 'C:/w', runId: 'r1', viewId: 'uncommitted', title: 'A view' })
    // The typed figure would go stale on Home, the task's own source has no task there, `say` has no one to speak to,
    // and a stage button's file list is as old as the view.
    const kept = JSON.parse(p!.spec) as { blocks: Array<{ type: string; source?: string; actions?: Array<{ label: string }> }> }
    expect(kept.blocks.map((b) => b.source ?? b.type)).toEqual(['git.changes', 'actions'])
    expect(kept.blocks[1]!.actions!.map((a) => a.label)).toEqual(['Open a.ts'])
    fireEvent.click(screen.getByRole('button', { name: 'Unpin from Home' }))
    expect(pinnedScreens()).toEqual([])
  })

  it('offers no pin for a view with nothing live on it', async () => {
    render(inSession(<ViewFence text={fence([{ type: 'stats', items: [{ label: 'Files', value: '12' }] }])} streaming={false} onPlain={() => null} />))
    await screen.findByText('Files')
    expect(screen.queryByRole('button', { name: 'Pin to Home' })).toBeNull()
  })

  it('opens a pinned view on its saved layout with fresh reads, and goes back to its task', async () => {
    const pinned = { id: 'p', workspacePath: 'C:/w', runId: 'r1', viewId: 'b', title: 'Branch', spec: JSON.stringify({ id: 'b', title: 'Branch', blocks: [{ type: 'live', source: 'git.branch' }] }), pinnedAt: '' }
    const onOpenTask = vi.fn()
    render(<ScreenPage request={{ pinned, nonce: 1 }} onClose={vi.fn()} onOpenTask={onOpenTask} onOpenWorkspaceFile={vi.fn()} />)
    await screen.findByText('Changed files')
    expect(api.gitStatus).toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }))
    expect(onOpenTask).toHaveBeenCalledWith('C:/w', 'r1')
    // No field of its own: questions go to the composer.
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('lists on Home only the pins of open workspaces', () => {
    const spec = JSON.stringify({ id: 'b', title: 'Branch', blocks: [{ type: 'live', source: 'git.branch' }] })
    pinScreen({ workspacePath: 'C:/w', viewId: 'b', title: 'Open one', spec })
    pinScreen({ workspacePath: 'C:/closed', viewId: 'b', title: 'Closed one', spec })
    render(<ScreensSection openWorkspaces={['C:/w']} onOpenScreen={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Open one' })).toBeTruthy()
    expect(screen.queryByText('Closed one')).toBeNull()
  })
})

describe('the palette', () => {
  it('offers no separate screen: what you type is a task', () => {
    render(
      <CommandPalette open onClose={vi.fn()} tasks={[]} commands={[]} newTaskIn={{ name: 'vyotiq' }} onOpenTask={vi.fn()} onOpenFile={vi.fn()} onRunCommand={vi.fn()} onNewTask={vi.fn()} />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks, files and commands' }), { target: { value: 'spend this week' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([expect.stringContaining('New task: “spend this week”')])
  })
})

describe('a live read that fails', () => {
  it('says why in a line, not with the command main ran', () => {
    // As main returned it for a workspace with no remote (gh leads, the command follows).
    const raw = 'no git remotes found' + String.fromCharCode(10) + 'Command failed: gh.exe pr view --json number,title,url,state,baseRefName,headRefName' + String.fromCharCode(10) + 'no git remotes found'
    expect(readFailure(raw)).toBe('This workspace has no git remote, so no pull request')
    expect(readFailure('Workspace is not open' + String.fromCharCode(10) + 'at x')).toBe('Workspace is not open')
    expect(readFailure('')).toBe('Could not read this')
  })
})
