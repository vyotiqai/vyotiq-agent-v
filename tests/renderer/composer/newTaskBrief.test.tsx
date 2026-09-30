/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, DEFAULT_TOOL_APPROVAL, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { briefStateFor, resetTaskDraftStoreForTests, setBriefState } from '@renderer/lib/drafts/taskDraftStore'

afterEach(() => {
  cleanup()
  resetWorkspaceHotUiStoreForTests()
  resetTaskDraftStoreForTests()
})

const chatSettings = {
  provider: 'ollama',
  model: 'qwen2.5',
  keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
  thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
  thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
  showThinking: DEFAULT_SETTINGS.showThinking,
  toolApproval: { ...DEFAULT_TOOL_APPROVAL, mode: 'mutating' as const }
} as EffectiveChatSettings

beforeEach(() => {
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [{ id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }],
        warning: null
      }
    })),
    agentContext: vi.fn(async () => ({
      ok: true as const,
      data: {
        workspaceName: 'ws',
        branch: 'main',
        rules: { agentsMd: false, claudeMd: true, cursorrules: false, ruleFileCount: 3 },
        memoryNotes: 2,
        memoryNoteNames: ['release-runbook', 'packaged-launch'],
        memoryIndex: false,
        memoryState: false,
        codeIndex: { state: 'ready' as const, files: 12408, indexedAt: new Date(Date.now() - 4 * 60_000).toISOString() }
      }
    })),
    onAgentContextChanged: vi.fn(() => () => {}),
    gitStatus: vi.fn(async () => ({
      ok: true as const,
      data: {
        kind: 'ok',
        status: { branch: 'main', files: [], truncated: false, fileCount: 2, added: 3, removed: 1, ahead: 1, hasRemote: true, hasCommits: true }
      }
    })),
    gitBranches: vi.fn(async () => ({ ok: true as const, data: [{ name: 'main', current: true }, { name: 'next', current: false }] })),
    gitCheckout: vi.fn(async () => ({ ok: true as const, data: { detail: 'Checked out next' } })),
    toolsCatalogGet: vi.fn(async () => ({
      ok: true as const,
      data: {
        entries: [
          { name: 'read', description: '', source: 'builtin', modes: ['agent'], active: true },
          { name: 'edit', description: '', source: 'builtin', modes: ['agent'], active: true },
          { name: 'search_code', description: '', source: 'builtin', modes: ['agent'], active: false, reason: 'code-index-off' },
          { name: 'mcp__github__issues', description: '', source: 'mcp', serverId: 'github', modes: ['agent'], active: false }
        ],
        servers: [{ id: 'github', name: 'GitHub', enabled: true, connected: false, loading: 'on-demand' }],
        codeIndexEnabled: true,
        autoModeSwitch: false,
        fingerprint: 'f'
      }
    })),
    onToolsCatalogChanged: vi.fn(() => () => {}),
    mcpStatus: vi.fn(async () => ({
      ok: true as const,
      data: {
        servers: [
          { id: 'github', name: 'GitHub', enabled: true, connected: false, toolCount: 0, error: 'Unauthorized', errorKind: 'sign-in' }
        ]
      }
    }))
  } as unknown as typeof window.vyotiq
})

function renderBrief(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const props = {
    provider: 'ollama' as const,
    model: 'qwen2.5',
    running: false,
    hasWorkspace: true,
    workspacePath: '/ws/app',
    secrets: emptySecretStatus(),
    chatSettings,
    onChatSettingsChange: vi.fn(),
    onProviderModel: vi.fn(),
    onSend: vi.fn(async () => true),
    variant: 'brief' as const,
    ...overrides
  }
  return { props, ...render(<Composer {...props} />) }
}

function typeBrief(text: string): void {
  const brief = screen.getByRole('combobox', { name: 'Brief' })
  brief.textContent = text
  fireEvent.input(brief)
}

describe('New task brief', () => {
  it('is a brief with its control row, its checks, and what the agent will see', async () => {
    renderBrief()
    const page = document.querySelector('[data-new-task]') as HTMLElement
    expect(within(page).getByRole('heading', { name: 'New task', level: 1 })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: 'Brief' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start task' }).hasAttribute('disabled')).toBe(true)
    // How it runs is the composer's own control row, inside the brief's box.
    const box = page.querySelector<HTMLElement>('[data-brief]')!
    const row = box.querySelector<HTMLElement>('[data-composer-controls]')!
    expect(row).toBeTruthy()
    // Agent leads the modes.
    const modes = within(row).getByRole('radiogroup', { name: 'Mode' })
    expect(within(modes).getAllByRole('radio')[0]!.textContent).toBe('Agent')
    expect(row.querySelector('[data-model-picker]')).toBeTruthy()
    expect(within(row).getByRole('button', { name: 'Attach files — or type @ for context' })).toBeTruthy()
    // No separate section repeats them, and no @ button: typing @ is the way in.
    expect(page.textContent).not.toContain('How it runs')
    expect(screen.queryByRole('button', { name: 'Add context (@)' })).toBeNull()
    // The placeholder says what Agent does.
    expect(page.textContent).toContain('the agent plans it, does it, and shows you the result')
    // Approvals: one quiet line beside Start task.
    expect(page.querySelector('[data-approval-note]')?.textContent).toContain(
      'Asks before edits and commands · MCP tools ask first'
    )

    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('2 changed · 1 ahead'))
    expect(sees.textContent).toContain('main')
    expect(sees.textContent).toContain('CLAUDE.md')
    expect(sees.textContent).toContain('+ 3 rule files')
    expect(sees.textContent).toContain('2 notes')
    expect(sees.textContent).toContain('release-runbook, packaged-launch')
    expect(sees.textContent).toContain('Ready')
    expect(sees.textContent).toContain('12,408 files · updated 4m ago')
    await waitFor(() => expect(sees.textContent).toContain('2 built-in · 1 MCP server'))
    await waitFor(() => expect(sees.textContent).toContain('GitHub needs sign-in'))
  })

  it('names the prompt-loaded memory files when there are no notes, not None', async () => {
    window.vyotiq.agentContext = vi.fn(async () => ({
      ok: true as const,
      data: {
        workspaceName: 'ws',
        branch: 'main',
        rules: { agentsMd: false, claudeMd: true, cursorrules: false, ruleFileCount: 3 },
        memoryNotes: 0,
        memoryIndex: true,
        memoryState: true,
        codeIndex: { state: 'ready' as const }
      }
    })) as unknown as typeof window.vyotiq.agentContext
    renderBrief()
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('state.md · index.md'))
    expect(sees.textContent).not.toContain('0 notes')
  })

  it('starts the task with its checks, a half-typed one included', async () => {
    const { props } = renderBrief()
    typeBrief('Fix the updater swap')
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'The updater suite passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    fireEvent.change(check, { target: { value: 'No retry around the swap' } })
    expect(within(screen.getByRole('list', { name: 'Done when' })).getByText('The updater suite passes')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    const [text, , , extras] = vi.mocked(props.onSend).mock.calls[0]!
    expect(text).toBe('Fix the updater swap')
    expect(extras).toEqual({ doneWhen: ['The updater suite passes', 'No retry around the swap'] })
  })

  it('takes Enter as a new line and starts on Ctrl+Enter, checks and all', async () => {
    const { props } = renderBrief()
    typeBrief('Fix the updater swap')
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Suite passes' } })
    const brief = screen.getByRole('combobox', { name: 'Brief' })
    fireEvent.keyDown(brief, { key: 'Enter' })
    expect(props.onSend).not.toHaveBeenCalled()
    fireEvent.keyDown(brief, { key: 'Enter', ctrlKey: true })
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ doneWhen: ['Suite passes'] })
  })

  it('removes a check, and sends none when there are none', async () => {
    const { props } = renderBrief()
    typeBrief('Tidy the nav')
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Lint passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    fireEvent.click(screen.getByRole('button', { name: 'Remove “Lint passes”' }))
    expect(screen.queryByText('Lint passes')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toBeUndefined()
  })

  it('saves the brief as a draft — text, checks and all — and starts over empty', async () => {
    const saveTaskDraft = vi.fn(async (payload: { brief: string; doneWhen: string[] }) => ({
      ok: true as const,
      data: {
        id: 'd0000000-0000-4000-8000-000000000001',
        brief: payload.brief,
        doneWhen: payload.doneWhen,
        createdAt: '2026-09-24T10:00:00Z',
        updatedAt: '2026-09-24T10:00:00Z'
      }
    }))
    window.vyotiq.saveTaskDraft = saveTaskDraft as unknown as typeof window.vyotiq.saveTaskDraft
    renderBrief()
    const save = screen.getByRole('button', { name: 'Save as draft' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    typeBrief('Fix the updater swap')
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Suite passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Half typed' } })
    // A disabled button carries its reason in a wrapper, so the enabled one is a new element.
    const enabled = screen.getByRole('button', { name: 'Save as draft' }) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)

    fireEvent.click(enabled)
    await waitFor(() => expect(saveTaskDraft).toHaveBeenCalledTimes(1))
    expect(saveTaskDraft).toHaveBeenCalledWith({
      workspacePath: '/ws/app',
      brief: 'Fix the updater swap',
      doneWhen: ['Suite passes', 'Half typed'],
      attachments: { images: [], files: [], nativeFiles: [], audio: [] }
    })
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Brief' }).textContent).toBe(''))
    expect(screen.queryByRole('list', { name: 'Done when' })).toBeNull()
    expect((screen.getByRole('textbox', { name: 'New check' }) as HTMLInputElement).value).toBe('')
    expect(briefStateFor('/ws/app')).toEqual({ draftId: null, checks: [], worktree: false })
  })

  it('keeps the checks in the brief’s box, the field for the next one always there', () => {
    renderBrief()
    const box = document.querySelector<HTMLElement>('[data-brief]')!
    const check = within(box).getByRole('textbox', { name: 'New check' }) as HTMLInputElement
    // Nothing to press first, and nothing folds on blur: no button moves under a press.
    expect(screen.queryByRole('button', { name: 'Add a check' })).toBeNull()
    fireEvent.change(check, { target: { value: 'Lint passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    expect(within(within(box).getByRole('list', { name: 'Done when' })).getByText('Lint passes')).toBeTruthy()
    fireEvent.blur(check)
    expect(within(box).getByRole('textbox', { name: 'New check' })).toBe(check)
    // The checks sit between the brief and the control row.
    const rows = Array.from(box.querySelectorAll('[data-done-when], [data-composer-controls]'))
    expect(rows.map((el) => (el.hasAttribute('data-done-when') ? 'checks' : 'controls'))).toEqual(['checks', 'controls'])

    // Escape drops a half-typed check and is kept; on an empty field it goes on up.
    fireEvent.change(check, { target: { value: 'Half' } })
    const onEscape = vi.fn()
    document.addEventListener('keydown', onEscape)
    fireEvent.keyDown(check, { key: 'Escape' })
    expect(check.value).toBe('')
    expect(onEscape).not.toHaveBeenCalled()
    fireEvent.keyDown(check, { key: 'Escape' })
    expect(onEscape).toHaveBeenCalledTimes(1)
    document.removeEventListener('keydown', onEscape)
  })

  it('keeps its checks when the page is left and opened again', () => {
    const first = renderBrief()
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Lint passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    first.unmount()
    renderBrief()
    expect(within(screen.getByRole('list', { name: 'Done when' })).getByText('Lint passes')).toBeTruthy()
  })

  it('continues a draft: Update draft saves over it, and starting spends it', async () => {
    setBriefState('/ws/app', { draftId: 'd0000000-0000-4000-8000-000000000002', checks: ['From the draft'] })
    const { props } = renderBrief()
    expect(screen.getByRole('button', { name: 'Update draft' })).toBeTruthy()
    expect(within(screen.getByRole('list', { name: 'Done when' })).getByText('From the draft')).toBeTruthy()
    typeBrief('Pick up where I left off')
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({
      doneWhen: ['From the draft'],
      draftId: 'd0000000-0000-4000-8000-000000000002'
    })
    await waitFor(() => expect(briefStateFor('/ws/app')).toEqual({ draftId: null, checks: [], worktree: false }))
  })

  it('moves the task to another workspace, brief and all', async () => {
    const onMove = vi.fn()
    renderBrief({
      newTaskTargets: {
        workspaces: [
          { path: '/ws/app', name: 'app' },
          { path: '/ws/site', name: 'site' }
        ],
        onMove
      }
    })
    typeBrief('Update the landing copy')
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(await screen.findByRole('option', { name: 'site' }))
    expect(onMove).toHaveBeenCalledWith('/ws/site', 'Update the landing copy')
  })

  it('checks out another branch from the header, after asking over a dirty tree', async () => {
    const nativeConfirm = vi.spyOn(window, 'confirm')
    renderBrief()
    fireEvent.click(await screen.findByRole('button', { name: 'Branch' }))
    fireEvent.click(await screen.findByRole('option', { name: 'next' }))
    // Two changed files: the app asks in its own dialog; declined, git is not asked.
    let ask = await screen.findByRole('dialog', { name: 'Switch branch' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Switch branch' })).toBeNull())
    expect(window.vyotiq.gitCheckout).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Branch' }))
    fireEvent.click(await screen.findByRole('option', { name: 'next' }))
    ask = await screen.findByRole('dialog', { name: 'Switch branch' })
    fireEvent.click(within(ask).getByRole('button', { name: 'Switch branch' }))
    await waitFor(() => expect(window.vyotiq.gitCheckout).toHaveBeenCalledWith('/ws/app', 'next'))
    expect(nativeConfirm).not.toHaveBeenCalled()
  })

  it('offers a new worktree: says where it will run, and starts with it asked for', async () => {
    const { props } = renderBrief()
    const where = await screen.findByRole('radiogroup', { name: 'Where it works' })
    // Both answers in view, in the header, on its right edge.
    expect(where.closest('[data-task-header]')).toBeTruthy()
    expect(within(where).getByRole('radio', { name: 'This folder' }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(within(where).getByRole('radio', { name: 'New worktree' }))
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    // Two uncommitted files in this folder: the worktree starts without them.
    await waitFor(() => expect(sees.textContent).toContain('New worktree'))
    expect(sees.textContent).toContain('from main · 2 uncommitted files stay here')
    expect(briefStateFor('/ws/app').worktree).toBe(true)

    typeBrief('Add backpressure to the chat stream')
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ worktree: true })
    // Started: the page's choice goes with the task.
    expect(briefStateFor('/ws/app').worktree).toBe(false)
  })

  it('offers no worktree when there is no commit to branch from', async () => {
    window.vyotiq.gitStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        kind: 'ok',
        status: { branch: 'main', files: [], truncated: false, fileCount: 0, added: 0, removed: 0, hasRemote: false, hasCommits: false }
      }
    })) as unknown as typeof window.vyotiq.gitStatus
    renderBrief()
    await screen.findByRole('button', { name: 'Branch' })
    expect(screen.queryByRole('radiogroup', { name: 'Where it works' })).toBeNull()
  })

  it('switches mode with Ctrl+. typed in the brief', () => {
    const onAgentModeChange = vi.fn()
    renderBrief({ onAgentModeChange })
    const brief = screen.getByRole('combobox', { name: 'Brief' })
    brief.focus()
    fireEvent.keyDown(brief, { key: '.', ctrlKey: true })
    expect(onAgentModeChange).toHaveBeenCalledWith('ask')
  })

  it('says what Ask does in the placeholder when Ask is picked', () => {
    renderBrief({ agentMode: 'ask' })
    const page = document.querySelector('[data-new-task]') as HTMLElement
    expect(page.textContent).toContain('the agent reads and answers, and changes nothing')
  })

  it('makes each fact you can change a way to where you change it', async () => {
    const onOpenSettings = vi.fn()
    const onOpenRules = vi.fn()
    renderBrief({ slashHandlers: { onOpenSettings, onOpenRules } })
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('2 built-in · 1 MCP server'))
    fireEvent.click(within(sees).getByRole('button', { name: /^Rules:\s*CLAUDE\.md.*change in Extensions$/ }))
    expect(onOpenRules).toHaveBeenCalledTimes(1)
    fireEvent.click(within(sees).getByRole('button', { name: /^Index:\s*Ready.*change in Settings$/ }))
    expect(onOpenSettings).toHaveBeenLastCalledWith('indexing')
    fireEvent.click(within(sees).getByRole('button', { name: /^Tools:.*change in Settings$/ }))
    expect(onOpenSettings).toHaveBeenLastCalledWith('tools')
    // The branch is picked in the header, and memory has no page: those stay facts.
    expect(sees.querySelector('[data-fact="Branch"] button')).toBeNull()
    expect(sees.querySelector('[data-fact="Memory"] button')).toBeNull()
  })

  it('leaves the facts as facts with nowhere to send them', async () => {
    renderBrief()
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('Ready'))
    expect(within(sees).queryAllByRole('button')).toHaveLength(0)
  })

  it('opens Settings → Agent from the approvals line', () => {
    const onOpenSettings = vi.fn()
    renderBrief({ slashHandlers: { onOpenSettings } })
    const note = document.querySelector<HTMLElement>('[data-approval-note]')!
    fireEvent.click(within(note).getByRole('button', { name: 'Change' }))
    expect(onOpenSettings).toHaveBeenCalledWith('agent')
  })
})
