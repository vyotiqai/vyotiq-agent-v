/**
 * Generate plain-text siblings for Word-binary sources that runtime code and
 * tests read as files:
 *
 *   tests/fixtures/compact/(name).md.docx        -> (name).md
 *   resources/marketplace/(deep)SKILL.md.docx     -> SKILL.md
 *
 * These directories still use .docx sources; canonical root documentation and
 * the system harness are plain Markdown and are intentionally excluded.
 * Runs on postinstall and before test tasks. Idempotent — rewrites only
 * on content change.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docxParagraphs } from './sync-harness.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function walkDocx(dir, out = []) {
  let entries
    try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) walkDocx(p, out)
    else if (entry.isFile() && entry.name.endsWith('.md.docx')) out.push(p)
  }
  return out
}

const SKILL_YAML_KEYS = [
  'name',
  'description',
  'license',
  'compatibility',
  'allowed-tools',
  'metadata',
  'version'
]

function headingLevel(style) {
  const match = String(style || '').match(/heading\s*(\d)/i)
  return match ? Number(match[1]) : 0
}

function looksLikeFlattenedSkillYaml(text) {
  return /^name:\s+\S+.+\bdescription:\s+/s.test(String(text || '').trim())
}

/** Rebuild multiline YAML from a Word-flattened `name: … description: …` line. */
function expandFlattenedSkillYaml(line) {
  const text = String(line || '').trim()
  const keyRe = new RegExp(
    `(?:^|\\s)(${SKILL_YAML_KEYS.map((key) => key.replace('-', '\\-')).join('|')}):`,
    'g'
  )
  const hits = []
  let match
  while ((match = keyRe.exec(text)) !== null) {
    const matched = match[0]
    hits.push({
      key: match[1],
      matchStart: match.index + (/^\s/.test(matched) ? 1 : 0),
      valueStart: match.index + matched.length
    })
  }
  if (hits.length < 2 || hits[0]?.key !== 'name' || hits[0].matchStart !== 0) return null
  if (!hits.some((hit) => hit.key === 'description')) return null

  const lines = []
  let sawMetadata = false
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]
    const end = index + 1 < hits.length ? hits[index + 1].matchStart : text.length
    const value = text.slice(hit.valueStart, end).trim().replace(/^(?:>-?|\|-?)\s+/, '')
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

function skillDocxToMarkdown(paragraphs) {
  const body = []
  let yaml = null
  for (const paragraph of paragraphs) {
    const text = paragraph.text?.trim() ?? ''
    if (!yaml && looksLikeFlattenedSkillYaml(text)) {
      yaml = expandFlattenedSkillYaml(text)
      continue
    }
    if (paragraph.border && !text) {
      body.push('---')
      continue
    }
    if (!text) continue
    const level = headingLevel(paragraph.style)
    if (level > 0 && !looksLikeFlattenedSkillYaml(text)) {
      body.push(`${'#'.repeat(Math.min(level, 6))} ${text}`)
      continue
    }
    body.push(text)
  }
  const bodyText = body.join('\n\n')
  if (yaml) return `---\n${yaml}\n---\n\n${bodyText}\n`
  return `${bodyText}\n`
}

function docxToText(docxPath) {
  const buf = readFileSync(docxPath)
  if (path.basename(docxPath).toLowerCase() === 'skill.md.docx') {
    return skillDocxToMarkdown(docxParagraphs(buf))
  }
  return `${docxParagraphs(buf)
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n\n')}\n`
}

const TARGET_DIRS = [
  path.join(root, 'tests', 'fixtures'),
  path.join(root, 'resources', 'marketplace')
]

function main() {
  let written = 0
  for (const dir of TARGET_DIRS) {
    for (const docxPath of walkDocx(dir)) {
      const outPath = docxPath.replace(/\.md\.docx$/, '.md')
      const text = docxToText(docxPath)
      let existing = null
      try {
        existing = readFileSync(outPath, 'utf8')
      } catch {
        /* first run */
      }
      if (existing === text) continue
      writeFileSync(outPath, text, 'utf8')
      written++
      console.log(`[sync-docx-md] ${path.relative(root, outPath)}`)
    }
  }
  console.log(`[sync-docx-md] complete (${written} file(s) updated)`)
}

try {
  main()
} catch (err) {
  console.error('[sync-docx-md] failed:', err)
  process.exit(1)
}
