import {
  SkillFrontmatterSchema,
  type SkillFrontmatter,
  skillPackageVersion
} from '../../../shared/ipc'

export { skillPackageVersion }

function stripQuotes(value: string): string {
  return value.replace(/^["']|["']$/g, '').trim()
}

/**
 * Parse simple YAML frontmatter including optional nested `metadata:` maps.
 * Not a full YAML parser — sufficient for Agent Skills frontmatter.
 */
function parseBlockScalar(
  lines: string[],
  start: number,
  marker: string
): { value: string; nextIndex: number } {
  const block: string[] = []
  let indent: number | undefined
  let index = start

  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      block.push('')
      index += 1
      continue
    }
    const leading = /^\s*/.exec(line)?.[0].length ?? 0
    if (leading === 0) break
    indent ??= leading
    block.push(line.slice(indent).trimEnd())
    index += 1
  }

  const value = marker.startsWith('|')
    ? block.join('\n')
    : block.join(' ').replace(/[ \t]+/g, ' ')
  return { value: value.trim(), nextIndex: index - 1 }
}

function parseFrontmatterFields(yaml: string): Record<string, string | Record<string, string>> {
  const fields: Record<string, string | Record<string, string>> = {}
  let inMetadata = false
  const metadata: Record<string, string> = {}
  const lines = yaml.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue

    const metaLine = /^(?: {2}|\t)([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine)
    if (inMetadata && metaLine) {
      metadata[metaLine[1]] = stripQuotes(metaLine[2])
      continue
    }

    // Leaving an indented block
    if (inMetadata && !/^\s/.test(rawLine)) {
      inMetadata = false
      if (Object.keys(metadata).length > 0) fields.metadata = { ...metadata }
    }

    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(rawLine.trim())
    if (!top) continue
    const key = top[1]
    const value = top[2].trim()

    if (key === 'metadata' && value === '') {
      inMetadata = true
      continue
    }
    if (key === 'metadata' && value.startsWith('{')) {
      // Inline JSON-ish maps are not supported; ignore
      continue
    }
    inMetadata = false
    if (value === '>' || value === '>-' || value === '|' || value === '|-') {
      const block = parseBlockScalar(lines, index + 1, value)
      fields[key] = block.value
      index = block.nextIndex
      continue
    }
    fields[key] = stripQuotes(value)
  }

  if (inMetadata && Object.keys(metadata).length > 0) {
    fields.metadata = { ...metadata }
  }

  return fields
}

const FLATTENED_SKILL_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
  'version'
] as const

const FLATTENED_SKILL_KEY_RE = new RegExp(
  `(?:^|\\s)(${FLATTENED_SKILL_KEYS.map((key) => key.replace('-', '\\-')).join('|')}):`,
  'g'
)

function stripBlockScalarPrefix(value: string): string {
  return value.replace(/^(?:>-?|\|-?)\s+/, '').trim()
}

/** Rebuild multiline YAML from a single Word-flattened `name: … description: …` line. */
export function expandFlattenedSkillYaml(line: string): string | null {
  const text = line.trim()
  const hits: Array<{ key: string; matchStart: number; valueStart: number }> = []
  FLATTENED_SKILL_KEY_RE.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = FLATTENED_SKILL_KEY_RE.exec(text)) !== null) {
    const matched = match[0]
    const key = match[1]
    if (!key) continue
    const matchStart = match.index + (/^\s/.test(matched) ? 1 : 0)
    hits.push({ key, matchStart, valueStart: match.index + matched.length })
  }
  if (hits.length < 2 || hits[0]?.key !== 'name' || hits[0].matchStart !== 0) return null
  if (!hits.some((hit) => hit.key === 'description')) return null

  const lines: string[] = []
  let sawMetadata = false
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]
    if (!hit) continue
    const end = index + 1 < hits.length ? hits[index + 1]!.matchStart : text.length
    const value = stripBlockScalarPrefix(text.slice(hit.valueStart, end).trim())
    if (hit.key === 'metadata') {
      if (!sawMetadata) {
        lines.push('metadata:')
        sawMetadata = true
      }
      continue
    }
    if (hit.key === 'version') {
      if (!sawMetadata) {
        lines.push('metadata:')
        sawMetadata = true
      }
      lines.push(`  version: ${value}`)
      continue
    }
    if (hit.key === 'description') {
      lines.push('description: >-', `  ${value}`)
      continue
    }
    lines.push(`${hit.key}: ${value}`)
  }
  return lines.join('\n')
}

/**
 * Word `.docx` sync historically flattened Agent Skills frontmatter onto one line
 * and dropped `---` fences (Word autoformats them into paragraph borders).
 * Rebuild a canonical SKILL.md when that shape is detected.
 */
export function expandSkillMarkdown(raw: string): string {
  const trimmed = raw.replace(/^\uFEFF/, '')
  if (trimmed.startsWith('---')) {
    const end = trimmed.indexOf('\n---', 3)
    if (end < 0) return trimmed
    const yaml = trimmed.slice(3, end).trim()
    if (yaml.includes('\n') || !/^name:\s+\S+\s+description:\s+/i.test(yaml)) return trimmed
    const expanded = expandFlattenedSkillYaml(yaml)
    if (!expanded) return trimmed
    const body = trimmed.slice(end + 4)
    return `---\n${expanded}\n---${body.startsWith('\n') ? body : `\n${body}`}`
  }

  const nl = trimmed.search(/\r?\n/)
  const first = (nl < 0 ? trimmed : trimmed.slice(0, nl)).trim()
  const rest = nl < 0 ? '' : trimmed.slice(nl).replace(/^\r?\n/, '')
  const expanded = expandFlattenedSkillYaml(first)
  if (!expanded) return trimmed
  return `---\n${expanded}\n---\n\n${rest}`
}

export function parseSkillFrontmatter(raw: string): SkillFrontmatter & { body: string } {
  const trimmed = expandSkillMarkdown(raw.replace(/^\uFEFF/, ''))
  if (!trimmed.startsWith('---')) {
    throw new Error('SKILL.md must start with YAML frontmatter (---)')
  }
  const end = trimmed.indexOf('\n---', 3)
  if (end < 0) throw new Error('SKILL.md frontmatter is not closed')
  const yaml = trimmed.slice(3, end).trim()
  const body = trimmed.slice(end + 4).replace(/^\r?\n/, '')
  const fields = parseFrontmatterFields(yaml)

  const metadata: Record<string, string> = {}
  const rawMeta = fields.metadata
  if (rawMeta && typeof rawMeta === 'object') {
    Object.assign(metadata, rawMeta)
  }
  // Legacy top-level `version:` → metadata.version
  const legacyVersion = fields.version
  if (typeof legacyVersion === 'string' && legacyVersion && !metadata.version) {
    metadata.version = legacyVersion
  }

  const parsed = SkillFrontmatterSchema.parse({
    name: fields.name,
    description: fields.description,
    license: typeof fields.license === 'string' ? fields.license : undefined,
    compatibility: typeof fields.compatibility === 'string' ? fields.compatibility : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    'allowed-tools':
      typeof fields['allowed-tools'] === 'string' ? fields['allowed-tools'] : undefined
  })
  return { ...parsed, body }
}
