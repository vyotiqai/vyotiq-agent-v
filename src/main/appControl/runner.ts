/**
 * Runs the app's actions (src/shared/appActions.ts) for the voice and the
 * agent. Main's own run here; the window's (views, panes, panels, the
 * update) are sent to the window, which answers. A task or workspace named
 * in words is found here first, across every open workspace.
 *
 * Confirmation is the caller's: the voice asks out loud, the agent's call
 * stops at the approval card. This runs what it is given.
 */
import { randomUUID } from 'crypto'
import { existsSync } from 'fs'
import { basename, extname, isAbsolute, resolve } from 'path'
import type { WebContents } from 'electron'
import {
  APP_ACTIONS,
  isAppActionName,
  parseAppActionArgs,
  type AppActionArgs,
  type AppActionName,
  type AppWindowAction,
  type AppWindowActionResult
} from '../../shared/appActions'
import { workspacePathsEqual } from '../../shared/workspacePathMatch'
import type { ChatMessage } from '../../shared/ipc'

export type AppActionResult = { ok: boolean; message: string; runId?: string }

/** What a run of an action knows about where it was asked. */
export type AppActionContext = {
  who: 'voice' | 'agent'
  /** The task on screen (voice) or the agent's own run. */
  runId?: string | null
  workspacePath?: string | null
  /** Where a relative path is read from, when not the workspace: an agent's worktree. */
  filesRoot?: string | null
  /** The voice's own controls, when the voice asks. */
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

function quoted(title: string): string {
  // A title's own full stop goes: the sentence it sits in ends with one ("Archived “Say hello.”." in the 2026-10-15 live check).
  const t = title.replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '')
  return t ? `“${t.length > 60 ? `${t.slice(0, 59)}…` : t}”` : 'the task'
}

/** Run one action. Arguments are checked here; the name must be one the caller may use. */
export async function runAppAction(deps: AppControlDeps, name: string, rawArgs: unknown, ctx: AppActionContext): Promise<AppActionResult> {
  if (!isAppActionName(name)) return { ok: false, message: `There’s no action called ${name}.` }
  const def = APP_ACTIONS[name]
  if (def.voiceOnly && ctx.who !== 'voice') return { ok: false, message: `${name} is the voice’s own control.` }
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
      await deps.patchSettings({ theme: a.theme })
      return { ok: true, message: `The theme is ${String(a.theme)} now.` }
    case 'set_skin':
      await deps.patchSettings({ skinId: a.skin })
      return { ok: true, message: `The skin is ${String(a.skin)} now.` }
    case 'set_tool_approvals': {
      const current = (deps.settings() as { toolApproval?: Record<string, unknown> }).toolApproval ?? {}
      await deps.patchSettings({ toolApproval: { ...current, mode: a.mode } })
      return { ok: true, message: a.mode === 'off' ? 'Tool approvals are off.' : `Tool approvals are on for ${a.mode === 'all' ? 'every tool' : 'changes'}.` }
    }
    case 'set_model': {
      const s = deps.settings()
      const known = [...new Set([...(s.favoriteModels ?? []), ...(s.recentModels ?? [])])]
      const want = words(String(a.model))
      const key = known.find((k) => k.split('::')[1] === String(a.model)) ?? known.find((k) => want.length > 0 && want.every((w) => k.toLowerCase().includes(w)))
      if (!key) return { ok: false, message: 'That model isn’t one used recently or marked favourite; pick it in the model menu.' }
      const [provider, model] = key.split('::')
      if (!provider || !model) return { ok: false, message: 'That model can’t be read.' }
      await deps.patchSettings({ provider, model })
      return { ok: true, message: `New tasks use ${model}.` }
    }
    case 'open_path':
    case 'reveal_path': {
      const raw = String(a.path)
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
      if (!ctx.voice) return { ok: false, message: 'Voice mode isn’t on.' }
      const untilCalled = a.until !== 'unmuted'
      ctx.voice.mute(untilCalled)
      return { ok: true, message: untilCalled ? 'Say “Agent V” when you need me.' : 'Muted.' }
    }
    case 'voice_end':
      if (!ctx.voice) return { ok: false, message: 'Voice mode isn’t on.' }
      ctx.voice.end()
      return { ok: true, message: 'Bye for now.' }
    case 'set_voice_speed':
    case 'set_voice_placement': {
      const voice = (deps.settings() as { voice?: Record<string, unknown> }).voice ?? {}
      const patch = name === 'set_voice_speed' ? { speed: a.speed } : { placement: a.placement }
      await deps.patchSettings({ voice: { ...voice, ...patch } })
      return { ok: true, message: name === 'set_voice_speed' ? 'Okay, is this better?' : `Voice shows as ${String(a.placement)} now.` }
    }
    case 'set_voice':
      if (!ctx.voice) return { ok: false, message: 'Voice mode isn’t on.' }
      return ctx.voice.setVoice(String(a.voice))
    default:
      // The window's own: views, panels, the navigator, the agent's mode, the update.
      return toWindow()
  }
}
