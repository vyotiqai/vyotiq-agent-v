/**
 * Runs the app's actions (src/shared/appActions.ts) for the agent, typed or
 * talked to (voice mode is the agent, §27). Main's own run here; the window's
 * (views, panes, panels, the update) are sent to the window, which answers.
 * A task or workspace named in words is found here first, across every open
 * workspace.
 *
 * Confirmation is the approval card's (read out and answered by voice in
 * voice mode). This runs what it is given.
 */
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { basename, extname, isAbsolute, resolve } from 'path'
import type { WebContents } from 'electron'
import {
  isAppActionName,
  parseAppActionArgs,
  type AppActionArgs,
  type AppActionName,
  type AppWindowAction,
  type AppWindowActionResult
} from '../../shared/appActions'
import { workspacePathsEqual } from '../../shared/workspacePathMatch'
import { rememberSettingsSet } from './setByAgent'
import type { ChatMessage } from '../../shared/ipc'

export type AppActionResult = { ok: boolean; message: string; runId?: string }

/** What a run of an action knows about where it was asked. */
export type AppActionContext = {
  /** The agent's own run. */
  runId?: string | null
  workspacePath?: string | null
  /** Where a relative path is read from, when not the workspace: an agent's worktree. */
  filesRoot?: string | null
  /** Voice mode's own controls, when a voice session follows this run (found from `runId` when not given). */
  voice?: {
    mute: (untilCalled: boolean) => void
    end: () => void
    setVoice: (name: string) => Promise<AppActionResult>
  }
}

/**
 * An agent in its own worktree is handed that folder (the loop's
 * toolWorkspace), but its task lives in the workspace it was started in
 * (`home`, the run registry's): tasks and workspaces are found from there,
 * files still from the worktree it works in.
 */
export function contextAtHome(ctx: AppActionContext, home: string | undefined): AppActionContext {
  if (!home || !ctx.workspacePath || workspacePathsEqual(home, ctx.workspacePath)) return ctx
  return { ...ctx, workspacePath: home, filesRoot: ctx.workspacePath }
}

/** A task found from words: its run, its workspace, its title. */
export type FoundTask = { runId: string; workspacePath: string; title: string }

/** What the runner reads and does, so tests can stand in for the app. */
export type AppControlDeps = {
  openWorkspaces: () => string[]
  activeWorkspace: () => string | null
  /** A workspace's tasks, newest first. */
  listTasks: (workspacePath: string) => Promise<Array<{ runId: string; title: string; status: string }>>
  window: () => WebContents | null
  cancelRun: (runId: string) => boolean
  /** Running in this app now (a status file can say "running" long after). */
  runActive: (runId: string) => boolean
  startTask: (workspacePath: string, message: ChatMessage, wc: WebContents) => { ok: true; runId: string } | { ok: false; error: string }
  /** More work for a task: queued on a running one, else it runs again with the message. */
  sendToTask: (
    workspacePath: string,
    runId: string,
    message: ChatMessage,
    wc: WebContents
  ) => Promise<{ ok: true; queued: boolean } | { ok: false; error: string }>
  patchSettings: (patch: Record<string, unknown>) => Promise<void>
  settings: () => { recentModels?: string[]; favoriteModels?: string[] }
  /** The app as it is now, in words (app_status). */
  status: (ctx: AppActionContext) => Promise<string>
  /** Voice mode's controls for the session following this run, if one does. */
  voiceControls?: (runId: string) => AppActionContext['voice'] | null
  /** The speaking model in use ignores a speed (it refuses one; §24.12). */
  speedIgnored?: () => boolean
  /** Check for an update now; `checked` false where the app can't (a development build). */
  checkUpdate?: () => Promise<{ checked: false } | { checked: true; version: string | null; error?: string }>
  openPath: (path: string) => Promise<string>
  revealPath: (path: string) => void
  openExternal: (url: string) => Promise<void>
  quit: () => void
}

/** How long the window has to answer an action. */
export const WINDOW_ACTION_MS = 10_000

/** Files opened with the system's app must not be programs: a voice can't be talked into running one. */
const PROGRAM_EXT = new Set([
  '.exe', '.com', '.bat', '.cmd', '.ps1', '.psm1', '.vbs', '.vbe', '.js', '.jse', '.wsf', '.wsh', '.msi', '.msp', '.scr',
  '.lnk', '.reg', '.jar', '.sh', '.command', '.app', '.cpl', '.hta', '.pif', '.appref-ms'
])

/** `%APPDATA%`, `$env:APPDATA` and a leading `~` in a path, as a shell would read them; an unknown name is left as written. */
export function expandPathVars(path: string, env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  const named = (name: string): string | undefined => {
    const key = Object.keys(env).find((k) => k.toLowerCase() === name.toLowerCase())
    return key ? env[key] : undefined
  }
  return path
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name: string) => named(name) ?? whole)
    .replace(/\$env:([A-Za-z_][A-Za-z0-9_]*)/gi, (whole, name: string) => named(name) ?? whole)
    .replace(/^~(?=$|[\\/])/, home)
}

const pending = new Map<string, (r: AppWindowActionResult) => void>()

/** The window answered an action. */
export function settleWindowAction(result: AppWindowActionResult): void {
  const done = pending.get(result.requestId)
  if (!done) return
  pending.delete(result.requestId)
  done(result)
}

let channel = 'app:action'
/** The channel the window listens on (set by the IPC layer). */
export function setWindowActionChannel(name: string): void {
  channel = name
}

function sendToWindow(wc: WebContents, action: Omit<AppWindowAction, 'requestId'>): Promise<AppActionResult> {
  const requestId = randomUUID()
  return new Promise((done) => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      done({ ok: false, message: 'The window didn’t answer.' })
    }, WINDOW_ACTION_MS)
    pending.set(requestId, (r) => {
      clearTimeout(timer)
      done({ ok: r.ok, message: r.message })
    })
    try {
      wc.send(channel, { requestId, ...action } satisfies AppWindowAction)
    } catch {
      clearTimeout(timer)
      pending.delete(requestId)
      done({ ok: false, message: 'The window isn’t there.' })
    }
  })
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
}
const STOPWORDS = new Set(['the', 'task', 'one', 'that', 'this', 'about', 'with', 'for', 'and', 'my', 'a', 'an', 'to', 'of', 'in', 'on'])

/** An open workspace from words (its folder name), or the one in front. */
export function findWorkspace(deps: AppControlDeps, named: string | undefined, ctx: AppActionContext): string | null {
  const open = deps.openWorkspaces()
  if (!named?.trim()) return ctx.workspacePath ?? deps.activeWorkspace() ?? open[0] ?? null
  const exact = open.find((p) => workspacePathsEqual(p, named))
  if (exact) return exact
  const want = named.trim().toLowerCase()
  const byName = open.filter((p) => basename(p).toLowerCase() === want)
  if (byName.length > 0) return byName[0]!
  const asked = words(named)
  return open.find((p) => asked.length > 0 && asked.every((w) => basename(p).toLowerCase().includes(w))) ?? null
}

/**
 * A task from words: its run id, or the most recent whose title has every
 * word. Empty is the task on screen.
 */
export async function findTask(deps: AppControlDeps, named: string | undefined, ctx: AppActionContext): Promise<FoundTask | null> {
  const open = deps.openWorkspaces()
  const asked = named?.trim() ?? ''
  if (!asked) {
    if (!ctx.runId) return null
    const path = ctx.workspacePath ?? deps.activeWorkspace()
    if (!path) return null
    const task = (await deps.listTasks(path)).find((t) => t.runId === ctx.runId)
    return { runId: ctx.runId, workspacePath: path, title: task?.title ?? '' }
  }
  // Ones in front first: "the tests task" most likely means this workspace's.
  const here = ctx.workspacePath ?? deps.activeWorkspace()
  const order = here ? [here, ...open.filter((p) => !workspacePathsEqual(p, here))] : open
  const want = words(asked)
  for (const path of order) {
    const tasks = await deps.listTasks(path)
    const byId = tasks.find((t) => t.runId === asked)
    if (byId) return { runId: byId.runId, workspacePath: path, title: byId.title }
    const hit = want.length > 0 ? tasks.find((t) => want.every((w) => t.title.toLowerCase().includes(w))) : undefined
    if (hit) return { runId: hit.runId, workspacePath: path, title: hit.title }
  }
  return null
}

const NOT_A_KNOWN_MODEL = 'That model isn’t one used recently or marked favourite; pick it once in the model menu and it can be named after that.'

/** A model named in words, from the ones used recently or marked favourite. */
function knownModel(deps: AppControlDeps, named: string): { provider: string; model: string } | null {
  const s = deps.settings()
  const known = [...new Set([...(s.favoriteModels ?? []), ...(s.recentModels ?? [])])]
  const want = words(named)
  const key = known.find((k) => k.split('::')[1] === named) ?? known.find((k) => want.length > 0 && want.every((w) => k.toLowerCase().includes(w)))
  const [provider, model] = key?.split('::') ?? []
  return provider && model ? { provider, model } : null
}

/** Voice mode's controls: given, or the session following this run. */
function voiceOf(deps: AppControlDeps, ctx: AppActionContext): AppActionContext['voice'] | null {
  return ctx.voice ?? (ctx.runId ? (deps.voiceControls?.(ctx.runId) ?? null) : null)
}

function quoted(title: string): string {
  // A title's own full stop goes: the sentence it sits in ends with one ("Archived “Say hello.”." in the 2026-10-15 live check).
  const t = title.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return t ? `“${t.length > 60 ? `${t.slice(0, 59)}…` : t}”` : 'the task'
}

/** Run one action. Arguments are checked here; the name must be one the caller may use. */
export async function runAppAction(deps: AppControlDeps, name: string, rawArgs: unknown, ctx: AppActionContext): Promise<AppActionResult> {
  if (!isAppActionName(name)) return { ok: false, message: `There’s no action called ${name}.` }
  const parsed = parseAppActionArgs(name, rawArgs)
  if (!parsed.ok) return { ok: false, message: parsed.error }
  try {
    return await run(deps, name, parsed.args, ctx)
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message.slice(0, 300) : 'It failed.' }
  }
}

async function run(deps: AppControlDeps, name: AppActionName, args: AppActionArgs, ctx: AppActionContext): Promise<AppActionResult> {
  const a = args as Record<string, unknown>
  // What this run sets is remembered, so app_status can say when it was changed since by someone else.
  // `meant`: what the action set, when the patch carries more (a whole voice object).
  const patchSettings = async (patch: Record<string, unknown>, meant: Record<string, unknown> = patch): Promise<void> => {
    await deps.patchSettings(patch)
    rememberSettingsSet(ctx.runId, meant, deps.settings())
  }
  const window = (): WebContents | null => {
    const wc = deps.window()
    return wc && !wc.isDestroyed() ? wc : null
  }
  const toWindow = async (resolved?: AppWindowAction['resolved']): Promise<AppActionResult> => {
    const wc = window()
    if (!wc) return { ok: false, message: 'No app window is open.' }
    return sendToWindow(wc, { name, args: a, ...(resolved ? { resolved } : {}) })
  }
  const task = async (): Promise<FoundTask | { error: string }> => {
    const named = typeof a.task === 'string' ? a.task : undefined
    const found = await findTask(deps, named, ctx)
    if (found) return found
    return { error: named?.trim() ? `No task matches “${named.trim()}”.` : 'No task is on screen.' }
  }

  switch (name) {
    case 'open_task':
    case 'archive_task':
    case 'delete_task':
    case 'rename_task':
    case 'fork_task': {
      const found = await task()
      if ('error' in found) return { ok: false, message: found.error }
      // Main renames and forks only a stopped task; said here, not as the screen's toast.
      if ((name === 'rename_task' || name === 'fork_task') && deps.runActive(found.runId)) {
        return { ok: false, message: `${quoted(found.title)} is running; it can be ${name === 'fork_task' ? 'forked' : 'renamed'} once it stops.` }
      }
      const r = await toWindow({ workspacePath: found.workspacePath, runId: found.runId })
      return r.ok ? { ...r, message: r.message.replace('{task}', quoted(found.title)), runId: found.runId } : r
    }
    case 'set_task_model': {
      const key = knownModel(deps, String(a.model))
      if (!key) return { ok: false, message: NOT_A_KNOWN_MODEL }
      const found = await task()
      if ('error' in found) return { ok: false, message: found.error }
      const wc = window()
      if (!wc) return { ok: false, message: 'No app window is open.' }
      const r = await sendToWindow(wc, {
        name,
        args: { provider: key.provider, model: key.model },
        resolved: { workspacePath: found.workspacePath, runId: found.runId }
      })
      if (!r.ok) return r
      const later = deps.runActive(found.runId) ? ' from its next turn; the run working now finishes on the model it started with' : ''
      return { ok: true, message: `${quoted(found.title)} runs on ${key.model}${later}.`, runId: found.runId }
    }
    case 'app_status':
      return { ok: true, message: await deps.status(ctx) }
    case 'check_update': {
      const r = deps.checkUpdate ? await deps.checkUpdate() : ({ checked: false } as const)
      if (!r.checked) return { ok: false, message: 'Updates are checked only in the installed app; this is a development build.' }
      if (r.error) return { ok: false, message: `The update check failed: ${r.error.slice(0, 200)}` }
      return r.version ? { ok: true, message: `Version ${r.version} is out; it isn’t downloaded yet.` } : { ok: true, message: 'No update: this is the newest version.' }
    }
    case 'new_task':
    case 'switch_workspace': {
      const named = typeof a.workspace === 'string' ? a.workspace : undefined
      const path = findWorkspace(deps, named, ctx)
      if (!path) return { ok: false, message: `No open workspace is called “${named ?? ''}”.` }
      return toWindow({ workspacePath: path })
    }
    case 'start_task': {
      const named = typeof a.workspace === 'string' ? a.workspace : undefined
      const path = findWorkspace(deps, named, ctx)
      if (!path) return { ok: false, message: named ? `No open workspace is called “${named}”.` : 'No workspace is open.' }
      const wc = window()
      if (!wc) return { ok: false, message: 'No app window is open.' }
      const brief = String(a.brief)
      const started = deps.startTask(path, { role: 'user', content: brief, at: new Date().toISOString() }, wc)
      if (!started.ok) return { ok: false, message: started.error }
      // Shown, like a task you start yourself; it runs either way.
      await sendToWindow(wc, { name: 'open_task', args: { task: started.runId }, resolved: { workspacePath: path, runId: started.runId } })
      return { ok: true, message: `Started it in ${basename(path)}.`, runId: started.runId }
    }
    case 'send_to_task': {
      const found = await task()
      if ('error' in found) return { ok: false, message: found.error }
      const wc = window()
      if (!wc) return { ok: false, message: 'No app window is open.' }
      const sent = await deps.sendToTask(found.workspacePath, found.runId, { role: 'user', content: String(a.message), at: new Date().toISOString() }, wc)
      if (!sent.ok) return { ok: false, message: sent.error }
      // Shown, like a task you send to yourself, unless it was the one on screen already.
      if (found.runId !== ctx.runId) {
        await sendToWindow(wc, { name: 'open_task', args: { task: found.runId }, resolved: { workspacePath: found.workspacePath, runId: found.runId } })
      }
      return {
        ok: true,
        message: sent.queued ? `Added to ${quoted(found.title)}; it gets it at its next step.` : `${quoted(found.title)} is on it.`,
        runId: found.runId
      }
    }
    case 'stop_task': {
      const found = await task()
      if ('error' in found) return { ok: false, message: found.error }
      return deps.cancelRun(found.runId)
        ? { ok: true, message: `Stopped ${quoted(found.title)}.`, runId: found.runId }
        : { ok: false, message: `${quoted(found.title)} isn’t running.` }
    }
    case 'set_theme':
      await patchSettings({ theme: a.theme })
      return { ok: true, message: `The theme is ${String(a.theme)} now.` }
    case 'set_skin':
      await patchSettings({ skinId: a.skin })
      return { ok: true, message: `The skin is ${String(a.skin)} now.` }
    case 'set_tool_approvals': {
      const current = (deps.settings() as { toolApproval?: Record<string, unknown> }).toolApproval ?? {}
      await patchSettings({ toolApproval: { ...current, mode: a.mode } }, { toolApproval: { mode: a.mode } })
      return { ok: true, message: a.mode === 'off' ? 'Tool approvals are off.' : `Tool approvals are on for ${a.mode === 'all' ? 'every tool' : 'changes'}.` }
    }
    case 'set_model': {
      const key = knownModel(deps, String(a.model))
      if (!key) return { ok: false, message: NOT_A_KNOWN_MODEL }
      await patchSettings({ provider: key.provider, model: key.model })
      // Said in full: "New tasks use…" was taken to mean the task on screen too (2026-10-16 03:04).
      return { ok: true, message: `New tasks start on ${key.model}. Tasks that exist keep their own model.` }
    }
    case 'open_path':
    case 'reveal_path': {
      // "%APPDATA%\vyotiq\logs\vyotiq.log" is how the agent itself wrote the log's path (2026-10-16 run fb8b6636).
      const raw = expandPathVars(String(a.path))
      const base = ctx.filesRoot ?? ctx.workspacePath ?? deps.activeWorkspace()
      const path = isAbsolute(raw) ? raw : base ? resolve(base, raw) : null
      if (!path || !existsSync(path)) return { ok: false, message: `There’s nothing at ${raw}.` }
      if (name === 'reveal_path') {
        deps.revealPath(path)
        return { ok: true, message: `Showing ${basename(path)}.` }
      }
      if (PROGRAM_EXT.has(extname(path).toLowerCase())) return { ok: false, message: `${basename(path)} is a program; it isn’t opened from here.` }
      const error = await deps.openPath(path)
      return error ? { ok: false, message: error } : { ok: true, message: `Opened ${basename(path)}.` }
    }
    case 'open_url': {
      let url: URL
      try {
        url = new URL(String(a.url))
      } catch {
        return { ok: false, message: 'That isn’t a web address.' }
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, message: 'Only web addresses open from here.' }
      await deps.openExternal(url.toString())
      return { ok: true, message: `Opened ${url.hostname}.` }
    }
    case 'quit_app':
      // After this answer is said: quitting now would cut it off.
      setTimeout(() => deps.quit(), 1500)
      return { ok: true, message: 'Quitting.' }
    case 'voice_mute': {
      const voice = voiceOf(deps, ctx)
      if (!voice) return { ok: false, message: 'Voice mode isn’t on.' }
      const untilCalled = a.until !== 'unmuted'
      voice.mute(untilCalled)
      return { ok: true, message: untilCalled ? 'Muted until called: saying “Agent V” wakes it.' : 'Muted until unmuted.' }
    }
    case 'voice_end': {
      const voice = voiceOf(deps, ctx)
      if (!voice) return { ok: false, message: 'Voice mode isn’t on.' }
      voice.end()
      return { ok: true, message: 'Voice mode ends once your reply has been heard.' }
    }
    case 'set_voice_speed':
    case 'set_voice_placement': {
      const voice = (deps.settings() as { voice?: Record<string, unknown> }).voice ?? {}
      const patch = name === 'set_voice_speed' ? { speed: a.speed } : { placement: a.placement }
      await patchSettings({ voice: { ...voice, ...patch } }, { voice: patch })
      if (name === 'set_voice_placement') return { ok: true, message: `Voice shows as ${String(a.placement)} now.` }
      // Saved either way; a model that refuses a speed must not be told it took (2026-10-16: speed 1.15 on Eleven v4).
      return deps.speedIgnored?.()
        ? { ok: false, message: `Saved ${String(a.speed)} times, but the speaking model in use can’t change its speed. Another model in Settings, Voice, can.` }
        : { ok: true, message: `The voice speaks at ${String(a.speed)} times speed now.` }
    }
    case 'set_voice_options': {
      const o = args as AppActionArgs<'set_voice_options'>
      const patch = {
        ...(o.look !== undefined ? { orbLook: o.look } : {}),
        ...(o.style !== undefined ? { style: o.style } : {}),
        ...(o.layout !== undefined ? { viewLayout: o.layout } : {}),
        ...(o.patience !== undefined ? { endOfTurnPatience: o.patience } : {}),
        ...(o.captions !== undefined ? { captions: o.captions } : {}),
        ...(o.sounds !== undefined ? { earcons: o.sounds } : {}),
        ...(o.progress !== undefined ? { speakProgress: o.progress } : {}),
        ...(o.hold_to_talk !== undefined ? { pushToTalkOnly: o.hold_to_talk } : {})
      }
      if (Object.keys(patch).length === 0) return { ok: false, message: 'I couldn’t do that: no voice option was named.' }
      const voice = (deps.settings() as { voice?: Record<string, unknown> }).voice ?? {}
      await patchSettings({ voice: { ...voice, ...patch } }, { voice: patch })
      const said = [
        o.look !== undefined && `the orb is ${o.look}`,
        o.style !== undefined && `the style is ${o.style}`,
        o.layout !== undefined && `the layout is ${o.layout}`,
        o.patience !== undefined && `it waits ${o.patience === 'quick' ? 'briefly' : o.patience === 'patient' ? 'longer' : 'the usual time'} before you’re done`,
        o.captions !== undefined && `captions are ${o.captions ? 'on' : 'off'}`,
        o.sounds !== undefined && `sounds are ${o.sounds ? 'on' : 'off'}`,
        o.progress !== undefined && `progress is ${o.progress ? 'spoken' : 'not spoken'}`,
        o.hold_to_talk !== undefined && (o.hold_to_talk ? 'it listens only while you hold to talk' : 'it listens without holding')
      ].filter(Boolean)
      return { ok: true, message: `Set: ${said.join(', ')}.` }
    }
    case 'set_voice': {
      const voice = voiceOf(deps, ctx)
      if (!voice) return { ok: false, message: 'Voice mode isn’t on.' }
      return voice.setVoice(String(a.voice))
    }
    default:
      // The window's own: views, panels, the navigator, the agent's mode, the update.
      return toWindow()
  }
}
