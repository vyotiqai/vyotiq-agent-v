import type { SkillFrontmatter } from '../ipc'

function yamlScalar(value: string): string {
  if (
    value === '' ||
    value !== value.trim() ||
    /[:#{}[\],&*!|>'"%@`\n]/.test(value)
  ) {
    return JSON.stringify(value)
  }
  return value
}

/** Serialize Agent Skills frontmatter + body. Round-trips with `parseSkillFrontmatter`. */
export function serializeSkillMarkdown(fm: SkillFrontmatter, body: string): string {
  const lines = ['---', `name: ${fm.name}`, `description: ${yamlScalar(fm.description)}`]
  if (fm.license) lines.push(`license: ${yamlScalar(fm.license)}`)
  if (fm.compatibility) lines.push(`compatibility: ${yamlScalar(fm.compatibility)}`)
  if (fm['allowed-tools']) lines.push(`allowed-tools: ${yamlScalar(fm['allowed-tools'])}`)
  if (fm.metadata && Object.keys(fm.metadata).length > 0) {
    lines.push('metadata:')
    for (const key of Object.keys(fm.metadata).sort()) {
      lines.push(`  ${key}: ${yamlScalar(fm.metadata[key] ?? '')}`)
    }
  }
  lines.push('---', '')
  const trimmedBody = body.replace(/^\uFEFF/, '')
  const withNl = trimmedBody.endsWith('\n') ? trimmedBody : `${trimmedBody}\n`
  return `${lines.join('\n')}${withNl}`
}
