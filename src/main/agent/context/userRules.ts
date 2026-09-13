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
  /** Assistant identity override. Empty = default spine name. */
  persona?: string
  /** Built-in identity blurb rendered when no user persona is set. */
  identity?: string
  /** Tone directive for replies. Empty = default spine tone. */
  tone?: string
  /** Preferred response language. Empty = follow the user's language. */
  responseLanguage?: string
  /** Default answer length. `concise` is the spine default and emits nothing. */
  responseVerbosity?: ResponseVerbosity
}

/**
 * Optional user persona/tone/language/verbosity preferences from settings,
 * rendered as a stable-zone section mirroring `<user_rules>`. Emits nothing at
 * defaults.
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
    lines.push(`Identity: this assistant is "${persona}"; that name overrides the default assistant name.`)
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
