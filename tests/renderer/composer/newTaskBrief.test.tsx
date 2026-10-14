/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { Composer } from '@renderer/features/chat/components/composer'
import { DEFAULT_SETTINGS, DEFAULT_TOOL_APPROVAL, emptySecretStatus } from '@shared/ipc'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { resetWorkspaceHotUiStoreForTests } from '@renderer/lib/hooks/workspaceHotUiStore'
import { briefStateFor, resetTaskDraftStoreForTests, setBriefState } from '@renderer/lib/drafts/taskDraftStore'
import {
  clearComposerAttachments,
  composerAttachmentKey,
  setComposerAttachments
} from '@renderer/lib/hooks/composerAttachmentStore'

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

/** The caret beside Start: Save as draft, Schedule…, Also run on. */
async function openStartMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'More ways to start' }))
  return screen.findByRole('menu', { name: 'More ways to start' })
}

/** Attach → Let it edit another folder…: the OS picker, checked by main. */
async function addFolderFromAttach(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'Attach files — or type @ for context' }))
  const menu = await screen.findByRole('menu', { name: 'Attach' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: /Let it edit another folder/ }))
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
    // Start task ends that row: the box closes with its own action.
    expect(within(row).getByRole('button', { name: 'Start task' })).toBeTruthy()
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
    // Permissions: a control in the row, beside the model, quiet at the default.
    expect(within(row).getByRole('button', { name: 'Permissions: Asks before edits' })).toBeTruthy()
    // Nothing is left under the box: its old row's actions have homes of their own.
    expect(page.querySelector('[data-approval-note]')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Save as draft' })).toBeNull()
    // The header reads as a sentence: in this workspace, on this branch.
    const header = page.querySelector<HTMLElement>('[data-task-header]')!
    await waitFor(() => expect(within(header).getByRole('button', { name: 'Branch' }).textContent).toContain('main'))

    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('2 changed'))
    expect(sees.textContent).toContain('1 ahead')
    expect(sees.textContent).toContain('CLAUDE.md')
    expect(sees.textContent).toContain('+ 3 rule files')
    expect(sees.textContent).toContain('2 notes')
    expect(sees.textContent).toContain('release-runbook, packaged-launch')
    expect(sees.textContent).toContain('Ready')
    expect(sees.textContent).toContain('12,408 source files · updated 4m ago')
    await waitFor(() => expect(sees.textContent).toContain('2 built-in · 1 MCP server'))
    await waitFor(() => expect(sees.textContent).toContain('GitHub needs sign-in'))
  })

  it('keeps every fact on one left edge, under the brief, with no colon after the key', async () => {
    renderBrief()
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('1 ahead'))
    // Under the box the facts share the brief's 780 measure and centre.
    expect(sees.className).toContain('max-w-[780px]')
    expect(sees.className).toContain('mx-auto')
    expect(sees.className).toContain('@[1100px]:max-w-none')
    for (const row of Array.from(sees.querySelectorAll<HTMLElement>('[data-fact]'))) {
      const inner = row.firstElementChild as HTMLElement
      // A button row nets -mx-2 + px-2 to zero; a plain row must add no inset.
      if (inner.tagName === 'BUTTON') expect(inner.className).toContain('-mx-2')
      else expect(inner.className).not.toContain('px-2')
      const key = row.querySelector('.text-caption.text-tertiary')!
      expect(key.querySelector('.sr-only')?.textContent).toBe(':')
    }
    // The first fact is the working tree's state; the branch's name is the header's.
    expect(sees.querySelector('[data-fact="Working tree"]')).toBeTruthy()
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
    let menu = await openStartMenu()
    expect((within(menu).getByRole('menuitem', { name: /^Save as draft/ }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.keyDown(menu, { key: 'Escape' })
    typeBrief('Fix the updater swap')
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Suite passes' } })
    fireEvent.keyDown(check, { key: 'Enter' })
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Half typed' } })
    menu = await openStartMenu()
    const save = within(menu).getByRole('menuitem', { name: /^Save as draft/ }) as HTMLButtonElement
    expect(save.disabled).toBe(false)

    fireEvent.click(save)
    await waitFor(() => expect(saveTaskDraft).toHaveBeenCalledTimes(1))
    // Where it runs goes with it: the worktree choice (and any added folders).
    expect(saveTaskDraft).toHaveBeenCalledWith({
      workspacePath: '/ws/app',
      brief: 'Fix the updater swap',
      doneWhen: ['Suite passes', 'Half typed'],
      attachments: { images: [], files: [], nativeFiles: [], audio: [] },
      worktree: false
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
    const menu = await openStartMenu()
    expect(within(menu).getByRole('menuitem', { name: /^Update draft/ })).toBeTruthy()
    fireEvent.keyDown(menu, { key: 'Escape' })
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
        onMove: onMove as unknown as (from: string, to: string, brief: unknown) => Promise<boolean>
      }
    })
    typeBrief('Update the landing copy')
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Copy reviewed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }))
    fireEvent.click(await screen.findByRole('option', { name: 'site' }))
    // The whole brief moves: its checks (a half-typed one too), folders, worktree choice and attachments.
    expect(onMove).toHaveBeenCalledWith('/ws/app', '/ws/site', {
      text: 'Update the landing copy',
      checks: ['Copy reviewed'],
      extraRoots: [],
      worktree: false,
      attachments: { images: [], files: [], nativeFiles: [], audio: [] }
    })
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

  it('also runs on a second model: Start asks for both', async () => {
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false },
          { id: 'llama3.3', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }
        ],
        warning: null
      }
    })) as unknown as typeof window.vyotiq.listModels
    const { props } = renderBrief()
    await screen.findByRole('radiogroup', { name: 'Where it works' })
    const menu = await openStartMenu()
    expect(within(menu).getByRole('menuitemcheckbox', { name: /^One model/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.click(await within(menu).findByRole('menuitemcheckbox', { name: /^llama3\.3/ }))
    // Start says what it will do.
    await screen.findByRole('button', { name: 'Start 2 tasks' })
    typeBrief('Speed up the importer')
    fireEvent.click(screen.getByRole('button', { name: 'Start 2 tasks' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ compareWith: { provider: 'ollama', model: 'llama3.3' } })
    // Started: the next brief is one model again.
    await screen.findByRole('button', { name: 'Start task' })
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

  it('counts the tools a run here sends, not the ones it leaves out', async () => {
    const get = window.vyotiq.toolsCatalogGet as unknown as (req: { workspacePath: string }) => Promise<unknown>
    const base = (await get({ workspacePath: '/ws/app' })) as { ok: true; data: Record<string, unknown> }
    // No git remote here: a run drops the GitHub tools, so New task does too.
    window.vyotiq.toolsCatalogGet = vi.fn(async () => ({
      ok: true as const,
      data: { ...base.data, notApplicable: ['edit'] }
    })) as unknown as typeof window.vyotiq.toolsCatalogGet
    renderBrief()
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('1 built-in · 1 MCP server'))
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
    // Memory is kept and cleared in Settings → Agent.
    fireEvent.click(within(sees).getByRole('button', { name: /^Memory:\s*2 notes.*change in Settings$/ }))
    expect(onOpenSettings).toHaveBeenLastCalledWith('agent')
    // The branch is picked in the header: it stays a fact.
    expect(sees.querySelector('[data-fact="Branch"] button')).toBeNull()
  })

  it('leaves the facts as facts with nowhere to send them', async () => {
    renderBrief()
    const sees = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(sees.textContent).toContain('Ready'))
    // Only the fold toggle a narrow column uses; no fact is a link.
    expect(within(sees).queryAllByRole('button').filter((b) => !b.hasAttribute('aria-expanded'))).toHaveLength(0)
  })

  it('changes how tools ask from the control row, and opens Agent settings from it', async () => {
    const onOpenSettings = vi.fn()
    const { props } = renderBrief({ slashHandlers: { onOpenSettings } })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Asks before edits' }))
    let menu = await screen.findByRole('menu', { name: 'Permissions' })
    fireEvent.click(within(menu).getByRole('menuitemcheckbox', { name: /^Doesn’t ask/ }))
    expect(props.onChatSettingsChange).toHaveBeenCalledWith({
      toolApproval: { ...chatSettings.toolApproval, mode: 'off' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Permissions: Asks before edits' }))
    menu = await screen.findByRole('menu', { name: 'Permissions' })
    fireEvent.click(within(menu).getByRole('menuitem', { name: /Agent settings/ }))
    expect(onOpenSettings).toHaveBeenCalledWith('agent')
  })

  it('adds a folder through main, lists it, sends it with the start, and removes it', async () => {
    const pickExtraRoot = vi.fn(async () => ({ ok: true as const, data: { path: '/ws/backend' } }))
    window.vyotiq.pickExtraRoot = pickExtraRoot as unknown as typeof window.vyotiq.pickExtraRoot
    const { props } = renderBrief()
    await addFolderFromAttach()
    await waitFor(() => expect(screen.getByRole('list', { name: 'Added folders' }).textContent).toContain('backend'))
    expect(pickExtraRoot).toHaveBeenCalledWith({ workspacePath: '/ws/app', current: [] })
    expect(briefStateFor('/ws/app').extraRoots).toEqual(['/ws/backend'])

    fireEvent.click(screen.getByRole('button', { name: 'Remove folder /ws/backend' }))
    await waitFor(() => expect(screen.queryByRole('list', { name: 'Added folders' })).toBeNull())

    await addFolderFromAttach()
    await waitFor(() => expect(screen.getByRole('list', { name: 'Added folders' })).toBeTruthy())
    typeBrief('Wire the API')
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toEqual({ extraRoots: ['/ws/backend'] })
  })

  it('says why main refused a folder and keeps the list as it was', async () => {
    window.vyotiq.pickExtraRoot = vi.fn(async () => ({
      ok: true as const,
      data: { path: null, refused: '/ws/app/sub: already part of the workspace' }
    })) as unknown as typeof window.vyotiq.pickExtraRoot
    renderBrief()
    await addFolderFromAttach()
    await waitFor(() => expect(window.vyotiq.pickExtraRoot).toHaveBeenCalled())
    expect(screen.queryByRole('list', { name: 'Added folders' })).toBeNull()
    expect(briefStateFor('/ws/app').extraRoots).toBeUndefined()
  })
})

describe('New task brief: Structure’s Done when', () => {
  const STRUCTURED = 'Add CSV export.\n\n## Done when\n- Export downloads a .csv\n- Columns match the table'

  async function structure(): Promise<HTMLElement> {
    window.vyotiq.promptStructure = vi.fn(async () => ({
      ok: true as const,
      data: { kind: 'brief' as const, taskType: 'feature' as const, brief: STRUCTURED }
    })) as unknown as typeof window.vyotiq.promptStructure
    typeBrief('add csv export to the usage page')
    const button = document.querySelector<HTMLButtonElement>('[data-composer-structure]')!
    await waitFor(() => expect(button.disabled).toBe(false))
    fireEvent.click(button)
    return waitFor(() => {
      const strip = document.querySelector<HTMLElement>('[data-structure-done]')
      expect(strip).not.toBeNull()
      return strip!
    })
  }

  const brief = (): string => screen.getByRole('combobox', { name: 'Brief' }).textContent ?? ''

  it('moves the bullets into the checks on one click, out of the brief', async () => {
    const { props } = renderBrief()
    const strip = await structure()
    // Nothing moves until asked.
    expect(briefStateFor('/ws/app').checks).toEqual([])
    const move = within(strip).getByRole('button', { name: 'Move 2 to checks' })
    fireEvent.click(move)
    await waitFor(() => expect(briefStateFor('/ws/app').checks).toEqual(['Export downloads a .csv', 'Columns match the table']))
    expect(brief()).toContain('Add CSV export.')
    expect(brief()).not.toContain('Done when')
    const list = within(screen.getByRole('list', { name: 'Done when' }))
    expect(list.getByText('Export downloads a .csv')).toBeTruthy()
    expect(strip.textContent).toContain('2 checks added')
    expect(within(strip).queryByRole('button', { name: /to checks/ })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toMatchObject({
      doneWhen: ['Export downloads a .csv', 'Columns match the table']
    })
  })

  it('Undo puts the words back and takes out only the checks it added', async () => {
    setBriefState('/ws/app', { draftId: null, checks: ['Lint passes'] })
    renderBrief()
    const strip = await structure()
    fireEvent.click(within(strip).getByRole('button', { name: 'Move 2 to checks' }))
    await waitFor(() => expect(briefStateFor('/ws/app').checks).toHaveLength(3))
    const check = screen.getByRole('textbox', { name: 'New check' })
    fireEvent.change(check, { target: { value: 'Typed after' } })
    fireEvent.keyDown(check, { key: 'Enter' })

    fireEvent.click(within(strip).getByRole('button', { name: /Undo/ }))
    await waitFor(() => expect(brief()).toBe('add csv export to the usage page'))
    expect(briefStateFor('/ws/app').checks).toEqual(['Lint passes', 'Typed after'])
    expect(document.querySelector('[data-structure-done]')).toBeNull()
  })

  it('Ctrl+Z right after the move undoes the brief and its checks together', async () => {
    renderBrief()
    const strip = await structure()
    fireEvent.click(within(strip).getByRole('button', { name: 'Move 2 to checks' }))
    await waitFor(() => expect(briefStateFor('/ws/app').checks).toHaveLength(2))
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Brief' }), { key: 'z', ctrlKey: true })
    await waitFor(() => expect(brief()).toBe('add csv export to the usage page'))
    expect(briefStateFor('/ws/app').checks).toEqual([])
  })
})

describe('New task brief: fixes from the audit', () => {
  it('schedules the brief as Ask when Ask is picked, as plain words, with a half-typed check (B3)', async () => {
    const { onRepeatTaskRequest } = await import('@renderer/features/schedules/scheduleRequests')
    const asked = vi.fn()
    const off = onRepeatTaskRequest(asked)
    renderBrief({ agentMode: 'ask' })
    const brief = screen.getByRole('combobox', { name: 'Brief' })
    // A file chip as the composer stores it: a marker the scheduled run could not read.
    const { mentionMarker } = await import('@renderer/features/chat/components/composer/mentionModel')
    brief.textContent = `Explain ${mentionMarker({ kind: 'file', path: 'src/app/updater.ts' })} briefly`
    fireEvent.input(brief)
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Names the swap step' } })
    const menu = await openStartMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Schedule/ }))
    expect(asked).toHaveBeenCalledTimes(1)
    const req = asked.mock.calls[0]![0]
    expect(req.mode).toBe('ask')
    expect(req.instruction).toBe('Explain @src/app/updater.ts briefly')
    expect(req.instruction).not.toMatch(/[￹￺]/)
    expect(req.doneWhen).toEqual(['Names the swap step'])
    off()
  })

  it('saves a draft with Ctrl+S from anywhere in the box (D2)', async () => {
    const saveTaskDraft = vi.fn(async (payload: { brief: string; doneWhen: string[] }) => ({
      ok: true as const,
      data: { id: 'd0000000-0000-4000-8000-000000000009', brief: payload.brief, doneWhen: payload.doneWhen, createdAt: 'x', updatedAt: 'x' }
    }))
    window.vyotiq.saveTaskDraft = saveTaskDraft as unknown as typeof window.vyotiq.saveTaskDraft
    renderBrief()
    typeBrief('Put this aside')
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Brief' }), { key: 's', ctrlKey: true })
    await waitFor(() => expect(saveTaskDraft).toHaveBeenCalledTimes(1))
  })

  it('keeps one copy of a check typed twice (B13)', () => {
    renderBrief()
    const check = screen.getByRole('textbox', { name: 'New check' })
    for (let i = 0; i < 2; i += 1) {
      fireEvent.change(check, { target: { value: 'Lint passes' } })
      fireEvent.keyDown(check, { key: 'Enter' })
    }
    expect(within(screen.getByRole('list', { name: 'Done when' })).getAllByRole('listitem')).toHaveLength(1)
  })

  it('drops Also run on when the main model becomes the one compared with (B6)', async () => {
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          { id: 'qwen2.5', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false },
          { id: 'llama3.3', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }
        ],
        warning: null
      }
    })) as unknown as typeof window.vyotiq.listModels
    const { props, rerender } = renderBrief()
    await screen.findByRole('radiogroup', { name: 'Where it works' })
    const menu = await openStartMenu()
    fireEvent.click(await within(menu).findByRole('menuitemcheckbox', { name: /^llama3\.3/ }))
    await screen.findByRole('button', { name: 'Start 2 tasks' })
    rerender(<Composer {...props} model="llama3.3" />)
    await screen.findByRole('button', { name: 'Start task' })
  })

  it('does not send a worktree its switch no longer offers (B9)', async () => {
    window.vyotiq.gitStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        kind: 'ok',
        status: { branch: 'main', files: [], truncated: false, fileCount: 0, added: 0, removed: 0, hasRemote: false, hasCommits: false }
      }
    })) as unknown as typeof window.vyotiq.gitStatus
    setBriefState('/ws/app', { draftId: null, checks: [], worktree: true })
    const { props } = renderBrief()
    await screen.findByRole('button', { name: 'Branch' })
    expect(screen.queryByRole('radiogroup', { name: 'Where it works' })).toBeNull()
    typeBrief('Bootstrap the repo')
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toBeUndefined()
  })

  it('lists this workspace’s drafts under the box and opens one through the app (D7)', async () => {
    const draft = {
      id: 'd0000000-0000-4000-8000-000000000010',
      brief: 'Split billing.ts into modules',
      doneWhen: [],
      createdAt: '2026-10-01T10:00:00Z',
      updatedAt: '2026-10-01T10:00:00Z'
    }
    window.vyotiq.listTaskDrafts = vi.fn(async () => ({ ok: true as const, data: { drafts: [draft] } })) as unknown as typeof window.vyotiq.listTaskDrafts
    const { onOpenTaskDraftRequest } = await import('@renderer/lib/drafts/taskDraftStore')
    const open = vi.fn()
    const off = onOpenTaskDraftRequest(open)
    renderBrief()
    const row = await screen.findByRole('button', { name: /Split billing\.ts into modules/ })
    fireEvent.click(row)
    expect(open).toHaveBeenCalledWith('/ws/app', draft)
    off()
  })
})

/** A git status as the brief reads it; `onGitStatusChanged` re-reads it. */
function gitStatusReturning(status: { branch: string; fileCount: number }): void {
  window.vyotiq.gitStatus = vi.fn(async () => ({
    ok: true as const,
    data: {
      kind: 'ok',
      status: { files: [], truncated: false, added: 0, removed: 0, ahead: 0, hasRemote: true, hasCommits: true, ...status }
    }
  })) as unknown as typeof window.vyotiq.gitStatus
}

function captureGitStatusChanged(): () => void {
  let fire: (payload: { workspacePath: string }) => void = () => {}
  window.vyotiq.onGitStatusChanged = vi.fn((h: (payload: { workspacePath: string }) => void) => {
    fire = h
    return () => {}
  }) as unknown as typeof window.vyotiq.onGitStatusChanged
  return () => act(() => fire({ workspacePath: '/ws/app' }))
}

describe('New task brief: audit fixes, guarded', () => {
  afterEach(() => {
    const key = composerAttachmentKey('/ws/app', null)
    if (key) clearComposerAttachments(key)
  })

  it('offers no Save as draft for attachments alone, which main would refuse (B4)', async () => {
    setComposerAttachments(composerAttachmentKey('/ws/app', null)!, {
      images: ['data:image/png;base64,AAAA'],
      files: [],
      nativeFiles: [],
      audio: []
    })
    renderBrief()
    await waitFor(() => expect((screen.getByRole('button', { name: 'Start task' }) as HTMLButtonElement).disabled).toBe(false))
    const menu = await openStartMenu()
    expect((within(menu).getByRole('menuitem', { name: /^Save as draft/ }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('a half-typed check alone can be saved, and at 20 checks its field stays (B10)', async () => {
    renderBrief()
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Only this' } })
    const menu = await openStartMenu()
    expect((within(menu).getByRole('menuitem', { name: /^Save as draft/ }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.keyDown(menu, { key: 'Escape' })
    cleanup()
    setBriefState('/ws/app', { draftId: null, checks: Array.from({ length: 20 }, (_, i) => `Check ${i + 1}`), worktree: false })
    renderBrief()
    const field = screen.getByRole('textbox', { name: 'New check' }) as HTMLInputElement
    expect(field.placeholder).toBe('20 checks is the limit')
  })

  it('locks the brief while a draft saves, and Start says why it waits (B8, B11)', async () => {
    let finish: (value: unknown) => void = () => {}
    window.vyotiq.saveTaskDraft = vi.fn(
      () => new Promise((resolve) => (finish = resolve))
    ) as unknown as typeof window.vyotiq.saveTaskDraft
    renderBrief()
    typeBrief('Put this aside')
    const brief = screen.getByRole('combobox', { name: 'Brief' })
    const menu = await openStartMenu()
    fireEvent.click(within(menu).getByRole('menuitem', { name: /^Save as draft/ }))
    await waitFor(() => expect(brief.getAttribute('aria-readonly')).toBe('true'))
    const start = screen.getByRole('button', { name: 'Start task' })
    expect((start as HTMLButtonElement).disabled).toBe(true)
    fireEvent.pointerEnter(start.parentElement!, { pointerType: 'mouse' })
    expect(await screen.findByText('Saving the draft…', {}, { timeout: 2000 })).toBeTruthy()
    await act(async () => {
      finish({
        ok: true,
        data: { id: 'd0000000-0000-4000-8000-000000000011', brief: 'Put this aside', doneWhen: [], createdAt: 'x', updatedAt: 'x' }
      })
    })
    await waitFor(() => expect(brief.getAttribute('aria-readonly')).not.toBe('true'))
  })

  it('a start clears the half-typed check it sent (W6)', async () => {
    const { props } = renderBrief()
    typeBrief('Ship it')
    fireEvent.change(screen.getByRole('textbox', { name: 'New check' }), { target: { value: 'Smoke test passes' } })
    fireEvent.click(screen.getByRole('button', { name: 'Start task' }))
    await waitFor(() => expect(props.onSend).toHaveBeenCalledTimes(1))
    expect(vi.mocked(props.onSend).mock.calls[0]![3]).toMatchObject({ doneWhen: ['Smoke test passes'] })
    await waitFor(() => expect((screen.getByRole('textbox', { name: 'New check' }) as HTMLInputElement).value).toBe(''))
  })

  it('reads git status again when it changes, so the rail stays current (W4)', async () => {
    const fireChanged = captureGitStatusChanged()
    gitStatusReturning({ branch: 'main', fileCount: 2 })
    renderBrief()
    const rail = screen.getByRole('complementary', { name: 'What the agent will see' })
    await waitFor(() => expect(rail.textContent).toContain('2 changed'))
    gitStatusReturning({ branch: 'main', fileCount: 5 })
    fireChanged()
    await waitFor(() => expect(rail.textContent).toContain('5 changed'))
  })

  it('takes one branch pick at a time, and drops a failed checkout’s alert once the branch changes (B12)', async () => {
    const fireChanged = captureGitStatusChanged()
    gitStatusReturning({ branch: 'main', fileCount: 0 })
    let finish: (value: unknown) => void = () => {}
    window.vyotiq.gitCheckout = vi.fn(
      () => new Promise((resolve) => (finish = resolve))
    ) as unknown as typeof window.vyotiq.gitCheckout
    renderBrief()
    fireEvent.click(await screen.findByRole('button', { name: 'Branch' }))
    fireEvent.click(await screen.findByRole('option', { name: 'next' }))
    await waitFor(() => expect(window.vyotiq.gitCheckout).toHaveBeenCalledTimes(1))
    expect((screen.getByRole('button', { name: 'Branch' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish({ ok: false, error: 'Your local changes would be overwritten' }))
    expect((await screen.findByRole('alert')).textContent).toContain('would be overwritten')
    gitStatusReturning({ branch: 'next', fileCount: 0 })
    fireChanged()
    await waitFor(() => expect(screen.queryByText(/would be overwritten/)).toBeNull())
  })
})

describe('New task brief: ↑ and ↓ in a recalled brief of several lines (B7)', () => {
  afterEach(() => localStorage.removeItem('vyotiq.briefHistory'))

  function caretAt(el: HTMLElement, where: 'start' | 'end'): void {
    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(where === 'start')
    const sel = window.getSelection()!
    sel.removeAllRanges()
    sel.addRange(range)
  }

  it('moves the caret inside it, and steps to the older brief only from its first position', async () => {
    localStorage.setItem('vyotiq.briefHistory', JSON.stringify(['First line\nSecond line', 'Older one']))
    renderBrief()
    const brief = screen.getByRole('combobox', { name: 'Brief' })
    fireEvent.keyDown(brief, { key: 'ArrowUp' })
    await waitFor(() => expect(brief.textContent).toContain('Second line'))
    caretAt(brief, 'end')
    fireEvent.keyDown(brief, { key: 'ArrowUp' })
    expect(brief.textContent).toContain('Second line')
    caretAt(brief, 'start')
    fireEvent.keyDown(brief, { key: 'ArrowUp' })
    await waitFor(() => expect(brief.textContent).toBe('Older one'))
  })
})
