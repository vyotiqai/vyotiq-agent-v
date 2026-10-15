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

  it('new task in the workspace main found', async () => {
    const inWs = vi.fn()
    expect((await executeWindowAction(act('new_task', {}, { workspacePath: 'C:/work/site' }), handlers({ onNewChatInWorkspace: inWs }))).ok).toBe(true)
    expect(inWs).toHaveBeenCalledWith('C:/work/site')
  })
})
