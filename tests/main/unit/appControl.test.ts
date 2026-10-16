/**
 * The app's actions (batch 3, docs/voice-mode.md §24.15): one catalog the
 * voice's app_action and the agent's app_control share, run in main or sent
 * to the window. The voice had three tools and the agent none for the app:
 * "switch to dark mode" went to the coding agent, which edited the project.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import {
  APP_ACTIONS,
  APP_ACTION_NAMES,
  describeAppActions,
  isDestructiveAppControl,
  parseAppActionArgs,
  type AppWindowAction
} from '@shared/appActions'
import { contextAtHome, expandPathVars, findTask, findWorkspace, runAppAction, settleWindowAction, type AppControlDeps } from '@main/appControl/runner'
import { isApprovalExemptTool } from '@main/agent/tools/classify'
import { resetSettingsSetForTests, settingsChangedSince } from '@main/appControl/setByAgent'
import { describeApproval } from '@main/voice/session'
import { summarizeToolArgs } from '@shared/utils/toolSummary'

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
    runActive: (id) => id === 'r1',
    startTask: () => ({ ok: true, runId: 'new-run' }),
    sendToTask: async (_path, runId) => ({ ok: true, queued: runId === 'r1' }),
    patchSettings: async (p) => {
      patches.push(p)
    },
    settings: () => ({ recentModels: ['openrouter::anthropic/claude-haiku-5.5', 'openrouter::z-ai/glm-5.3-flash'] }),
    status: async () => '(The app right now…)',
    openPath: async () => '',
    revealPath: () => {},
    openExternal: async () => {},
    quit: () => {},
    ...over,
    patches
  } as AppControlDeps & { patches: Array<Record<string, unknown>> }
}

const voice = { runId: 'r1', workspacePath: 'C:/work/api' }

describe('the catalog', () => {
  it('the agent has every action, voice mode’s own too (voice mode is the agent, §27); destructive ones say they need a yes', () => {
    expect(APP_ACTION_NAMES).toContain('voice_mute')
    expect(APP_ACTION_NAMES).toContain('set_task_model')
    expect(APP_ACTION_NAMES).toContain('app_status')
    expect(describeAppActions()).toContain('delete_task {task?}: Delete a task (it goes to Recently deleted). The app asks the user for a yes when you call it: call it without asking first.')
    expect(describeAppActions()).toContain('start_task {brief, workspace?}')
    expect(describeAppActions()).toContain('set_task_model {model, task?}')
    expect(Object.entries(APP_ACTIONS).filter(([, d]) => d.destructive).map(([n]) => n).sort()).toEqual(['delete_task', 'install_update', 'quit_app'])
  })

  it('arguments are checked', () => {
    expect(parseAppActionArgs('set_theme', { theme: 'dark' })).toEqual({ ok: true, args: { theme: 'dark' } })
    expect(parseAppActionArgs('set_theme', { theme: 'purple' }).ok).toBe(false)
    expect(parseAppActionArgs('set_voice_speed', { speed: 9 }).ok).toBe(false)
  })

  it('a wrong argument is said in words, and fixed choices are listed for the model (2026-10-15 live check)', () => {
    // The voice read out "voice_mute: until Invalid option: expected one of…" after guessing a value.
    expect(parseAppActionArgs('voice_mute', { until: 'I call you' })).toEqual({ ok: false, error: 'I couldn’t do that: until has to be called or unmuted.' })
    expect(parseAppActionArgs('set_voice_speed', { speed: 9 })).toEqual({ ok: false, error: 'I couldn’t do that: the speed didn’t fit.' })
    expect(describeAppActions()).toContain('voice_mute {until?: called|unmuted}')
    expect(describeAppActions()).toContain('set_theme {theme: system|light|dark}')
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
    // Said in full: "New tasks use…" was taken to mean the task on screen too (2026-10-16 03:04).
    expect(await runAppAction(d, 'set_model', { model: 'haiku' }, voice)).toEqual({
      ok: true,
      message: 'New tasks start on anthropic/claude-haiku-5.5. Tasks that exist keep their own model.'
    })
    expect(d.patches).toEqual([{ theme: 'light' }, { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' }])
    expect((await runAppAction(d, 'set_model', { model: 'gpt nine' }, voice)).ok).toBe(false)
  })

  it('a stop cancels the named run; one that isn’t running says so', async () => {
    const cancel = vi.fn((id: string) => id === 'r1')
    const d = deps({ cancelRun: cancel })
    expect(await runAppAction(d, 'stop_task', {}, voice)).toEqual({ ok: true, message: 'Stopped “Run the tests”.', runId: 'r1' })
    expect(await runAppAction(d, 'stop_task', { task: 'login' }, voice)).toEqual({ ok: false, message: '“Fix the login page” isn’t running.' })
  })

  it('a title’s own full stop isn’t doubled by the sentence it sits in', async () => {
    const d = deps({ listTasks: async () => [{ runId: 'r1', title: 'Say hello in one line.', status: 'running' }] })
    expect((await runAppAction(d, 'stop_task', {}, voice)).message).toBe('Stopped “Say hello in one line”.')
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

  it('more work for a task: queued on a running one, a stopped one goes again and is opened (§24.16)', async () => {
    const w = fakeWindow()
    const send = vi.fn(async (_path: string, runId: string) => ({ ok: true as const, queued: runId === 'r1' }))
    const d = deps({ window: () => w.wc, sendToTask: send })
    // The task on screen, running: queued, and nothing to open.
    expect(await runAppAction(d, 'send_to_task', { message: 'Also run the lint.' }, voice)).toEqual({
      ok: true,
      message: 'Added to “Run the tests”; it gets it at its next step.',
      runId: 'r1'
    })
    expect(send).toHaveBeenLastCalledWith('C:/work/api', 'r1', expect.objectContaining({ role: 'user', content: 'Also run the lint.' }), w.wc)
    expect(w.sent).toEqual([])
    // Another workspace's finished task: it goes again, and it's shown.
    expect(await runAppAction(d, 'send_to_task', { task: 'release notes', message: 'Add the voice changes.' }, voice)).toEqual({
      ok: true,
      message: '“Write the release notes” is on it.',
      runId: 'r3'
    })
    expect(w.sent[0]).toMatchObject({ name: 'open_task', resolved: { workspacePath: 'C:/work/site', runId: 'r3' } })
    expect(await runAppAction(deps({ sendToTask: async () => ({ ok: false, error: 'An imported task is read-only. Fork it to continue.' }) }), 'send_to_task', { message: 'Go on.' }, voice)).toEqual({
      ok: false,
      message: 'An imported task is read-only. Fork it to continue.'
    })
  })

  it('a rename goes to the window with the task found, never while it runs (§24.16)', async () => {
    const w = fakeWindow(() => ({ ok: true, message: 'Renamed {task} to “Login fix”.' }))
    const d = deps({ window: () => w.wc })
    expect(await runAppAction(d, 'rename_task', { title: 'Tests' }, voice)).toEqual({
      ok: false,
      message: '“Run the tests” is running; it can be renamed once it stops.'
    })
    expect(w.sent).toEqual([])
    expect(await runAppAction(d, 'rename_task', { task: 'login page', title: 'Login fix' }, voice)).toEqual({
      ok: true,
      message: 'Renamed “Fix the login page” to “Login fix”.',
      runId: 'r2'
    })
    expect(w.sent[0]).toMatchObject({ name: 'rename_task', args: { title: 'Login fix' }, resolved: { workspacePath: 'C:/work/api', runId: 'r2' } })
  })

  it('a fork goes to the window with the task found, never while it runs (main forks only a stopped task)', async () => {
    const w = fakeWindow(() => ({ ok: true, message: 'Forked {task}; the copy is open.' }))
    const d = deps({ window: () => w.wc })
    expect(await runAppAction(d, 'fork_task', { task: 'tests' }, voice)).toEqual({
      ok: false,
      message: '“Run the tests” is running; it can be forked once it stops.'
    })
    expect(w.sent).toEqual([])
    expect(await runAppAction(d, 'fork_task', { task: 'login page' }, voice)).toEqual({
      ok: true,
      message: 'Forked “Fix the login page”; the copy is open.',
      runId: 'r2'
    })
    expect(w.sent[0]).toMatchObject({ name: 'fork_task', resolved: { workspacePath: 'C:/work/api', runId: 'r2' } })
  })

  it('a palette command goes to the window as it is; one it doesn’t have is refused in words', async () => {
    const w = fakeWindow(() => ({ ok: true, message: 'Find is open; type what to look for.' }))
    const d = deps({ window: () => w.wc })
    expect(await runAppAction(d, 'run_command', { command: 'find' }, voice)).toMatchObject({ ok: true, message: 'Find is open; type what to look for.' })
    expect(w.sent[0]).toMatchObject({ name: 'run_command', args: { command: 'find' } })
    const wrong = await runAppAction(d, 'run_command', { command: 'format_disk' }, voice)
    expect(wrong.ok).toBe(false)
    expect(wrong.message).toContain('command has to be split_pane or close_pane')
    expect(w.sent).toHaveLength(1)
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
    // The path as the agent wrote it (run fb8b6636): %VAR% and $env:VAR are read as a shell would.
    vi.stubEnv('VY_TEST_LOGS', dir)
    expect(await runAppAction(d, 'open_path', { path: '%VY_TEST_LOGS%\\notes.md' }, at)).toEqual({ ok: true, message: 'Opened notes.md.' })
    expect((await runAppAction(d, 'open_path', { path: '$env:VY_TEST_LOGS/notes.md' }, at)).ok).toBe(true)
    vi.unstubAllEnvs()
    expect(expandPathVars('%NOT_A_VAR_HERE%\\x.log', {})).toBe('%NOT_A_VAR_HERE%\\x.log')
    expect(expandPathVars('~/x.log', {}, 'C:/Users/me')).toBe('C:/Users/me/x.log')
    expect(expandPathVars('~\\x.log', {}, 'C:\\Users\\me')).toBe('C:\\Users\\me\\x.log')
    expect(expandPathVars('~other/x.log', {}, 'C:/Users/me')).toBe('~other/x.log')
    expect(expandPathVars('%appdata%\\vyotiq', { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' })).toBe('C:\\Users\\me\\AppData\\Roaming\\vyotiq')
    opened.splice(0)
    expect((await runAppAction(d, 'open_url', { url: 'file:///C:/Windows/system32/calc.exe' }, at)).ok).toBe(false)
    expect(await runAppAction(d, 'open_url', { url: 'https://example.com/docs' }, at)).toEqual({ ok: true, message: 'Opened example.com.' })
    expect(urls).toEqual(['https://example.com/docs'])
  })

  it('an agent in a worktree opens files from the worktree, its task found in the workspace', async () => {
    const tree = mkdtempSync(join(tmpdir(), 'vyotiq-app-tree-'))
    dirs.push(tree)
    writeFileSync(join(tree, 'only-here.md'), 'x')
    const opened: string[] = []
    const d = deps({
      openPath: async (p) => {
        opened.push(p)
        return ''
      }
    })
    // The loop hands the agent its worktree; the registry knows the workspace the task lives in.
    const at = contextAtHome({ runId: 'r1', workspacePath: tree }, 'C:/work/api')
    expect(at).toMatchObject({ workspacePath: 'C:/work/api', filesRoot: tree })
    expect((await runAppAction(d, 'open_path', { path: 'only-here.md' }, at)).ok).toBe(true)
    expect(opened).toEqual([join(tree, 'only-here.md')])
    // "Stop this task" with no name is the agent's own, found in its workspace.
    expect(await findTask(d, undefined, at)).toEqual({ runId: 'r1', workspacePath: 'C:/work/api', title: 'Run the tests' })
    // Not in a worktree: nothing changes.
    const plain = { runId: 'r1', workspacePath: 'C:/work/api' }
    expect(contextAtHome(plain, 'C:/work/api')).toBe(plain)
  })

  it('voice mode’s own controls reach the session following the agent’s run, and say so when voice mode is off', async () => {
    const mute = vi.fn()
    const end = vi.fn()
    const controls = { mute, end, setVoice: async () => ({ ok: true, message: '' }) }
    const off = deps()
    expect(await runAppAction(off, 'voice_end', {}, voice)).toEqual({ ok: false, message: 'Voice mode isn’t on.' })
    const on = deps({ voiceControls: (runId) => (runId === 'r1' ? controls : null) })
    const r = await runAppAction(on, 'voice_mute', {}, voice)
    expect(r).toEqual({ ok: true, message: 'Muted until called: saying “Agent V” wakes it.' })
    expect(mute).toHaveBeenCalledWith(true)
    expect(await runAppAction(on, 'voice_mute', { until: 'unmuted' }, voice)).toEqual({ ok: true, message: 'Muted until unmuted.' })
    expect(mute).toHaveBeenLastCalledWith(false)
    expect((await runAppAction(on, 'voice_end', {}, voice)).ok).toBe(true)
    expect(end).toHaveBeenCalled()
    expect(await runAppAction(on, 'voice_end', {}, { runId: 'r9', workspacePath: 'C:/work/api' })).toEqual({ ok: false, message: 'Voice mode isn’t on.' })
    expect(await runAppAction(on, 'nonsense', {}, voice)).toEqual({ ok: false, message: 'There’s no action called nonsense.' })
  })

  it('a speed the speaking model refuses is saved, and said not to take', async () => {
    const takes = deps()
    expect(await runAppAction(takes, 'set_voice_speed', { speed: 1.25 }, voice)).toEqual({ ok: true, message: 'The voice speaks at 1.25 times speed now.' })
    const refuses = deps({ speedIgnored: () => true })
    const r = await runAppAction(refuses, 'set_voice_speed', { speed: 1.25 }, voice)
    expect(r.ok).toBe(false)
    expect(r.message).toContain('can’t change its speed')
    expect(refuses.patches).toEqual([{ voice: { speed: 1.25 } }])
  })

  it('sets the rest of Settings, Voice (2026-10-16 kept conversation: "Orb to cloud" had nothing to call)', async () => {
    const settings: Record<string, unknown> = { voice: { placement: 'capsule' } }
    const d = deps({ settings: () => settings })
    expect(await runAppAction(d, 'set_voice_options', { look: 'cloud' }, voice)).toEqual({ ok: true, message: 'Set: the orb is cloud.' })
    // Only what changed: the rest of voice is kept at the write (2026-10-16 audit, L6).
    expect(d.patches).toEqual([{ voice: { orbLook: 'cloud' } }])
    expect(await runAppAction(d, 'set_voice_options', { style: 'ambient', captions: false, sounds: false, progress: true, hold_to_talk: true, patience: 'patient', layout: 'orb' }, voice)).toEqual({
      ok: true,
      message:
        'Set: the style is ambient, the layout is orb, it waits longer before you’re done, captions are off, sounds are off, progress is spoken, it listens only while you hold to talk.'
    })
    expect(d.patches[1]).toEqual({
      voice: { style: 'ambient', viewLayout: 'orb', endOfTurnPatience: 'patient', captions: false, earcons: false, speakProgress: true, pushToTalkOnly: true }
    })
    expect(await runAppAction(d, 'set_voice_options', {}, voice)).toEqual({ ok: false, message: 'I couldn’t do that: no voice option was named.' })
    expect(await runAppAction(d, 'set_voice_options', { look: 'smoke' }, voice)).toMatchObject({ ok: false, message: expect.stringContaining('look has to be sphere or glow') })
    expect(describeAppActions()).toContain('set_voice_options {look?: sphere|glow|pearl|aura|wire|cloud')
    // "Listen in Hindi" had nothing to call; detect is the empty language Settings stores.
    expect(await runAppAction(d, 'set_voice_options', { language: 'HI' }, voice)).toEqual({ ok: true, message: 'Set: it listens for language hi.' })
    expect(d.patches.at(-1)).toEqual({ voice: { language: 'hi' } })
    expect(await runAppAction(d, 'set_voice_options', { language: 'detect' }, voice)).toEqual({ ok: true, message: 'Set: it detects the language.' })
    expect(d.patches.at(-1)).toEqual({ voice: { language: '' } })
    expect(await runAppAction(d, 'set_voice_options', { language: 'Hindi' }, voice)).toMatchObject({ ok: false, message: 'I couldn’t do that: the language didn’t fit.' })
  })

  it('a destructive action’s approval says what it would do, on the card and out loud', () => {
    // Was empty on the card and "can I do that in the app?" out loud, for delete_task, quit_app and install_update.
    const ask = (a: object): string => describeApproval({ name: 'app_control', summary: summarizeToolArgs('app_control', JSON.stringify(a)) })
    expect(summarizeToolArgs('app_control', JSON.stringify({ action: 'delete_task', args: { task: 'the login page' } }))).toBe('delete_task: the login page')
    expect(ask({ action: 'delete_task', args: { task: 'the login page' } })).toBe('delete the task “the login page”')
    expect(ask({ action: 'delete_task', args: {} })).toBe('delete the task on screen')
    expect(ask({ action: 'quit_app', args: {} })).toBe('quit Agent V')
    expect(ask({ action: 'install_update' })).toBe('install the update and restart the app')
    expect(ask({ action: 'set_theme', args: { theme: 'dark' } })).toBe('set theme dark')
    expect(ask({})).toBe('do that in the app')
  })

  it('quit in voice mode waits for the spoken reply; without voice it waits 1.5 s', async () => {
    const quit = vi.fn()
    let after: (() => void) | null = null
    const withVoice = { ...voice, voice: { mute: () => {}, end: () => {}, setVoice: async () => ({ ok: true, message: '' }), afterReply: (runId: string, fn: () => void) => runId === 'r1' && Boolean((after = fn)) } }
    expect(await runAppAction(deps({ quit }), 'quit_app', {}, withVoice)).toMatchObject({ ok: true, message: expect.stringContaining('the app stays open until then') })
    expect(quit).not.toHaveBeenCalled()
    after!()
    expect(quit).toHaveBeenCalledTimes(1)
    vi.useFakeTimers()
    try {
      const quit2 = vi.fn()
      // A voice that follows another run: not waited on.
      await runAppAction(deps({ quit: quit2 }), 'quit_app', {}, { ...withVoice, runId: 'r2' })
      vi.advanceTimersByTime(1499)
      expect(quit2).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1)
      expect(quit2).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('the docs’ table of actions names every action in the catalog', () => {
    // It had fallen seven behind (set_voice_options, set_task_model, fork_task, run_command, app_status, check_update, download_update).
    const doc = readFileSync(join(__dirname, '../../../docs/voice-mode.md'), 'utf8').replace(/\r\n/g, '\n')
    const table = doc.slice(doc.indexOf('| Group | Actions | Runs in |'))
    const rows = table.slice(0, table.indexOf('\n\n'))
    expect(APP_ACTION_NAMES.filter((n) => !rows.includes(`\`${n}\``))).toEqual([])
  })

  it('remembers what a run set, so a change made since by someone else is told apart (2026-10-16 probe: it set cloud back twice)', async () => {
    resetSettingsSetForTests()
    let store: Record<string, unknown> = { theme: 'dark', voice: { placement: 'capsule', orbLook: 'wire' } }
    const d = deps({
      settings: () => store,
      patchSettings: async (p) => {
        store = { ...store, ...p }
      }
    })
    await runAppAction(d, 'set_voice_options', { look: 'cloud' }, voice)
    expect(settingsChangedSince('r1', store)).toEqual([])
    // Changed the way the person would, in Settings.
    store = { ...store, voice: { ...(store.voice as object), orbLook: 'pearl' } }
    expect(settingsChangedSince('r1', store)).toEqual([{ what: 'the orb', set: 'cloud', now: 'pearl' }])
    // Another run set nothing; what it didn't touch isn't reported, nor is the theme nobody set.
    expect(settingsChangedSince('r9', store)).toEqual([])
    store = { ...store, theme: 'light' }
    expect(settingsChangedSince('r1', store)).toHaveLength(1)
    // Set again by this run: nothing to tell.
    await runAppAction(d, 'set_voice_options', { look: 'pearl' }, voice)
    expect(settingsChangedSince('r1', store)).toEqual([])
  })

  it('checks for an update when asked, and says where it can’t (2026-10-16 probe: "I don’t have a way to run that check")', async () => {
    expect(await runAppAction(deps(), 'check_update', {}, voice)).toEqual({ ok: false, message: 'Updates are checked only in the installed app; this is a development build.' })
    expect(await runAppAction(deps({ checkUpdate: async () => ({ checked: true, version: '1.4.0' }) }), 'check_update', {}, voice)).toEqual({
      ok: true,
      message: 'Version 1.4.0 is out; it isn’t downloaded yet.'
    })
    expect((await runAppAction(deps({ checkUpdate: async () => ({ checked: true, version: null }) }), 'check_update', {}, voice)).message).toBe('No update: this is the newest version.')
    expect((await runAppAction(deps({ checkUpdate: async () => ({ checked: true, version: null, error: 'offline' }) }), 'check_update', {}, voice)).ok).toBe(false)
  })

  it('app_status answers from the app, never a guess', async () => {
    const status = vi.fn(async () => 'Update: none, this is the newest.')
    const d = deps({ status })
    expect(await runAppAction(d, 'app_status', {}, voice)).toEqual({ ok: true, message: 'Update: none, this is the newest.' })
    expect(status).toHaveBeenCalledWith(voice)
  })

  it('a task’s own model goes to the window with the task, and a running one says when it applies (2026-10-16 03:04)', async () => {
    const w = fakeWindow(() => ({ ok: true, message: 'Set.' }))
    const d = deps({ window: () => w.wc })
    expect(await runAppAction(d, 'set_task_model', { model: 'haiku' }, voice)).toEqual({
      ok: true,
      message: '“Run the tests” runs on anthropic/claude-haiku-5.5 from its next turn; the run working now finishes on the model it started with.',
      runId: 'r1'
    })
    expect(w.sent.at(-1)).toMatchObject({
      name: 'set_task_model',
      args: { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5' },
      resolved: { workspacePath: 'C:/work/api', runId: 'r1' }
    })
    expect(await runAppAction(d, 'set_task_model', { model: 'glm', task: 'login' }, voice)).toEqual({
      ok: true,
      message: '“Fix the login page” runs on z-ai/glm-5.3-flash.',
      runId: 'r2'
    })
    // Never the global model: that is set_model.
    expect(d.patches).toEqual([])
    expect((await runAppAction(d, 'set_task_model', { model: 'gpt nine' }, voice)).ok).toBe(false)
  })
})
