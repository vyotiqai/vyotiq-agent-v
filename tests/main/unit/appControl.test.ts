/**
 * The app's actions (batch 3, docs/voice-mode.md §24.15): one catalog the
 * voice's app_action and the agent's app_control share, run in main or sent
 * to the window. The voice had three tools and the agent none for the app:
 * "switch to dark mode" went to the coding agent, which edited the project.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  APP_ACTIONS,
  appActionsFor,
  describeAppActions,
  isDestructiveAppControl,
  parseAppActionArgs,
  type AppWindowAction
} from '@shared/appActions'
import { findTask, findWorkspace, runAppAction, settleWindowAction, type AppControlDeps } from '@main/appControl/runner'
import { isApprovalExemptTool } from '@main/agent/tools/classify'

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function fakeWindow(answer: (a: AppWindowAction) => { ok: boolean; message: string } | null = () => ({ ok: true, message: 'Done {task}.' })) {
  const sent: AppWindowAction[] = []
  const wc = {
    isDestroyed: () => false,
    send: (_channel: string, action: AppWindowAction) => {
      sent.push(action)
      const r = answer(action)
      if (r) queueMicrotask(() => settleWindowAction({ requestId: action.requestId, ...r }))
    }
  } as unknown as WebContents
  return { wc, sent }
}

function deps(over: Partial<AppControlDeps> = {}): AppControlDeps & { patches: Array<Record<string, unknown>> } {
  const patches: Array<Record<string, unknown>> = []
  const { wc } = fakeWindow()
  return {
    openWorkspaces: () => ['C:/work/api', 'C:/work/site'],
    activeWorkspace: () => 'C:/work/api',
    listTasks: async (path) =>
      path === 'C:/work/api'
        ? [
            { runId: 'r1', title: 'Run the tests', status: 'running' },
            { runId: 'r2', title: 'Fix the login page', status: 'done' }
          ]
        : [{ runId: 'r3', title: 'Write the release notes', status: 'done' }],
    window: () => wc,
    cancelRun: (id) => id === 'r1',
    startTask: () => ({ ok: true, runId: 'new-run' }),
    patchSettings: async (p) => {
      patches.push(p)
    },
    settings: () => ({ recentModels: ['openrouter::anthropic/claude-haiku-5.5', 'openrouter::z-ai/glm-5.3-flash'] }),
    openPath: async () => '',
    revealPath: () => {},
    openExternal: async () => {},
    quit: () => {},
    ...over,
    patches
  } as AppControlDeps & { patches: Array<Record<string, unknown>> }
}

const voice = { who: 'voice' as const, runId: 'r1', workspacePath: 'C:/work/api' }

describe('the catalog', () => {
  it('the agent never gets the voice’s own controls; destructive ones say they need a yes', () => {
    expect(appActionsFor('agent')).not.toContain('voice_mute')
    expect(appActionsFor('voice')).toContain('voice_mute')
    expect(describeAppActions('agent')).toContain('delete_task {task?}: Delete a task (it goes to Recently deleted). Needs the user’s yes first.')
    expect(describeAppActions('agent')).toContain('start_task {brief, workspace?}')
    expect(Object.entries(APP_ACTIONS).filter(([, d]) => d.destructive).map(([n]) => n).sort()).toEqual(['delete_task', 'install_update', 'quit_app'])
  })

  it('arguments are checked', () => {
    expect(parseAppActionArgs('set_theme', { theme: 'dark' })).toEqual({ ok: true, args: { theme: 'dark' } })
    expect(parseAppActionArgs('set_theme', { theme: 'purple' }).ok).toBe(false)
    expect(parseAppActionArgs('set_voice_speed', { speed: 9 }).ok).toBe(false)
  })

  it('the agent’s call: a destructive one always asks; the rest are like reads', () => {
    expect(isDestructiveAppControl({ action: 'delete_task', args: {} })).toBe(true)
    expect(isDestructiveAppControl({ action: 'open_view' })).toBe(false)
    expect(isApprovalExemptTool('app_control', { action: 'open_view', args: { view: 'home' } })).toBe(true)
    expect(isApprovalExemptTool('app_control', { action: 'quit_app' })).toBe(false)
  })
})

describe('finding what was named', () => {
  it('a task by words from its title, in any open workspace; the one on screen when unnamed', async () => {
    const d = deps()
    expect(await findTask(d, 'the login one', voice)).toEqual({ runId: 'r2', workspacePath: 'C:/work/api', title: 'Fix the login page' })
    expect(await findTask(d, 'release notes', voice)).toMatchObject({ runId: 'r3', workspacePath: 'C:/work/site' })
    expect(await findTask(d, undefined, voice)).toMatchObject({ runId: 'r1', title: 'Run the tests' })
    expect(await findTask(d, 'nothing like this', voice)).toBeNull()
  })

  it('a workspace by its folder name', () => {
    const d = deps()
    expect(findWorkspace(d, 'site', voice)).toBe('C:/work/site')
    expect(findWorkspace(d, undefined, voice)).toBe('C:/work/api')
    expect(findWorkspace(d, 'elsewhere', voice)).toBeNull()
  })
})

describe('running them', () => {
  it('settings are written in main', async () => {
    const d = deps()
    expect(await runAppAction(d, 'set_theme', { theme: 'light' }, voice)).toEqual({ ok: true, message: 'The theme is light now.' })
    expect(await runAppAction(d, 'set_model', { model: 'haiku' }, voice)).toEqual({ ok: true, message: 'New tasks use anthropic/claude-haiku-5.5.' })
    expect(d.patches).toEqual([{ theme: 'light' }, { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }])
    expect((await runAppAction(d, 'set_model', { model: 'gpt nine' }, voice)).ok).toBe(false)
  })

  it('a stop cancels the named run; one that isn’t running says so', async () => {
    const cancel = vi.fn((id: string) => id === 'r1')
    const d = deps({ cancelRun: cancel })
    expect(await runAppAction(d, 'stop_task', {}, voice)).toEqual({ ok: true, message: 'Stopped “Run the tests”.', runId: 'r1' })
    expect(await runAppAction(d, 'stop_task', { task: 'login' }, voice)).toEqual({ ok: false, message: '“Fix the login page” isn’t running.' })
  })

  it('a window action goes to the window with what main found, and comes back in its words', async () => {
    const w = fakeWindow()
    const d = deps({ window: () => w.wc })
    const r = await runAppAction(d, 'open_task', { task: 'release notes' }, voice)
    expect(r).toEqual({ ok: true, message: 'Done “Write the release notes”.', runId: 'r3' })
    expect(w.sent[0]).toMatchObject({ name: 'open_task', resolved: { workspacePath: 'C:/work/site', runId: 'r3' } })
  })

  it('a new task starts in the named workspace and is opened', async () => {
    const w = fakeWindow()
    const start = vi.fn(() => ({ ok: true as const, runId: 'new-run' }))
    const d = deps({ window: () => w.wc, startTask: start })
    expect(await runAppAction(d, 'start_task', { brief: 'Update the changelog', workspace: 'site' }, voice)).toEqual({
      ok: true,
      message: 'Started it in site.',
      runId: 'new-run'
    })
    expect(start).toHaveBeenCalledWith('C:/work/site', expect.objectContaining({ role: 'user', content: 'Update the changelog' }), w.wc)
    expect(w.sent[0]).toMatchObject({ name: 'open_task', resolved: { workspacePath: 'C:/work/site', runId: 'new-run' } })
  })

  it('a window that never answers fails, not hangs', async () => {
    vi.useFakeTimers()
    try {
      const w = fakeWindow(() => null)
      const pending = runAppAction(deps({ window: () => w.wc }), 'open_view', { view: 'home' }, voice)
      await vi.advanceTimersByTimeAsync(10_001)
      await expect(pending).resolves.toEqual({ ok: false, message: 'The window didn’t answer.' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens files and folders, never a program; web addresses only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-app-open-'))
    dirs.push(dir)
    writeFileSync(join(dir, 'notes.md'), 'x')
    writeFileSync(join(dir, 'setup.exe'), 'x')
    const opened: string[] = []
    const urls: string[] = []
    const d = deps({
      openPath: async (p) => {
        opened.push(p)
        return ''
      },
      openExternal: async (u) => {
        urls.push(u)
      }
    })
    const at = { ...voice, workspacePath: dir }
    expect(await runAppAction(d, 'open_path', { path: 'notes.md' }, at)).toEqual({ ok: true, message: 'Opened notes.md.' })
    expect((await runAppAction(d, 'open_path', { path: 'setup.exe' }, at)).message).toBe('setup.exe is a program; it isn’t opened from here.')
    expect((await runAppAction(d, 'open_path', { path: 'missing.txt' }, at)).ok).toBe(false)
    expect(opened).toEqual([join(dir, 'notes.md')])
    expect((await runAppAction(d, 'open_url', { url: 'file:///C:/Windows/system32/calc.exe' }, at)).ok).toBe(false)
    expect(await runAppAction(d, 'open_url', { url: 'https://example.com/docs' }, at)).toEqual({ ok: true, message: 'Opened example.com.' })
    expect(urls).toEqual(['https://example.com/docs'])
  })

  it('the voice’s own controls are the voice’s', async () => {
    const d = deps()
    expect(await runAppAction(d, 'voice_end', {}, { who: 'agent' })).toEqual({ ok: false, message: 'voice_end is the voice’s own control.' })
    const mute = vi.fn()
    const r = await runAppAction(d, 'voice_mute', { until: 'called' }, { ...voice, voice: { mute, end: () => {}, setVoice: async () => ({ ok: true, message: '' }) } })
    expect(r.message).toBe('Say “Agent V” when you need me.')
    expect(mute).toHaveBeenCalledWith(true)
    expect(await runAppAction(d, 'nonsense', {}, voice)).toEqual({ ok: false, message: 'There’s no action called nonsense.' })
  })
})
