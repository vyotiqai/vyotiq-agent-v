import type { ResponseVerbosity, UserRule } from '../../../shared/ipc'
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
 * Voice mode is open on this workspace: the reply will be heard
 * (docs/voice-mode.md §8.6). Fixed text, so it costs one prompt-cache miss
 * when voice starts or stops, not one per step.
 */
export const VOICE_REPLY_TEXT = [
  'The person is talking with you by voice and hears your reply read aloud.',
  'Begin your final reply with a <spoken> block: one to three short spoken sentences in plain, natural speech, with no code, file paths, markdown, lists or long numbers. Say what you did or found, and end with what happens next or one direct question.',
  'Put everything detailed in the written reply after the block; in the spoken part, point to it ("the diff\'s on screen").',
  'Be warm and direct and match their tone; don\'t gush, apologise repeatedly, restate their question or repeat what you said earlier. If you\'re unsure, say so plainly. If a word that matters may have been misheard, ask before acting on it.',
  'Between tool calls, narrate in a few words at most.'
].join('\n')

export function formatVoiceReply(active: boolean): string {
  return active ? wrapPromptSection('voice_reply', VOICE_REPLY_TEXT) : ''
}
