/** @vitest-environment jsdom */
/**
 * The window's side of the app's actions (docs/voice-mode.md §24.15): what
 * main sends, done as a click or the command palette would, answered in
 * words the voice can say.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppWindowAction } from '@shared/appActions'
import { OPEN_PANEL_EVENT, executeWindowAction, type WindowActionHandlers } from '@renderer/app/appActionExecutor'
import { SECTION_GROUPS } from '@renderer/features/settings/constants'
import { SETTINGS_SECTIONS } from '@shared/appActions'

it('the catalog names every Settings section, and only those', () => {
  expect([...SETTINGS_SECTIONS].sort()).toEqual(SECTION_GROUPS.flatMap((g) => g.sections).sort())
})

function handlers(over: Partial<WindowActionHandlers> = {}): WindowActionHandlers {
  return {
    workspaces: ['C:/work/api'],
    onOpenSettings: vi.fn(),
    onOpenHome: vi.fn(),
    onOpenUsage: vi.fn(),
    onNewTask: vi.fn(),
    onToggleNavigator: vi.fn(),
    onNextNeedsYou: vi.fn(),
    onSwitchWorkspaceByIndex: vi.fn(),
    onFocusInstructionLine: vi.fn(),
    onOpenSettingsField: vi.fn(),
    onOpenTask: vi.fn(),
    ...over
  }
}

const act = (name: string, args: Record<string, unknown> = {}, resolved?: AppWindowAction['resolved']): AppWindowAction => ({
  requestId: 'q',
  name,
  args,
  ...(resolved ? { resolved } : {})
})

afterEach(() => vi.restoreAllMocks())

describe('executeWindowAction', () => {
  it('shows a view as the palette would', async () => {
    const h = handlers()
    expect(await executeWindowAction(act('open_view', { view: 'home' }), h)).toEqual({ ok: true, message: 'Here’s Home.' })
    expect(h.onOpenHome).toHaveBeenCalledOnce()
    const section = vi.fn()
    expect(await executeWindowAction(act('open_settings', { section: 'voice' }), handlers({ onOpenSettingsSection: section }))).toMatchObject({ ok: true })
    expect(section).toHaveBeenCalledWith('voice')
  })

  it('opens a panel beside the task on screen, never toggles it, and says so when there is none', async () => {
    const opened: string[] = []
    const toggled: string[] = []
    const onOpen = (e: Event): void => {
      opened.push(String((e as CustomEvent<{ panel?: string }>).detail?.panel))
    }
    const onToggle = (e: Event): void => {
      toggled.push(String((e as CustomEvent<{ id?: string }>).detail?.id))
    }
    window.addEventListener(OPEN_PANEL_EVENT, onOpen)
    window.addEventListener('vyotiq:command', onToggle)
    try {
      expect(await executeWindowAction(act('open_panel', { panel: 'terminal' }), handlers({ inTaskView: () => true }))).toEqual({
        ok: true,
        message: 'The terminal panel is open.'
      })
      // The palette's panel command hides the panel on screen: asked twice, it would close.
      expect(opened).toEqual(['terminal'])
      expect(toggled).toEqual([])
      expect((await executeWindowAction(act('open_panel', { panel: 'files' }), handlers({ inTaskView: () => false }))).ok).toBe(false)
    } finally {
      window.removeEventListener(OPEN_PANEL_EVENT, onOpen)
      window.removeEventListener('vyotiq:command', onToggle)
    }
  })

  it('archives one way only: an archived task stays archived, and unarchive brings it back', async () => {
    const archive = vi.fn()
    const at = { workspacePath: 'C:/work/api', runId: 'r1' }
    expect(await executeWindowAction(act('archive_task', {}, at), handlers({ onToggleArchivedRun: archive, isArchived: () => true }))).toEqual({
      ok: true,
      message: '{task} is already archived.'
    })
    expect(archive).not.toHaveBeenCalled()
    expect(await executeWindowAction(act('archive_task', { unarchive: true }, at), handlers({ onToggleArchivedRun: archive, isArchived: () => true }))).toEqual({
      ok: true,
      message: 'Unarchived {task}.'
    })
    expect(archive).toHaveBeenCalledOnce()
    expect((await executeWindowAction(act('archive_task', { unarchive: true }, at), handlers({ onToggleArchivedRun: archive, isArchived: () => false }))).message).toBe(
      '{task} isn’t archived.'
    )
  })

  it('opens any Settings section, and plain Settings for a name it lacks', async () => {
    const section = vi.fn()
    const plain = vi.fn()
    await executeWindowAction(act('open_settings', { section: 'appearance' }), handlers({ onOpenSettingsSection: section, onOpenSettings: plain }))
    expect(section).toHaveBeenCalledWith('appearance')
    await executeWindowAction(act('open_settings', { section: 'nowhere' }), handlers({ onOpenSettingsSection: section, onOpenSettings: plain }))
    expect(plain).toHaveBeenCalledOnce()
  })

  it('opens, archives and deletes the task main found', async () => {
    const open = vi.fn()
    const archive = vi.fn()
    const del = vi.fn(async () => true)
    const h = handlers({ onOpenTask: open, onToggleArchivedRun: archive, isArchived: () => false, onDeleteRun: del })
    const at = { workspacePath: 'C:/work/api', runId: 'r1' }
    expect(await executeWindowAction(act('open_task', { task: 'tests' }, at), h)).toEqual({ ok: true, message: 'Here it is: {task}.' })
    expect(open).toHaveBeenCalledWith('C:/work/api', 'r1')
    expect(await executeWindowAction(act('archive_task', {}, at), h)).toEqual({ ok: true, message: 'Archived {task}.' })
    expect(archive).toHaveBeenCalledWith('C:/work/api', 'r1')
    expect((await executeWindowAction(act('delete_task', {}, at), h)).ok).toBe(true)
    expect((await executeWindowAction(act('delete_task', {}, at), handlers({ onDeleteRun: async () => false }))).ok).toBe(false)
  })

  it('renames the task main found; a refused rename says the screen has why (§24.16)', async () => {
    const onRenameRun = vi.fn(async () => true)
    const at = { workspacePath: 'C:/work/api', runId: 'r2' }
    expect(await executeWindowAction(act('rename_task', { title: 'Login fix' }, at), handlers({ onRenameRun }))).toEqual({
      ok: true,
      message: 'Renamed {task} to “Login fix”.'
    })
    expect(onRenameRun).toHaveBeenCalledWith('C:/work/api', 'r2', 'Login fix')
    expect(await executeWindowAction(act('rename_task', { title: 'Login fix' }, at), handlers({ onRenameRun: async () => false }))).toEqual({
      ok: false,
      message: 'It couldn’t be renamed; the screen says why.'
    })
  })

  it('forks the task main found; a refused fork says the screen has why', async () => {
    const onForkRun = vi.fn(async () => true)
    const at = { workspacePath: 'C:/work/api', runId: 'r2' }
    expect(await executeWindowAction(act('fork_task', {}, at), handlers({ onForkRun }))).toEqual({ ok: true, message: 'Forked {task}; the copy is open.' })
    expect(onForkRun).toHaveBeenCalledWith('C:/work/api', 'r2')
    expect(await executeWindowAction(act('fork_task', {}, at), handlers({ onForkRun: async () => false }))).toEqual({
      ok: false,
      message: 'It couldn’t be forked; the screen says why.'
    })
    expect((await executeWindowAction(act('fork_task'), handlers({ onForkRun }))).ok).toBe(false)
  })

  it('split and close say whether they happened', async () => {
    const cmd = (command: string, over: Partial<WindowActionHandlers>) => executeWindowAction(act('run_command', { command }), handlers(over))
    expect(await cmd('split_pane', { splitPane: () => true })).toMatchObject({ ok: true })
    expect(await cmd('split_pane', { splitPane: () => false })).toEqual({ ok: false, message: 'It couldn’t be split.' })
    expect(await cmd('close_pane', { closePane: () => true, inTaskView: () => true })).toEqual({ ok: true, message: 'Closed it; the task is still in the list.' })
    expect(await cmd('close_pane', { closePane: () => false, inTaskView: () => true })).toMatchObject({ ok: false })
    const closePane = vi.fn(() => true)
    expect(await cmd('close_pane', { closePane, inTaskView: () => false })).toMatchObject({ ok: false })
    expect(closePane).not.toHaveBeenCalled()
  })

  it('find and reasoning count only when a task pane takes them; reasoning is set as asked, not toggled', async () => {
    const seen: string[] = []
    const pane = (e: Event): void => {
      const detail = (e as CustomEvent<{ id?: string; handled?: boolean }>).detail
      seen.push(String(detail.id))
      detail.handled = true
    }
    const cmd = (command: string) => executeWindowAction(act('run_command', { command }), handlers({ inTaskView: () => true }))
    expect(await cmd('find')).toEqual({ ok: false, message: 'No task is on screen to search.' })
    window.addEventListener('vyotiq:command', pane)
    try {
      expect(await cmd('find')).toEqual({ ok: true, message: 'Find is open; type what to look for.' })
      expect(await cmd('show_reasoning')).toEqual({ ok: true, message: 'Reasoning is shown.' })
      expect(await cmd('hide_reasoning')).toEqual({ ok: true, message: 'Reasoning is hidden.' })
    } finally {
      window.removeEventListener('vyotiq:command', pane)
    }
    expect(seen).toEqual(['find', 'showReasoning', 'hideReasoning'])
  })

  it('pickers and the feedback form open when the app has them, and say so when not', async () => {
    const onAddWorkspace = vi.fn()
    const onImportTask = vi.fn()
    const onOpenFeedback = vi.fn()
    const cmd = (command: string, over: Partial<WindowActionHandlers>) => executeWindowAction(act('run_command', { command }), handlers(over))
    expect(await cmd('add_workspace', { onAddWorkspace })).toEqual({ ok: true, message: 'Pick the folder in the window that opened.' })
    expect(await cmd('import_task', { onImportTask, activeWorkspacePath: 'C:/work/api' })).toMatchObject({ ok: true })
    expect(await cmd('import_task', { onImportTask })).toMatchObject({ ok: false })
    expect(await cmd('send_feedback', { onOpenFeedback })).toEqual({ ok: true, message: 'The feedback form is open.' })
    expect(await cmd('send_feedback', {})).toMatchObject({ ok: false })
    expect(await cmd('add_workspace', {})).toMatchObject({ ok: false })
    expect([onAddWorkspace, onImportTask, onOpenFeedback].map((f) => f.mock.calls.length)).toEqual([1, 1, 1])
  })

  it('find in files opens beside a task; the workspace opens in the editor, and a failure says so', async () => {
    const found: string[] = []
    const onFind = (): void => {
      found.push('files')
    }
    window.addEventListener('vyotiq:find-in-files', onFind)
    try {
      const at = { inTaskView: () => true, activeWorkspacePath: 'C:/work/api' }
      expect(await executeWindowAction(act('run_command', { command: 'find_in_files' }), handlers(at))).toMatchObject({ ok: true })
      expect(await executeWindowAction(act('run_command', { command: 'find_in_files' }), handlers({ inTaskView: () => false }))).toMatchObject({ ok: false })
    } finally {
      window.removeEventListener('vyotiq:find-in-files', onFind)
    }
    expect(found).toEqual(['files'])
    const editorOpen = vi.fn(async (): Promise<{ ok: boolean; error?: string }> => ({ ok: true }))
    vi.stubGlobal('vyotiq', { editorOpen })
    try {
      const at = handlers({ activeWorkspacePath: 'C:/work/api' })
      expect(await executeWindowAction(act('run_command', { command: 'open_in_editor' }), at)).toEqual({ ok: true, message: 'api is opening in your editor.' })
      expect(editorOpen).toHaveBeenCalledWith({ workspacePath: 'C:/work/api' })
      editorOpen.mockResolvedValueOnce({ ok: false, error: 'No editor' })
      expect(await executeWindowAction(act('run_command', { command: 'open_in_editor' }), at)).toMatchObject({ ok: false })
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('sets Ask or Agent on the task on screen, or says there is none', async () => {
    const set = vi.fn(() => true)
    expect(await executeWindowAction(act('set_agent_mode', { mode: 'ask' }), handlers({ onSetAgentMode: set }))).toMatchObject({ ok: true })
    expect(set).toHaveBeenCalledWith('ask')
    expect((await executeWindowAction(act('set_agent_mode', { mode: 'agent' }), handlers({ onSetAgentMode: () => false }))).ok).toBe(false)
  })

  it('installs an update only once one is downloaded', async () => {
    expect(await executeWindowAction(act('install_update'), handlers({ updateReady: () => false }))).toEqual({ ok: false, message: 'No update is downloaded yet.' })
    expect(await executeWindowAction(act('install_update'), handlers({ updateReady: () => false, updateAvailable: () => true }))).toEqual({
      ok: false,
      message: 'The update isn’t downloaded yet.'
    })
  })

  it('downloads an update that is out, and says when there is none or it is already down', async () => {
    expect(await executeWindowAction(act('download_update'), handlers({ updateAvailable: () => false }))).toEqual({
      ok: false,
      message: 'There’s no update to download.'
    })
    expect((await executeWindowAction(act('download_update'), handlers({ updateReady: () => true }))).ok).toBe(true)
  })

  it('sets a task’s own model through its controller, as its model menu does (§27)', async () => {
    const set = vi.fn(() => true)
    const where = { workspacePath: 'C:/work/api', runId: 'r1' }
    expect(await executeWindowAction(act('set_task_model', { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }, where), handlers({ onSetTaskModel: set }))).toEqual({
      ok: true,
      message: 'Set.'
    })
    expect(set).toHaveBeenCalledWith('C:/work/api', 'r1', 'openrouter', 'anthropic/claude-haiku-5.5')
    expect((await executeWindowAction(act('set_task_model', { provider: 'openrouter', model: 'x' }, where), handlers({ onSetTaskModel: () => false }))).ok).toBe(false)
    expect((await executeWindowAction(act('set_task_model', { provider: 'openrouter', model: 'x' }), handlers({ onSetTaskModel: set }))).ok).toBe(false)
  })

  it('new task in the workspace main found', async () => {
    const inWs = vi.fn()
    expect((await executeWindowAction(act('new_task', {}, { workspacePath: 'C:/work/site' }), handlers({ onNewChatInWorkspace: inWs }))).ok).toBe(true)
    expect(inWs).toHaveBeenCalledWith('C:/work/site')
  })
})
