/**
 * What the voice and the agent can do in the app (docs/voice-mode.md §24.15,
 * batch 3): one catalog, used by the voice's `app_action` and the agent's
 * `app_control`. Each action says where it runs (main, or the window, which
 * owns views, panes and panels), what it takes, and whether it is
 * destructive: a destructive action needs the user's yes first, said out
 * loud to the voice or on the agent's approval card.
 *
 * Before this the voice had three tools (hand to the agent, stop, stay
 * quiet) and the agent had none for the app: "switch to dark mode" went to
 * the coding agent, which edited the project's theme.
 */
import { z } from 'zod'

export const APP_VIEWS = ['home', 'settings', 'usage', 'inbox', 'scheduled', 'extensions', 'docs', 'whats_new', 'shortcuts'] as const
export const APP_PANELS = ['terminal', 'changes', 'browser', 'files', 'plan', 'pr'] as const
export const SETTINGS_SECTIONS = ['voice', 'providers', 'agent', 'tools', 'indexing'] as const
export const VOICE_PLACEMENT_NAMES = ['inline', 'companion', 'takeover', 'capsule', 'mini'] as const

/** A task, by its run id or words from its title; empty is the task on screen. */
const Task = z.string().trim().max(300).optional()
/** A workspace, by its folder name or path; empty is the one on screen. */
const Workspace = z.string().trim().max(500).optional()

export const APP_ACTION_ARGS = {
  // ── The window ──────────────────────────────────────────────────────────
  open_view: z.object({ view: z.enum(APP_VIEWS) }),
  open_settings: z.object({ section: z.enum(SETTINGS_SECTIONS).optional() }),
  open_panel: z.object({ panel: z.enum(APP_PANELS) }),
  toggle_navigator: z.object({}),
  new_task: z.object({ workspace: Workspace }),
  open_task: z.object({ task: z.string().trim().min(1).max(300) }),
  next_needs_you: z.object({}),
  switch_workspace: z.object({ workspace: z.string().trim().min(1).max(500) }),
  set_agent_mode: z.object({ mode: z.enum(['ask', 'agent']) }),
  // ── Tasks ───────────────────────────────────────────────────────────────
  start_task: z.object({ brief: z.string().trim().min(1).max(8000), workspace: Workspace }),
  stop_task: z.object({ task: Task }),
  archive_task: z.object({ task: Task }),
  delete_task: z.object({ task: Task }),
  // ── Settings ────────────────────────────────────────────────────────────
  set_theme: z.object({ theme: z.enum(['system', 'light', 'dark']) }),
  set_skin: z.object({ skin: z.enum(['native', 'default', 'proof', 'bench', 'gild']) }),
  set_tool_approvals: z.object({ mode: z.enum(['off', 'mutating', 'all']) }),
  set_model: z.object({ model: z.string().trim().min(1).max(200) }),
  // ── The system ──────────────────────────────────────────────────────────
  open_path: z.object({ path: z.string().trim().min(1).max(4096) }),
  reveal_path: z.object({ path: z.string().trim().min(1).max(4096) }),
  open_url: z.object({ url: z.string().trim().min(1).max(2000) }),
  install_update: z.object({}),
  quit_app: z.object({}),
  // ── The voice itself ────────────────────────────────────────────────────
  voice_mute: z.object({ until: z.enum(['called', 'unmuted']).optional() }),
  voice_end: z.object({}),
  set_voice_speed: z.object({ speed: z.number().min(0.5).max(2) }),
  set_voice: z.object({ voice: z.string().trim().min(1).max(100) }),
  set_voice_placement: z.object({ placement: z.enum(VOICE_PLACEMENT_NAMES) })
} as const

export type AppActionName = keyof typeof APP_ACTION_ARGS
export type AppActionArgs<N extends AppActionName = AppActionName> = z.infer<(typeof APP_ACTION_ARGS)[N]>

export type AppActionDef = {
  /** One line for the model: what it does. */
  summary: string
  /** Main runs it, or the window does (views, panes, panels, the update). */
  runs: 'main' | 'window'
  /** Can't be undone from where it was asked: needs the user's yes first. */
  destructive?: true
  /** Only the voice has it (its own controls). */
  voiceOnly?: true
}

export const APP_ACTIONS: Readonly<Record<AppActionName, AppActionDef>> = {
  open_view: { summary: `Show a view: ${APP_VIEWS.join(', ')}.`, runs: 'window' },
  open_settings: { summary: `Open Settings, optionally at a section: ${SETTINGS_SECTIONS.join(', ')}.`, runs: 'window' },
  open_panel: { summary: `Open a panel beside the task on screen: ${APP_PANELS.join(', ')}.`, runs: 'window' },
  toggle_navigator: { summary: 'Show or hide the task list.', runs: 'window' },
  new_task: { summary: 'Open New task, in a workspace if named.', runs: 'window' },
  open_task: { summary: 'Open a task, in any open workspace, by words from its title.', runs: 'window' },
  next_needs_you: { summary: 'Open the next task that is waiting on the user.', runs: 'window' },
  switch_workspace: { summary: 'Switch to an open workspace by its folder name.', runs: 'window' },
  set_agent_mode: { summary: 'Set the task on screen to Ask (read-only answers) or Agent (makes changes).', runs: 'window' },
  start_task: { summary: 'Start a new task with this brief, in a workspace if named, and open it.', runs: 'main' },
  stop_task: { summary: 'Stop a task’s run; the task on screen if none is named.', runs: 'main' },
  archive_task: { summary: 'Archive a task (out of the list, not deleted), or unarchive it.', runs: 'window' },
  delete_task: { summary: 'Delete a task (it goes to Recently deleted).', runs: 'window', destructive: true },
  set_theme: { summary: 'Set the app theme: system, light or dark.', runs: 'main' },
  set_skin: { summary: 'Set the app skin: native, default, proof, bench or gild.', runs: 'main' },
  set_tool_approvals: { summary: 'Tool approvals: off, mutating (ask before changes) or all (ask for every tool).', runs: 'main' },
  set_model: { summary: 'Set the agent’s model for new tasks, from the models used recently or marked favourite.', runs: 'main' },
  open_path: { summary: 'Open a file or folder with the system’s app (a path in the workspace, or absolute). Never a program.', runs: 'main' },
  reveal_path: { summary: 'Show a file or folder in the system file manager.', runs: 'main' },
  open_url: { summary: 'Open a web address (http or https) in the system browser.', runs: 'main' },
  install_update: { summary: 'Install the downloaded update; the app restarts.', runs: 'window', destructive: true },
  quit_app: { summary: 'Quit Agent V.', runs: 'main', destructive: true },
  voice_mute: { summary: 'Stop listening: until called by name ("Agent V") if until is called, else until unmuted.', runs: 'main', voiceOnly: true },
  voice_end: { summary: 'End voice mode.', runs: 'main', voiceOnly: true },
  set_voice_speed: { summary: 'How fast the voice speaks, 0.5 to 2 (1 is normal).', runs: 'main', voiceOnly: true },
  set_voice: { summary: 'Speak in another voice, by its name.', runs: 'main', voiceOnly: true },
  set_voice_placement: { summary: `Where voice mode shows: ${VOICE_PLACEMENT_NAMES.join(', ')}.`, runs: 'main', voiceOnly: true }
}

export const APP_ACTION_NAMES = Object.keys(APP_ACTIONS) as AppActionName[]

export function isAppActionName(name: string): name is AppActionName {
  return Object.prototype.hasOwnProperty.call(APP_ACTIONS, name)
}

/** The actions one side has: the agent never gets the voice's own controls. */
export function appActionsFor(who: 'voice' | 'agent'): AppActionName[] {
  return APP_ACTION_NAMES.filter((n) => who === 'voice' || !APP_ACTIONS[n].voiceOnly)
}

/** An `app_control` call that needs the user's OK whatever the approval settings say. */
export function isDestructiveAppControl(args: Record<string, unknown> | undefined): boolean {
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  return isAppActionName(action) && APP_ACTIONS[action].destructive === true
}

/** Parse an action's arguments; the reason when they don't fit. */
export function parseAppActionArgs(name: AppActionName, args: unknown): { ok: true; args: AppActionArgs } | { ok: false; error: string } {
  const parsed = APP_ACTION_ARGS[name].safeParse(args ?? {})
  if (parsed.success) return { ok: true, args: parsed.data as AppActionArgs }
  const issue = parsed.error.issues[0]
  return { ok: false, error: `${name}: ${issue?.path.join('.') || 'arguments'} ${issue?.message ?? 'are not valid'}` }
}

/** The catalog as the model reads it: one line per action with its arguments. */
export function describeAppActions(who: 'voice' | 'agent'): string {
  return appActionsFor(who)
    .map((n) => {
      const shape = APP_ACTION_ARGS[n].shape as Record<string, z.ZodType>
      const keys = Object.keys(shape)
      const args = keys.length ? ` {${keys.map((k) => `${k}${shape[k]!.safeParse(undefined).success ? '?' : ''}`).join(', ')}}` : ''
      return `${n}${args}: ${APP_ACTIONS[n].summary}${APP_ACTIONS[n].destructive ? ' Needs the user’s yes first.' : ''}`
    })
    .join('\n')
}

/** A window action, sent to the window and answered by it. */
export const AppWindowActionSchema = z.object({
  requestId: z.string().min(1).max(100),
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.unknown()),
  /** Main already found these (a task, a workspace), so the window doesn't search. */
  resolved: z.object({ workspacePath: z.string().max(4096).optional(), runId: z.string().max(200).optional() }).optional()
})
export type AppWindowAction = z.infer<typeof AppWindowActionSchema>

export const AppWindowActionResultSchema = z.object({
  requestId: z.string().min(1).max(100),
  ok: z.boolean(),
  /** Said back: what happened, or why not. */
  message: z.string().max(500)
})
export type AppWindowActionResult = z.infer<typeof AppWindowActionResultSchema>
