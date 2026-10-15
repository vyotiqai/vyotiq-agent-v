/** @vitest-environment jsdom */
/**
 * The window's side of the app's actions (docs/voice-mode.md §24.15): what
 * main sends, done as a click or the command palette would, answered in
 * words the voice can say.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppWindowAction } from '@shared/appActions'
import { executeWindowAction, type WindowActionHandlers } from '@renderer/app/appActionExecutor'

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

  it('opens a panel beside the task on screen, and says so when there is none', async () => {
    const seen: string[] = []
    const on = (e: Event): void => {
      seen.push(String((e as CustomEvent<{ id?: string }>).detail?.id))
    }
    window.addEventListener('vyotiq:command', on)
    try {
      expect(await executeWindowAction(act('open_panel', { panel: 'terminal' }), handlers({ inTaskView: () => true }))).toEqual({
        ok: true,
        message: 'The terminal panel is open.'
      })
      expect(seen).toEqual(['panelTerminal'])
      expect((await executeWindowAction(act('open_panel', { panel: 'files' }), handlers({ inTaskView: () => false }))).ok).toBe(false)
    } finally {
      window.removeEventListener('vyotiq:command', on)
    }
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

  it('sets Ask or Agent on the task on screen, or says there is none', async () => {
    const set = vi.fn(() => true)
    expect(await executeWindowAction(act('set_agent_mode', { mode: 'ask' }), handlers({ onSetAgentMode: set }))).toMatchObject({ ok: true })
    expect(set).toHaveBeenCalledWith('ask')
    expect((await executeWindowAction(act('set_agent_mode', { mode: 'agent' }), handlers({ onSetAgentMode: () => false }))).ok).toBe(false)
  })

  it('installs an update only once one is downloaded', async () => {
    expect(await executeWindowAction(act('install_update'), handlers({ updateReady: () => false }))).toEqual({ ok: false, message: 'No update is downloaded yet.' })
  })

  it('new task in the workspace main found', async () => {
    const inWs = vi.fn()
    expect((await executeWindowAction(act('new_task', {}, { workspacePath: 'C:/work/site' }), handlers({ onNewChatInWorkspace: inWs }))).ok).toBe(true)
    expect(inWs).toHaveBeenCalledWith('C:/work/site')
  })
})
