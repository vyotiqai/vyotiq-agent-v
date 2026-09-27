import { matchFrontmatterKey, splitFrontmatter, stripQuotes } from '@shared/rules'

export type ParsedRuleEditor = {
  alwaysApply: boolean
  hadAlwaysApplyKey: boolean
  description: string
  body: string
  /** Inner frontmatter lines (no wrapping `---`), or null when the file has none. */
  frontmatterLines: string[] | null
}

/**
 * Editor-side read of a rule file.
 *
 * Shares the split and the key regex with the agent, but keeps its own policy:
 * it wants raw values and the verbatim frontmatter lines so an unrecognized key
 * survives a save, and it tracks whether `alwaysApply` was written at all —
 * which the agent's parsed meta cannot express, since an unrecognized value
 * leaves the flag absent.
 */
export function parseRuleEditor(raw: string): ParsedRuleEditor {
  const { lines, body } = splitFrontmatter(raw)
  if (!lines) {
    return {
      alwaysApply: true,
      hadAlwaysApplyKey: false,
      description: '',
      body,
      frontmatterLines: null
    }
  }
  let alwaysApply = true
  let hadAlwaysApplyKey = false
  let description = ''
  for (const line of lines) {
    const entry = matchFrontmatterKey(line)
    if (!entry) continue
    if (entry.key === 'alwaysApply') {
      hadAlwaysApplyKey = true
      if (/^(false|no|0)$/i.test(entry.value)) alwaysApply = false
      else if (/^(true|yes|1)$/i.test(entry.value)) alwaysApply = true
    } else if (entry.key === 'description') {
      description = stripQuotes(entry.value)
    }
  }
  return { alwaysApply, hadAlwaysApplyKey, description, body, frontmatterLines: lines }
}

export function serializeRuleEditor(args: {
  alwaysApply: boolean
  hadAlwaysApplyKey: boolean
  description: string
  body: string
  frontmatterLines: string[] | null
}): string {
  const lines: string[] = ['---']
  let sawAlways = false
  let sawDesc = false
  const originals = args.frontmatterLines ?? []
  for (const line of originals) {
    const key = matchFrontmatterKey(line)?.key
    if (key === 'alwaysApply') {
      lines.push(`alwaysApply: ${args.alwaysApply ? 'true' : 'false'}`)
      sawAlways = true
      continue
    }
    if (key === 'description') {
      sawDesc = true
      if (args.description.trim()) {
        lines.push(`description: ${JSON.stringify(args.description.trim())}`)
      }
      continue
    }
    lines.push(line)
  }
  const writeAlways = args.hadAlwaysApplyKey || args.alwaysApply === false || originals.length === 0
  if (!sawAlways && writeAlways) {
    lines.push(`alwaysApply: ${args.alwaysApply ? 'true' : 'false'}`)
  }
  if (!sawDesc && args.description.trim()) {
    lines.push(`description: ${JSON.stringify(args.description.trim())}`)
  }
  lines.push('---', '')
  const body = args.body.replace(/^\uFEFF/, '')
  const withNl = body.endsWith('\n') ? body : `${body}\n`
  return `${lines.join('\n')}${withNl}`
}
