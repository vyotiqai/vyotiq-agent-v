/**
 * The app as the agent reads it with `app_control` `app_status`
 * (docs/voice-mode.md §24.14, §27): the screen, the workspace and its branch,
 * the task and the other work across workspaces, a few settings, voice mode,
 * the update, the date and time, and the workspace's rules and memory by
 * headline.
 *
 * Without it "is there an update?" was answered with a guess (2026-10-16
 * 02:37: "There's an update ready to download", then "There's no update to
 * download").
 */
import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, isAbsolute, join, resolve } from 'path'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import { DEFAULT_VOICE_SETTINGS, type VoiceScreen } from '../../shared/ipc/schemas/voice'

export type AppTaskState = 'running' | 'waiting' | 'done' | 'error' | 'cancelled'

export type AppSnapshot = {
  now: Date
  /** What the window shows; unknown before the window says. */
  screen?: VoiceScreen
  workspace: { name: string; branch?: string } | null
  /** The task on screen, when there is one. */
  task?: { title: string; state: AppTaskState } | null
  /** Work going on elsewhere: other tasks running or stopped on you, in any open workspace. */
  others: Array<{ title: string; workspace: string; state: 'running' | 'waiting' }>
  /** Messages queued on the task, sent at its next step. */
  queued?: number
  settings: {
    model?: string
    approvals?: string
    theme?: string
    skin?: string
  }
  /** Voice mode, when it is on; the options past placement and speed are said only where they aren't the default. */
  voice?: {
    placement: string
    speed: number
    look?: string
    style?: string
    muted?: 'until_called' | 'until_unmuted'
    layout?: string
    patience?: string
    captions?: boolean
    sounds?: boolean
    progress?: boolean
    holdToTalk?: boolean
    language?: string
  } | null
  /** Settings this run set that someone else has changed since (appControl/setByAgent). */
  changedSince?: Array<{ what: string; set: string; now: string }>
  /** The app's update, as the updater last knew it. */
  update?: { status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error'; version?: string }
  /** The workspace's rules files, by name and first heading. */
  rules: string[]
  /** The agent's memory notes for the workspace, by title. */
  memory: string[]
}

/** Lists are cut here: headlines, not contents. */
const MAX_OTHERS = 6
const MAX_HEADLINES = 8
const TITLE_CHARS = 90

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const SCREEN_LINE: Readonly<Record<Exclude<VoiceScreen, 'task'>, string>> = {
  new_task: 'New task, nothing started yet',
  home: 'Home',
  settings: 'Settings',
  marketplace: 'the marketplace',
  usage: 'Usage',
  screen: 'a screen capture'
}

const STATE_WORDS: Readonly<Record<AppTaskState, string>> = {
  running: 'running',
  waiting: 'stopped until the user answers',
  done: 'finished',
  error: 'stopped with an error',
  cancelled: 'stopped'
}

const UPDATE_WORDS: Readonly<Record<NonNullable<AppSnapshot['update']>['status'], string>> = {
  idle: 'not checked yet this session (check_update checks now)',
  checking: 'checking now',
  available: 'one is out and not downloaded',
  'not-available': 'none, this is the newest',
  downloading: 'downloading',
  downloaded: 'downloaded, installs when asked (the app restarts)',
  error: 'the last check failed'
}

/** "Thursday 15 October 2026, 7:05 pm", in the app's own time zone. */
export function spokenNow(now: Date): string {
  const day = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const time = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase()
  return `${day.replace(/,/g, '')}, ${time}`
}

export function formatAppContext(s: AppSnapshot): string {
  const lines: string[] = [`(The app right now, ${spokenNow(s.now)}:)`]
  if (s.screen === 'task' && s.task) lines.push(`On screen: the task “${clip(s.task.title, TITLE_CHARS)}”, ${STATE_WORDS[s.task.state]}.`)
  else if (s.screen && s.screen !== 'task') lines.push(`On screen: ${SCREEN_LINE[s.screen]}.`)
  if (s.queued) lines.push(`${s.queued} message${s.queued === 1 ? ' is' : 's are'} queued on it, given to it at its next step.`)
  if (s.workspace) lines.push(`Workspace: ${s.workspace.name}${s.workspace.branch ? `, on branch ${s.workspace.branch}` : ''}.`)
  const others = s.others.slice(0, MAX_OTHERS)
  if (others.length > 0) {
    const listed = others.map((o) => `“${clip(o.title, TITLE_CHARS)}” in ${o.workspace} (${o.state === 'waiting' ? 'stopped until the user answers' : 'running'})`)
    const more = s.others.length - others.length
    lines.push(`Other tasks: ${listed.join('; ')}${more > 0 ? `; and ${more} more` : ''}.`)
  } else lines.push('No other tasks are running.')
  const set = s.settings
  const settings = [
    set.model ? `new tasks start on ${set.model}` : '',
    set.approvals ? `tool approvals are ${set.approvals}` : '',
    set.theme ? `${set.theme} theme` : '',
    set.skin ? `${set.skin} skin` : ''
  ].filter(Boolean)
  if (settings.length > 0) lines.push(`Settings: ${settings.join('; ')}.`)
  if (s.voice) {
    const muted = s.voice.muted === 'until_called' ? ', muted until called by name' : s.voice.muted === 'until_unmuted' ? ', muted' : ''
    lines.push(`Voice mode is on, shown as ${s.voice.placement}${s.voice.look ? ` with the ${s.voice.look} orb` : ''}${s.voice.style ? `, ${s.voice.style} style` : ''}${s.voice.speed !== 1 ? ` at ${s.voice.speed} times speed` : ''}${muted}.`)
    // What set_voice_options can set, so "are captions on?" is read, not guessed; defaults stay unsaid.
    const v = s.voice
    const d = DEFAULT_VOICE_SETTINGS
    const options = [
      v.layout !== undefined && v.layout !== d.viewLayout ? `full-screen layout ${v.layout}` : '',
      v.patience !== undefined && v.patience !== d.endOfTurnPatience ? `waits ${v.patience === 'quick' ? 'briefly' : 'longer'} before you’re done` : '',
      v.captions === false ? 'captions off' : '',
      v.sounds === false ? 'sounds off' : '',
      v.progress === true ? 'progress spoken' : '',
      v.holdToTalk === true ? 'listens only while you hold to talk' : '',
      v.language !== undefined && v.language !== d.language ? (v.language ? `listens for language ${v.language}` : 'detects the language') : ''
    ].filter(Boolean)
    if (options.length > 0) lines.push(`Voice options: ${options.join('; ')}.`)
  }
  if (s.changedSince?.length) {
    const changes = s.changedSince.map((c) => `${c.what} is ${c.now} now (you set ${c.set})`)
    lines.push(`Changed since you set it, by the person or another task, not by you: ${changes.join('; ')}. Say so; don’t set it back unless they ask.`)
  }
  if (s.update) lines.push(`Update: ${UPDATE_WORDS[s.update.status]}${s.update.version && s.update.status !== 'not-available' ? ` (version ${s.update.version})` : ''}.`)
  if (s.rules.length > 0) lines.push(`Project rules the agent follows: ${s.rules.slice(0, MAX_HEADLINES).join('; ')}.`)
  if (s.memory.length > 0) lines.push(`The agent's memory notes here: ${s.memory.slice(0, MAX_HEADLINES).join('; ')}.`)
  return redactSecretsInText(lines.join('\n'))
}

/**
 * The checked-out branch, read from the repository's HEAD without running
 * git (a spawn costs ~250 ms here). A worktree's `.git` is a file naming its
 * git dir. Undefined outside a repository or when HEAD can't be read.
 */
export function readGitBranch(workspacePath: string): string | undefined {
  try {
    let dir = workspacePath
    // The workspace may be a folder inside the repository.
    for (let i = 0; i < 12; i++) {
      const dotGit = join(dir, '.git')
      if (existsSync(dotGit)) return branchFromDotGit(dotGit)
      const up = dirname(dir)
      if (up === dir) return undefined
      dir = up
    }
  } catch {
    /* unreadable: no branch */
  }
  return undefined
}

function branchFromDotGit(dotGit: string): string | undefined {
  let gitDir = dotGit
  if (statSync(dotGit).isFile()) {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
    if (!m) return undefined
    const target = m[1]!.trim()
    gitDir = isAbsolute(target) ? target : resolve(dirname(dotGit), target)
  }
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head)
  if (ref) return ref[1]
  return /^[0-9a-f]{7,}$/i.test(head) ? `none, detached at ${head.slice(0, 7)}` : undefined
}

/** A rules file as a headline: its name, and its first heading or line when it has one. */
export function ruleHeadline(path: string, content: string): string {
  const name = basename(path)
  for (const raw of content.split('\n')) {
    const line = raw.replace(/^#+\s*/, '').trim()
    if (!line || line === '---' || /^[a-z]+:/i.test(line)) continue
    return `${name} (${clip(line, 60)})`
  }
  return name
}
