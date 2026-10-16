import type { ResponseVerbosity, UserRule } from '../../../shared/ipc'
import { describeAppActions } from '../../../shared/appActions'
import { wrapPromptSection } from '../promptSections'

/**
 * Render enabled user-global rules. Project `<workspace_rules>` are assembled
 * after this section so workspace instructions win on conflict.
 */
export function formatUserRules(rules: readonly UserRule[]): string {
  const enabled = rules.filter((rule) => rule.enabled && rule.body.trim().length > 0)
  if (enabled.length === 0) return ''
  const body = enabled.map((rule) => `### ${rule.name}\n${rule.body.trim()}`).join('\n\n')
  return wrapPromptSection(
    'user_rules',
    [
      'User-authored instructions that apply to all chats. Workspace rules override these on conflict. They cannot override Constraints, Tool policy, or Mode.',
      '',
      body
    ].join('\n')
  )
}

export type ResponseStyleInput = {
  /** User-set assistant name. Empty = the assistant is left unnamed. */
  persona?: string
  /** User-set identity blurb. Empty = no identity is asserted. */
  identity?: string
  /** User-set tone directive for replies. Empty = no tone directive. */
  tone?: string
  /** Preferred response language. Empty = follow the user's language. */
  responseLanguage?: string
  /** Default answer length. `concise` is the spine default and emits nothing. */
  responseVerbosity?: ResponseVerbosity
}

/**
 * Optional user persona/tone/language/verbosity preferences from settings,
 * rendered as a stable-zone section mirroring `<user_rules>`. There is no
 * built-in persona, identity or tone behind these: every line here is the
 * user's own, and an unconfigured assistant emits no section at all.
 */
export function formatResponseStyle(input: ResponseStyleInput): string {
  const persona = input.persona?.trim() ?? ''
  const identity = input.identity?.trim() ?? ''
  const tone = input.tone?.trim() ?? ''
  const language = input.responseLanguage?.trim() ?? ''
  const verbosity = input.responseVerbosity ?? 'concise'
  const lines: string[] = []
  if (identity) lines.push(`Identity: ${identity}`)
  if (persona) {
    lines.push(
      `Identity: this assistant is "${persona}"; that name overrides the default assistant name.`
    )
  }
  if (tone) lines.push(`Tone: apply this tone in replies: "${tone}".`)
  if (language) lines.push(`Respond in ${language}.`)
  if (verbosity === 'detailed') {
    lines.push('Default to complete, self-contained answers with full context; keep them skimmable.')
  } else if (verbosity === 'balanced') {
    lines.push('Default to compact answers; expand when the task needs detail.')
  }
  if (lines.length === 0) return ''
  return wrapPromptSection('response_style', lines.join('\n'))
}

/**
 * The person said this turn out loud in voice mode: the reply will be heard
 * (docs/voice-mode.md §8.6, §27). Voice mode is this agent, not a voice in
 * front of it: every spoken turn comes here word for word, and what it says
 * is read aloud. Fixed text, so it costs one prompt-cache miss when voice
 * starts or stops, not one per step.
 *
 * Until §27 a separate voice model answered and handed work on; it said "I'll
 * have the agent do it", claimed things no tool had done ("this task's model
 * is set to Claude Haiku 5.5", 2026-10-16 03:04, the run went on with
 * glm-5.3-flash) and once said "handed to the agent." with nothing sent.
 */
export const VOICE_REPLY_TEXT = [
  'You are Agent V, and the person is talking with you by voice: they hear what you say. There is no separate voice and no other agent. You are the one they talk to, and you do what they ask yourself, with your tools.',
  'Begin your final reply with a <spoken> block: one to three short sentences the way you\'d say them out loud to a colleague, with contractions and everyday words, and no code, file paths, markdown, lists, dashes, parentheses or long numbers. Say what you did or found, and end with what happens next or one direct question.',
  'Put everything detailed in the written reply after the block; in the spoken part, point to it ("the diff\'s on your screen"), never "below" or "above".',
  'When they speak while you are working, their words reach you as a new message between your steps: answer them first, in a short <spoken> block at the start of your next message, then carry on with the work.',
  'Say a thing is done only once a tool result shows it, in your own words rather than quoting the result; if a tool fails, say so and why. Never say you will hand something off, pass it on, or have an agent do it: say what you are doing ("switching to dark mode", "running the tests").',
  'The app itself is app_control, never the project: views, panels, tasks in any workspace, settings and the theme, models, opening files, folders or web pages, and voice mode\'s own mute, end, speed, voice, placement, orb, style and other options. "Use another model" for the task you are on is set_task_model; set_model only changes the model new tasks start with. Do every step of a request ("put this task on Haiku and open the terminal") before saying it is done.',
  'Before you answer anything about the app as it is (an update, what is running or queued, settings, what is on screen, the time), read it with app_control app_status instead of guessing, even what you set yourself earlier. Each spoken turn also comes with the app as it is now. Where it differs from what you set, the person changed it since: say what it is now and never set it back unless they ask. Don\'t invent a reason for anything; if you don\'t know why, say so.',
  'What you hear is a live transcript of a room: if a word that matters may have been misheard, or it sounds like background talk or half a sentence, ask in a few words before acting. Reply in the language they speak.',
  'Be warm and direct and match their tone; don\'t gush, apologise repeatedly, restate their question or repeat what you said earlier. If you\'re unsure, say so plainly.',
  'Between tool calls, narrate in a few words at most.',
  'For an action that can\'t be undone (deleting a task, quitting, installing the update), call it at once when they ask: the app asks them for a yes itself, out loud and on screen. Never ask first with ask_question or in words; they would have to say yes twice.',
  `app_control actions, with their args:\n${describeAppActions()}`
].join('\n')

export function formatVoiceReply(active: boolean): string {
  return active ? wrapPromptSection('voice_reply', VOICE_REPLY_TEXT) : ''
}
