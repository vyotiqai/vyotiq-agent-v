/**
 * What the agent can do in the app (docs/voice-mode.md §24.15, §27): one
 * catalog, used by the agent's `app_control`, typed or talked to. Each action
 * says where it runs (main, or the window, which owns views, panes and
 * panels), what it takes, and whether it is destructive: a destructive action
 * needs the user's yes first, on the approval card or said out loud to it.
 *
 * Voice mode is the agent too (§27): its own controls (mute, end, speed,
 * voice, placement) are here for the agent, and work while voice mode is on.
 */
import { z } from 'zod'
import { VOICE_ORB_LOOKS, VOICE_PLACEMENTS, VOICE_STYLES, VOICE_VIEW_LAYOUTS, VoiceEndOfTurnPatienceSchema } from './ipc/schemas/voice'
import { SkinIdSchema } from './skins'

export const APP_VIEWS = ['home', 'settings', 'usage', 'inbox', 'scheduled', 'extensions', 'docs', 'whats_new', 'shortcuts'] as const
export const APP_PANELS = ['terminal', 'changes', 'browser', 'files', 'plan', 'pr'] as const
/** Every section Settings has (renderer `SettingsSection`; a test keeps the two the same). */
export const SETTINGS_SECTIONS = [
  'general',
  'appearance',
  'notifications',
  'shortcuts',
  'providers',
  'agent',
  'tools',
  'indexing',
  'voice',
  'storage',
  'diagnostics',
  'about'
] as const
/**
 * The palette's commands with no action of their own, on what is on screen
 * (§24.18): the voice heard "split the screen" and had nothing to call.
 */
export const APP_COMMANDS = [
  'split_pane',
  'close_pane',
  'find',
  'find_in_files',
  'show_reasoning',
  'hide_reasoning',
  'open_in_editor',
  'add_workspace',
  'import_task',
  'send_feedback'
] as const
/** Voice mode's placements: Settings' own list, so one added there can be asked for. */
export const VOICE_PLACEMENT_NAMES = VOICE_PLACEMENTS

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
  run_command: z.object({ command: z.enum(APP_COMMANDS) }),
  new_task: z.object({ workspace: Workspace }),
  open_task: z.object({ task: z.string().trim().min(1).max(300) }),
  next_needs_you: z.object({}),
  switch_workspace: z.object({ workspace: z.string().trim().min(1).max(500) }),
  set_agent_mode: z.object({ mode: z.enum(['ask', 'agent']) }),
  // ── Tasks ───────────────────────────────────────────────────────────────
  start_task: z.object({ brief: z.string().trim().min(1).max(8000), workspace: Workspace }),
  send_to_task: z.object({ message: z.string().trim().min(1).max(8000), task: Task }),
  stop_task: z.object({ task: Task }),
  rename_task: z.object({ title: z.string().trim().min(1).max(200), task: Task }),
  archive_task: z.object({ task: Task, unarchive: z.boolean().optional() }),
  delete_task: z.object({ task: Task }),
  fork_task: z.object({ task: Task }),
  // ── Settings ────────────────────────────────────────────────────────────
  set_theme: z.object({ theme: z.enum(['system', 'light', 'dark']) }),
  set_skin: z.object({ skin: SkinIdSchema }),
  set_tool_approvals: z.object({ mode: z.enum(['off', 'mutating', 'all']) }),
  set_model: z.object({ model: z.string().trim().min(1).max(200) }),
  set_task_model: z.object({ model: z.string().trim().min(1).max(200), task: Task }),
  // ── Reading the app ─────────────────────────────────────────────────────
  app_status: z.object({}),
  // ── The system ──────────────────────────────────────────────────────────
  open_path: z.object({ path: z.string().trim().min(1).max(4096) }),
  reveal_path: z.object({ path: z.string().trim().min(1).max(4096) }),
  open_url: z.object({ url: z.string().trim().min(1).max(2000) }),
  check_update: z.object({}),
  download_update: z.object({}),
  install_update: z.object({}),
  quit_app: z.object({}),
  // ── The voice itself ────────────────────────────────────────────────────
  voice_mute: z.object({ until: z.enum(['called', 'unmuted']).optional() }),
  voice_end: z.object({}),
  set_voice_speed: z.object({ speed: z.number().min(0.5).max(2) }),
  set_voice: z.object({ voice: z.string().trim().min(1).max(100) }),
  set_voice_placement: z.object({ placement: z.enum(VOICE_PLACEMENT_NAMES) }),
  // "Orb to cloud" (2026-10-16 kept conversation) had nothing to call: the rest of Settings, Voice.
  set_voice_options: z.object({
    look: z.enum(VOICE_ORB_LOOKS).optional(),
    style: z.enum(VOICE_STYLES).optional(),
    layout: z.enum(VOICE_VIEW_LAYOUTS).optional(),
    patience: VoiceEndOfTurnPatienceSchema.optional(),
    captions: z.boolean().optional(),
    sounds: z.boolean().optional(),
    progress: z.boolean().optional(),
    hold_to_talk: z.boolean().optional(),
    // ISO-639-1, or detect: "listen in Hindi" had nothing to call.
    language: z.string().trim().toLowerCase().regex(/^(?:[a-z]{2}|detect)$/).optional()
  })
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
}

export const APP_ACTIONS: Readonly<Record<AppActionName, AppActionDef>> = {
  open_view: { summary: `Show a view: ${APP_VIEWS.join(', ')}.`, runs: 'window' },
  open_settings: { summary: `Open Settings, optionally at a section: ${SETTINGS_SECTIONS.join(', ')}.`, runs: 'window' },
  open_panel: { summary: `Open a panel beside the task on screen: ${APP_PANELS.join(', ')}.`, runs: 'window' },
  toggle_navigator: { summary: 'Show or hide the task list.', runs: 'window' },
  run_command: {
    summary:
      'On what is on screen: split_pane (another task beside it), close_pane (closes the task’s tab; the task stays in the list), find (in the task), find_in_files, show_reasoning, hide_reasoning, open_in_editor (the workspace), add_workspace and import_task (open a picker for the user), send_feedback (opens the form).',
    runs: 'window'
  },
  new_task: { summary: 'Open New task, in a workspace if named.', runs: 'window' },
  open_task: { summary: 'Open a task, in any open workspace, by words from its title.', runs: 'window' },
  next_needs_you: { summary: 'Open the next task that is waiting on the user.', runs: 'window' },
  switch_workspace: { summary: 'Switch to an open workspace by its folder name.', runs: 'window' },
  set_agent_mode: { summary: 'Set the task on screen to Ask (read-only answers) or Agent (makes changes).', runs: 'window' },
  start_task: { summary: 'Start a new task with this brief, in a workspace if named, and open it.', runs: 'main' },
  send_to_task: {
    summary: 'Give a task in any open workspace more work: queued if it is running, else it starts again with this message. The task on screen if none is named.',
    runs: 'main'
  },
  stop_task: { summary: 'Stop a task’s run; the task on screen if none is named.', runs: 'main' },
  rename_task: { summary: 'Rename a task (not while it runs); the task on screen if none is named.', runs: 'window' },
  archive_task: { summary: 'Archive a task (out of the list, not deleted); unarchive true brings it back.', runs: 'window' },
  delete_task: { summary: 'Delete a task (it goes to Recently deleted).', runs: 'window', destructive: true },
  fork_task: { summary: 'Fork a stopped task: a copy to take another way, opened. The task on screen if none is named.', runs: 'window' },
  set_theme: { summary: 'Set the app theme: system, light or dark.', runs: 'main' },
  set_skin: { summary: `Set the app skin: ${SkinIdSchema.options.join(', ')}.`, runs: 'main' },
  set_tool_approvals: { summary: 'Tool approvals: off, mutating (ask before changes) or all (ask for every tool).', runs: 'main' },
  set_model: { summary: 'Set the model new tasks start with, from the models used recently or marked favourite. It does not change a task that exists; set_task_model does.', runs: 'main' },
  set_task_model: {
    summary: 'Set the model a task runs on from its next turn (the task on screen if none is named), from the models used recently or marked favourite. A run already working finishes on the model it started with.',
    runs: 'window'
  },
  app_status: {
    summary: 'Read the app as it is now: the date and time, what is on screen, the workspace and branch, tasks running or waiting in any workspace, the model and other settings, voice mode, and whether an update is out. Read it rather than guess.',
    runs: 'main'
  },
  open_path: { summary: 'Open a file or folder with the system’s app (a path in the workspace, or absolute). Never a program.', runs: 'main' },
  reveal_path: { summary: 'Show a file or folder in the system file manager.', runs: 'main' },
  open_url: { summary: 'Open a web address (http or https) in the system browser.', runs: 'main' },
  check_update: { summary: 'Check now whether an update to Agent V is out.', runs: 'main' },
  download_update: { summary: 'Download the update that is out (installing it is a separate step).', runs: 'window' },
  install_update: { summary: 'Install the downloaded update; the app restarts.', runs: 'window', destructive: true },
  quit_app: { summary: 'Quit Agent V.', runs: 'main', destructive: true },
  voice_mute: { summary: 'Voice mode stops listening: until called by name ("Agent V") when until is called or left out, until unmuted when until is unmuted.', runs: 'main' },
  voice_end: { summary: 'End voice mode, once what you are saying has been heard.', runs: 'main' },
  set_voice_speed: { summary: 'How fast the voice speaks, 0.5 to 2 (1 is normal).', runs: 'main' },
  set_voice: { summary: 'Speak in another voice, by its name.', runs: 'main' },
  set_voice_placement: { summary: `Where voice mode shows: ${VOICE_PLACEMENT_NAMES.join(', ')}.`, runs: 'main' },
  set_voice_options: {
    summary:
      'The rest of Settings, Voice, any of: the orb’s look, the style (quiet or ambient, glass), the full-screen layout, how long it waits before you are done speaking, captions, sounds, spoken progress while it works, hold to talk only, and the language it listens for (a two-letter code such as en or hi, or detect).',
    runs: 'main'
  }
}

export const APP_ACTION_NAMES = Object.keys(APP_ACTIONS) as AppActionName[]

export function isAppActionName(name: string): name is AppActionName {
  return Object.prototype.hasOwnProperty.call(APP_ACTIONS, name)
}


/** An `app_control` call that needs the user's OK whatever the approval settings say. */
export function isDestructiveAppControl(args: Record<string, unknown> | undefined): boolean {
  const action = typeof args?.action === 'string' ? args.action.trim() : ''
  return isAppActionName(action) && APP_ACTIONS[action].destructive === true
}

/** An argument's fixed choices, when it has them (`until: called | unmuted`). */
function choices(type: z.ZodType): readonly string[] | null {
  const inner = type instanceof z.ZodOptional ? (type.unwrap() as z.ZodType) : type
  return inner instanceof z.ZodEnum ? (inner.options as readonly string[]) : null
}

/**
 * Parse an action's arguments; the reason when they don't fit, in words the
 * voice can say (2026-10-15 live check: "voice_mute: until Invalid option:
 * expected one of…" was read out).
 */
export function parseAppActionArgs(name: AppActionName, args: unknown): { ok: true; args: AppActionArgs } | { ok: false; error: string } {
  const parsed = APP_ACTION_ARGS[name].safeParse(args ?? {})
  if (parsed.success) return { ok: true, args: parsed.data as AppActionArgs }
  const key = String(parsed.error.issues[0]?.path[0] ?? '')
  const shape = APP_ACTION_ARGS[name].shape as Record<string, z.ZodType>
  const options = key && shape[key] ? choices(shape[key]) : null
  if (options) return { ok: false, error: `I couldn’t do that: ${key} has to be ${options.join(' or ')}.` }
  return { ok: false, error: key ? `I couldn’t do that: the ${key} didn’t fit.` : 'I couldn’t do that: what to do was missing.' }
}

/** The catalog as the model reads it: one line per action with its arguments. */
export function describeAppActions(): string {
  return APP_ACTION_NAMES
    .map((n) => {
      const shape = APP_ACTION_ARGS[n].shape as Record<string, z.ZodType>
      const keys = Object.keys(shape)
      // Fixed choices are listed: told only `until?`, the voice model guessed a value (2026-10-15 live check).
      const arg = (k: string): string => {
        const options = choices(shape[k]!)
        return `${k}${shape[k]!.safeParse(undefined).success ? '?' : ''}${options ? `: ${options.join('|')}` : ''}`
      }
      const args = keys.length ? ` {${keys.map(arg).join(', ')}}` : ''
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
