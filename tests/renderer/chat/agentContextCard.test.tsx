/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { AgentContextCard } from '@renderer/features/chat/components/AgentContextCard'

const fixture = {
  workspaceName: 'demo-workspace',
  branch: 'main',
  rules: { agentsMd: true, claudeMd: false, cursorrules: true, ruleFileCount: 2 },
  memoryNotes: 3,
  codeIndex: { state: 'ready' as const }
}

type PushPayload = { workspacePath: string; context: typeof fixture }

let agentContextSpy: Mock
let gitInitSpy: Mock
let onChangedSpy: Mock
let offSpy: Mock
let push: ((payload: PushPayload) => void) | null

/** Deliver a main-process push the way the preload listener would. */
function emit(payload: PushPayload): void {
  if (!push) throw new Error('card never subscribed to onAgentContextChanged')
  act(() => push!(payload))
}

describe('AgentContextCard', () => {
  beforeEach(() => {
    agentContextSpy = vi.fn()
    gitInitSpy = vi.fn().mockResolvedValue({ ok: true, data: { branch: 'main' } })
    offSpy = vi.fn()
    push = null
    onChangedSpy = vi.fn((handler: (payload: PushPayload) => void) => {
      push = handler
      return offSpy
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        agentContext: agentContextSpy,
        gitInit: gitInitSpy,
        onAgentContextChanged: onChangedSpy
      }
    })
  })

  afterEach(cleanup)

  it('renders every reading as a label/value pair from real bridge values', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(screen.getByText('main')).toBeTruthy()
    })
    for (const label of ['Branch', 'Rules', 'Memory', 'Index']) {
      expect(screen.getByText(label)).toBeTruthy()
    }
    expect(screen.getByText('AGENTS.md')).toBeTruthy()
    expect(screen.getByText('.cursorrules')).toBeTruthy()
    expect(screen.getByText('2 rules')).toBeTruthy()
    expect(screen.getByText('3 notes')).toBeTruthy()
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('group', { name: 'What the agent knows' })).toBeTruthy()
    expect(document.querySelector('[data-agent-context-card]')).toBeTruthy()
    expect(agentContextSpy).toHaveBeenCalledWith({ workspacePath: 'C:/code/demo' })
  })

  it('never repeats the workspace name the empty-state heading already shows', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    expect(screen.queryByText('demo-workspace')).toBeNull()
  })

  it('shows the dim skeleton while the bridge promise is pending', () => {
    agentContextSpy.mockImplementation(() => new Promise(() => {}))
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(document.querySelector('[data-agent-context-card-skeleton]')).toBeTruthy()
    expect(document.querySelector('[data-agent-context-card]')).toBeNull()
    // One placeholder per reading, so the strip does not resize when it lands.
    expect(document.querySelectorAll('.acc-skel-value').length).toBe(4)
  })

  it('renders nothing on IPC rejection', async () => {
    agentContextSpy.mockRejectedValue(new Error('ipc down'))
    const { container } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(container.querySelector('[data-agent-context-card-skeleton]')).toBeNull()
    })
    expect(container.querySelector('[data-agent-context-card]')).toBeNull()
  })

  it('renders nothing on an error IpcResult', async () => {
    agentContextSpy.mockResolvedValue({ ok: false, error: 'no workspace' })
    const { container } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await waitFor(() => {
      expect(container.querySelector('[data-agent-context-card-skeleton]')).toBeNull()
    })
    expect(container.querySelector('[data-agent-context-card]')).toBeNull()
  })

  it('renders a muted dot and Off for the off state', async () => {
    agentContextSpy.mockResolvedValue({
      ok: true,
      data: { ...fixture, codeIndex: { state: 'off' as const } }
    })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(await screen.findByText('Off')).toBeTruthy()
    expect(document.querySelector('.acc-dot-off')).toBeTruthy()
  })

  it('keeps the branch reading in place when the workspace is not a repo', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    // The reading stays — an empty column would leave a hole in the strip.
    expect(await screen.findByText('Not a repo')).toBeTruthy()
    expect(screen.getByText('Branch')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
  })

  it('hides absent rule names and never shows 0', async () => {
    agentContextSpy.mockResolvedValue({
      ok: true,
      data: {
        ...fixture,
        rules: { agentsMd: false, claudeMd: false, cursorrules: false, ruleFileCount: 0 }
      }
    })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    expect(screen.queryByText('AGENTS.md')).toBeNull()
    expect(screen.queryByText('.cursorrules')).toBeNull()
    expect(screen.queryByText('0 rules')).toBeNull()
    expect(screen.getByText('None')).toBeTruthy()
  })

  it('reads an empty memory store as None, not 0 notes', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, memoryNotes: 0 } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    expect(screen.queryByText('0 notes')).toBeNull()
    expect(screen.getByText('None')).toBeTruthy()
  })

  it('singularises a lone memory note', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, memoryNotes: 1 } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(await screen.findByText('1 note')).toBeTruthy()
  })

  it('applies a pushed summary without re-reading over IPC', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')

    emit({
      workspacePath: 'C:/code/demo',
      context: { ...fixture, branch: 'feat/live', memoryNotes: 7 }
    })

    expect(screen.getByText('feat/live')).toBeTruthy()
    expect(screen.getByText('7 notes')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
    // Live means pushed, not polled.
    expect(agentContextSpy).toHaveBeenCalledTimes(1)
  })

  it('ignores a push for a different workspace', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')

    emit({
      workspacePath: 'C:/code/other',
      context: { ...fixture, branch: 'someone-elses-branch' }
    })

    expect(screen.queryByText('someone-elses-branch')).toBeNull()
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('matches the pushed path the way the rest of the app does', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')

    // Main echoes the path it was given; separators and Windows casing must
    // not decide whether the pane sees its own update.
    emit({ workspacePath: 'c:\\code\\demo', context: { ...fixture, branch: 'feat/live' } })

    expect(screen.getByText('feat/live')).toBeTruthy()
  })

  it('keeps a push that beat the first read', async () => {
    let settle: (value: { ok: true; data: typeof fixture }) => void = () => {}
    agentContextSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    render(<AgentContextCard workspacePath="C:/code/demo" />)

    emit({ workspacePath: 'C:/code/demo', context: { ...fixture, branch: 'feat/live' } })
    expect(screen.getByText('feat/live')).toBeTruthy()

    // The in-flight read resolves with what was true before the push.
    await act(async () => {
      settle({ ok: true, data: fixture })
    })
    expect(screen.getByText('feat/live')).toBeTruthy()
    expect(screen.queryByText('main')).toBeNull()
  })

  it('unsubscribes from pushes on unmount', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    const { unmount } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    expect(onChangedSpy).toHaveBeenCalledTimes(1)
    expect(offSpy).not.toHaveBeenCalled()
    unmount()
    expect(offSpy).toHaveBeenCalledTimes(1)
  })

  it('offers git init only when there is no repository', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    const { unmount } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    expect(screen.queryByRole('button', { name: 'Initialize' })).toBeNull()
    unmount()

    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('Not a repo')
    expect(screen.getByRole('button', { name: 'Initialize' })).toBeTruthy()
  })

  it('never initializes a repository on its own', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('Not a repo')
    // Mounting, reading and even pushing must not create a repository.
    emit({ workspacePath: 'C:/code/demo', context: { ...fixture, branch: null } })
    expect(gitInitSpy).not.toHaveBeenCalled()
  })

  it('runs git init for this workspace on click, then re-reads instead of waiting on a push', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('Not a repo')

    // The watcher does not reliably carry a `.git` that has just been created:
    // on Windows this strip sat on "Not a repo" for the full timeout over a
    // repository that existed on disk. So the click re-reads what it changed.
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: 'main' } })
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Initialize' }))
    })
    expect(gitInitSpy).toHaveBeenCalledWith({ workspacePath: 'C:/code/demo' })
    expect(agentContextSpy).toHaveBeenCalledTimes(2)
    expect(await screen.findByText('main')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Initialize' })).toBeNull()
  })

  it('renders only what main answers after an init, never a branch it assumed', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('Not a repo')

    // Init reported success but the re-read still says there is no repository.
    // The card has no business inventing a branch to cover that gap.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Initialize' }))
    })
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.getByText('Not a repo')).toBeTruthy()

    // A push arriving afterwards is still applied.
    emit({ workspacePath: 'C:/code/demo', context: { ...fixture, branch: 'main' } })
    expect(screen.getByText('main')).toBeTruthy()
  })

  it('shows the real reason a git init failed and keeps the button', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: { ...fixture, branch: null } })
    gitInitSpy.mockResolvedValue({ ok: false, error: 'Git is not installed or not on PATH' })
    render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('Not a repo')

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Initialize' }))
    })
    const failed = screen.getByText('Init failed')
    expect(failed.getAttribute('title')).toBe('Git is not installed or not on PATH')
    expect(screen.getByRole('button', { name: 'Initialize' })).toBeTruthy()
  })

  it('invokes the bridge exactly once per mount and not on rerender', async () => {
    agentContextSpy.mockResolvedValue({ ok: true, data: fixture })
    const { rerender } = render(<AgentContextCard workspacePath="C:/code/demo" />)
    await screen.findByText('main')
    rerender(<AgentContextCard workspacePath="C:/code/demo" />)
    rerender(<AgentContextCard workspacePath="C:/code/demo" />)
    expect(agentContextSpy).toHaveBeenCalledTimes(1)
  })
})
