export type ParsedRuleEditor = {
  alwaysApply: boolean
  hadAlwaysApplyKey: boolean
  description: string
  body: string
  /** Inner frontmatter lines (no wrapping `---`), or null when the file has none. */
  frontmatterLines: string[] | null
}

export function parseRuleEditor(raw: string): ParsedRuleEditor {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (!trimmed.startsWith('---')) {
    return {
      alwaysApply: true,
      hadAlwaysApplyKey: false,
      description: '',
      body: trimmed,
      frontmatterLines: null
    }
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) {
    return {
      alwaysApply: true,
      hadAlwaysApplyKey: false,
      description: '',
      body: trimmed,
      frontmatterLines: null
    }
  }
  const fmRaw = trimmed.slice(3, end).replace(/^\r?\n/, '').replace(/\r?\n$/, '')
  const frontmatterLines = fmRaw.length > 0 ? fmRaw.split(/\r?\n/) : []
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '')
  let alwaysApply = true
  let hadAlwaysApplyKey = false
  let description = ''
  for (const line of frontmatterLines) {
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1]!
    const value = m[2]!.trim()
    if (key === 'alwaysApply') {
      hadAlwaysApplyKey = true
      if (/^(false|no|0)$/i.test(value)) alwaysApply = false
      else if (/^(true|yes|1)$/i.test(value)) alwaysApply = true
    } else if (key === 'description') {
      description = value.replace(/^["']|["']$/g, '')
    }
  }
  return { alwaysApply, hadAlwaysApplyKey, description, body, frontmatterLines }
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
    const m = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/)
    const key = m?.[1]
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
