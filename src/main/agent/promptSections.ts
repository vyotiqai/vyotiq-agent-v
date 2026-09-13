import { HARNESS_SECTION_TAGS } from './harnessSections'

/** Overlay XML tags assembled around the spine. Not HARNESS_SECTION_TAGS. */
export const OVERLAY_SECTION_TAGS = [
  'mode',
  'voice_style',
  'run_contract',
  'plan',
  'available_skills',
  'plugin_rules',
  'user_rules',
  'workspace_rules',
  'session',
  'workspace',
  'task_list',
  'active_goal',
  'run_notice',
  'prior_session',
  'live_session'
] as const

const TAG_NAME = /^[a-z][a-z0-9_]*$/i

/** Rewrite open/close sequences for `tags` so a body cannot close an outer wrap. */
export function neutralizeXmlTags(body: string, tags: readonly string[]): string {
  const names = [...new Set(tags.filter((tag) => TAG_NAME.test(tag)))]
  if (!body || names.length === 0) return body
  const re = new RegExp(`<\\s*/?\\s*(?:${names.join('|')})\\b`, 'gi')
  return body.replace(re, (match) => match.replace('<', '&lt;'))
}

function normalizePromptNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
}

/** Paired overlay wrap produced by `wrapPromptSection` / `formatPromptSection`. */
export function parseOuterPromptSection(text: string): { tag: string; inner: string } | null {
  const trimmed = normalizePromptNewlines(text).trim()
  const open = trimmed.match(/^<([a-z][a-z0-9_]*)>\n/)
  const tag = open?.[1]
  if (!tag || !open) return null
  const close = `\n</${tag}>`
  if (!trimmed.endsWith(close)) return null
  return { tag, inner: trimmed.slice(open[0].length, trimmed.length - close.length) }
}

export function formatPromptSection(tag: string, inner: string): string {
  if (!TAG_NAME.test(tag)) return ''
  return `<${tag}>\n${inner}\n</${tag}>`
}

/** Wrap a trusted overlay section. Overlay tags are not HARNESS_SECTION_TAGS. */
export function wrapPromptSection(tag: string, body: string): string {
  if (!TAG_NAME.test(tag)) return ''
  const trimmed = normalizePromptNewlines(body).trim()
  if (!trimmed) return ''
  // Escape this wrap's tag, live_session (volatile nest), and harness section tags.
  // Do not escape other overlay tags — `<live_session>` nests `<session>` /
  // `<workspace>` / `<task_list>`.
  const safe = neutralizeXmlTags(trimmed, [tag, 'live_session', ...HARNESS_SECTION_TAGS])
  return formatPromptSection(tag, safe)
}
