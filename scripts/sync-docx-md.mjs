/**
 * Generate plain-text siblings for Word-binary sources that runtime code and
 * tests read as files:
 *
 *   tests/fixtures/compact/(name).md.docx        -> (name).md
 *   landing/src/content/docs/(deep)(name).md.docx -> (name).md (structure kept)
 *   resources/marketplace/(deep)SKILL.md.docx     -> SKILL.md
 *
 * These directories still use .docx sources; canonical root documentation and
 * the system harness are plain Markdown and are intentionally excluded.
 * Runs on postinstall and before test/landing tasks. Idempotent — rewrites only
 * on content change.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { docxBlocks, docxParagraphs } from './sync-harness.mjs'

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

const LANDING_YAML_KEYS = [
  'title',
  'description',
  'section',
  'order',
  'type',
  'audience',
  // Parsed so Word-flattened leftovers do not glue onto audience; never emitted.
  'owner',
  'sources',
  'lastVerified',
  'related'
]

function looksLikeFlattenedLandingYaml(text) {
  return /^title:\s+\S+.+\bdescription:\s+/s.test(String(text || '').trim())
}

function splitFlattenedYaml(text, keys) {
  const keyRe = new RegExp(`(?:^|\\s)(${keys.join('|')}):`, 'g')
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
  const values = {}
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index]
    const end = index + 1 < hits.length ? hits[index + 1].matchStart : text.length
    values[hit.key] = text.slice(hit.valueStart, end).trim()
  }
  return { hits, values }
}

function looksLikeSourcePath(text) {
  return (
    /^(src|tests|landing|resources|docs|scripts)\//.test(text) ||
    /^(package\.json|electron-builder\.yml|pnpm-lock\.yaml)$/.test(text) ||
    /\.(ts|tsx|js|mjs|astro|yml|md)$/.test(text)
  )
}

function looksLikeRelatedId(text) {
  return /^[a-z]+\/[a-z0-9-]+$/.test(text)
}

function wrapLandingInline(text) {
  const providerIds = new Set([
    'openai',
    'anthropic',
    'gemini',
    'ollama',
    'deepseek',
    'groq',
    'openrouter',
    'xai',
    'mistral',
    'custom',
    'opencode'
  ])
  let next = String(text ?? '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()
  next = next.replaceAll(
    'https://github.com/vyotiqai/vyotiq/releases/latest',
    'https://github.com/vyotiqai/vyotiq-agent-v/releases/latest'
  )
  next = next.replace(/\bhttps?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?(?:\/[^\s]*)?/gi, '`$&`')
  next = next.replace(/\b(pnpm pack:(?:win|mac|linux))\b/g, '`$1`')
  next = next.replace(/\bqwen2\.5\b/g, '`qwen2.5`')
  next = next.replace(/\bOpenAI-compatible\b/g, '\0OPENAI_COMPAT\0')
  next = next.replace(/\bOpenAI\b/g, '**OpenAI**')
  next = next.replace(/\bOpenRouter\b/g, '**OpenRouter**')
  next = next.replace(/\0OPENAI_COMPAT\0/g, 'OpenAI-compatible')
  next = next.replace(/\b(MCPs|Skills|Rules|Packages)\b/g, '**$1**')
  next = next.replace(/\b(Mutating tools|All tools|Not now)\b/g, '**$1**')
  next = next.replace(/\b(Ask for edits and commands|Ask for every tool|Active provider)\b/g, '**$1**')
  next = next.replace(/\bLocal rotating logs\b/g, '\0LOCAL_LOGS\0')
  next = next.replace(/\bLocal Ollama\b/g, '\0LOCAL_OLLAMA\0')
  next = next.replace(/\bLocal command\b/g, '\0LOCAL_CMD\0')
  next = next.replace(/\bLocal\b/g, '**Local**')
  next = next.replace(/\0LOCAL_LOGS\0/g, 'Local rotating logs')
  next = next.replace(/\0LOCAL_OLLAMA\0/g, 'Local Ollama')
  next = next.replace(/\0LOCAL_CMD\0/g, 'Local command')
  for (const phrase of [
    'Open a workspace to start chatting',
    'Add workspace',
    'Refresh models',
    'Tool approval',
    'Active menu'
  ]) {
    next = next.replaceAll(phrase, `\`${phrase}\``)
  }
  for (const [phrase, href] of [
    ['Settings → Providers', '/docs/customize/providers'],
    ['Settings → General', '/docs/reference/settings'],
    ['Settings → Tools', '/docs/reference/settings#tools'],
    ['Settings → Voice', '/docs/tools/voice-dictation'],
    ['Run, network, and recovery issues', '/docs/troubleshooting/runs-network-recovery']
  ]) {
    next = next.replaceAll(phrase, `[${phrase}](${href})`)
  }
  next = next.replace(/\bSee Providers\b/g, 'See [Providers](/docs/customize/providers)')
  next = next.replace(/\bOpen Changes\b/g, 'Open [Changes](/docs/tools/changes-git)')
  next = next.replace(/\bmode picker\b/g, '[mode picker](/docs/agent/modes)')
  next = next.replace(/\bKeep accepts\b/g, '`Keep` accepts')
  next = next.replace(/\bDiscard restores\b/g, '`Discard` restores')
  next = next.replace(/\buse Continue only\b/g, 'use `Continue` only')
  next = next.replace(/\bshows Continue unless\b/g, 'shows `Continue` unless')
  next = next.replace(/\bIf Continue repeats\b/g, 'If `Continue` repeats')
  next = next.replace(/\bPress Enter\b/g, 'Press `Enter`')
  next = next.replace(/\bStop or Esc\b/g, '**Stop** or `Esc`')
  next = next.replace(/\bnetwork_interrupted\b/g, 'Connection lost')
  next = next.replace(/\bcircuit_open\b/g, 'Temporarily paused')
  if (providerIds.has(next)) return `\`${next}\``
  next = next.replace(
    /(?<!`)\b(openai|anthropic|gemini|ollama|deepseek|groq|openrouter|xai|mistral|opencode)\b(?!`)/g,
    '`$1`'
  )
  const emDash = next.match(/^([A-Za-z][A-Za-z0-9_]*)( — [\s\S]+)$/)
  if (emDash && (/^[a-z][a-z0-9_]*$/.test(emDash[1]) || emDash[1] === 'Skill')) {
    return `\`${emDash[1]}\`${emDash[2]}`
  }
  if (
    next === 'Skill' ||
    /^(read|edit|search|glob|grep|delete|lsp|terminal|diagnostics)$/.test(next)
  ) {
    return `\`${next}\``
  }
  return next.replace(
    /(?<!`)\b([A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+)\b(?!`)/g,
    '`$1`'
  )
}

function looksLikeShellCommand(text) {
  return /^(pnpm|npm|npx|git|node|ollama)(\s|$)/.test(text) && text.length < 180
}

function looksLikeLabeledItem(text) {
  if (/^See\s/i.test(text)) return false
  if (/^Read-only\b/i.test(text)) return false
  if (/^Version,/i.test(text)) return false
  return /^.+ — \S/u.test(text) || /^[^:\n]{1,48}:\s+\S/.test(text)
}

function splitLabeledItem(text) {
  const em = String(text).match(/^(.+?) — (.+)$/u)
  if (em) return [em[1].trim(), em[2].trim()]
  const colon = String(text).match(/^([^:\n]{1,48}):\s+(.+)$/u)
  if (colon) return [colon[1].trim(), colon[2].trim()]
  return null
}

const SETTINGS_TABLE_SKIP = new Set(['Providers', 'Indexing', 'Tools', 'Shortcuts', 'About'])

function formatSettingsReference(markdown) {
  const parts = markdown.split(/\n(?=## )/)
  const intro = parts[0] ?? ''
  const sections = parts.slice(1).map((section) => {
    const lines = section.split('\n')
    const title = lines[0]?.replace(/^## /, '') ?? ''
    const rest = lines.slice(1).join('\n').trim()
    if (!title || SETTINGS_TABLE_SKIP.has(title)) return section

    const bullets = [...rest.matchAll(/^- (.+)$/gm)].map((match) => match[1] ?? '')
    if (bullets.length < 2) return section

    const rows = bullets.map((bullet) => splitLabeledItem(bullet)).filter(Boolean)
    if (rows.length < 2) return section

    const table = [
      '| Control | Options and notes |',
      '| --- | --- |',
      ...rows.map(([control, notes]) => `| ${control} | ${notes} |`)
    ].join('\n')
    return `## ${title}\n\n${table}\n`
  })
  return [intro, ...sections].join('\n')
}

function markdownTable(rows, wrapInline) {
  if (!rows.length) return ''
  const width = Math.max(...rows.map((row) => row.length), 0)
  const normalized = rows.map((row) => {
    const cells = row.map((cell) => {
      const cleaned = String(cell ?? '').replace(/[\u00a0\u200b]/g, ' ').replace(/\s+/g, ' ').trim()
      const text = wrapInline ? wrapInline(cleaned) : cleaned
      return String(text).replace(/\|/g, '\\|')
    })
    while (cells.length < width) cells.push('')
    return cells
  })
  let columns = width
  while (columns > 1 && normalized.every((row) => !row[columns - 1])) {
    for (const row of normalized) row.pop()
    columns -= 1
  }
  const header = normalized[0] ?? []
  if (!header.length) return ''
  const divider = header.map(() => '---')
  return [
    `| ${header.join(' | ')} |`,
    `| ${divider.join(' | ')} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(' | ')} |`)
  ].join('\n')
}

function markdownList(items) {
  return items
    .map((item) => {
      const pad = '  '.repeat(item.indent || 0)
      const mark = item.kind === 'number' ? '1.' : '-'
      return `${pad}${mark} ${item.text}`
    })
    .join('\n')
}

function blocksToMarkdown(blocks, wrapInline) {
  const out = []
  let listItems = []
  let labeledItems = []
  let yamlLines = null
  let promptLines = []
  let awaitingPrompt = false

  const looksLikePromptLead = (value) => /prompt/i.test(value) && /:\s*$/.test(value)
  const looksLikeDocsInstruction = (value) =>
    /^(Press |Select |Open |The |Verify |If |For |Use |Set |Return |New settings|Workspaces |Stop |Until |Read the assistant)/i.test(
      value
    )

  const flushPrompt = () => {
    if (promptLines.length) {
      out.push(`\`\`\`\n${promptLines.join(' ')}\n\`\`\``)
      promptLines = []
    }
    awaitingPrompt = false
  }

  const flushLabeled = () => {
    if (labeledItems.length >= 2) {
      const rows = labeledItems
        .map((item) => splitLabeledItem(item))
        .filter((row) => row != null)
      if (rows.length === labeledItems.length && rows.length >= 2) {
        out.push(
          [
            '| Control | Options and notes |',
            '| --- | --- |',
            ...rows.map(([control, notes]) => `| ${control} | ${notes} |`)
          ].join('\n')
        )
      } else {
        out.push(labeledItems.map((item) => `- ${item}`).join('\n'))
      }
    } else if (labeledItems.length === 1) {
      out.push(labeledItems[0])
    }
    labeledItems = []
  }

  const flushList = () => {
    if (listItems.length) {
      out.push(markdownList(listItems))
      listItems = []
    }
  }

  const flushYaml = () => {
    if (!yamlLines) return
    if (yamlLines.length) {
      out.push(['```yaml', '---', ...yamlLines, '---', '```'].join('\n'))
    }
    yamlLines = null
  }

  const flushAll = () => {
    flushPrompt()
    flushList()
    flushLabeled()
    flushYaml()
  }

  for (const block of blocks) {
    if (yamlLines) {
      if (block.type === 'table' || headingLevel(block.style) > 0) {
        flushYaml()
      } else {
        const yamlText = block.text?.trim() ?? ''
        if (yamlText === '---') {
          flushYaml()
          continue
        }
        if (!yamlText) continue
        yamlLines.push(yamlText)
        continue
      }
    }
    if (block.type === 'table') {
      flushAll()
      const table = markdownTable(block.rows, wrapInline)
      if (table) out.push(table)
      continue
    }
    const text = block.text?.trim() ?? ''
    const level = headingLevel(block.style)
    if (level > 0) {
      flushAll()
      const headingText = text.replace(/^\d+\.\s+/, '')
      out.push(`${'#'.repeat(Math.min(level, 6))} ${headingText}`)
      continue
    }
    if (text === '---') {
      flushPrompt()
      flushList()
      flushLabeled()
      yamlLines = []
      continue
    }
    if (!text) continue

    if (block.list) {
      flushPrompt()
      flushLabeled()
      listItems.push({
        indent: block.list.indent || 0,
        kind: block.list.kind,
        text: wrapInline(text)
      })
      continue
    }

    flushList()
    if (looksLikeShellCommand(text)) {
      flushPrompt()
      flushLabeled()
      out.push(`\`\`\`bash\n${text}\n\`\`\``)
      continue
    }
    if (awaitingPrompt) {
      if (looksLikeDocsInstruction(text) && promptLines.length > 0) {
        flushPrompt()
      } else {
        promptLines.push(text)
        continue
      }
    }
    const wrapped = wrapInline(text)
    if (looksLikePromptLead(text)) {
      flushLabeled()
      out.push(wrapped)
      awaitingPrompt = true
      continue
    }
    if (looksLikeLabeledItem(text)) {
      labeledItems.push(wrapped)
      continue
    }
    flushLabeled()
    out.push(wrapped)
  }
  flushAll()
  return out.join('\n\n')
}

function landingDocxToMarkdown(blocks) {
  let index = 0
  while (index < blocks.length) {
    const block = blocks[index]
    if (!block || block.type === 'table') break
    if (block.text) break
    index += 1
  }
  const first = blocks[index]?.type === 'table' ? '' : (blocks[index]?.text?.trim() ?? '')
  if (!looksLikeFlattenedLandingYaml(first)) {
    return skillDocxToMarkdown(
      blocks.flatMap((block) => {
        if (block.type === 'table') {
          return block.rows.flatMap((row) =>
            row.filter(Boolean).map((text) => ({ style: '', text, border: false }))
          )
        }
        return [{ style: block.style, text: block.text, border: block.border }]
      })
    )
  }

  const { values } = splitFlattenedYaml(first, LANDING_YAML_KEYS)
  index += 1
  const related = []

  while (index < blocks.length) {
    const block = blocks[index]
    if (!block || block.type === 'table') break
    const text = block.text?.trim() ?? ''
    if (headingLevel(block.style) > 0) break
    if (!text) {
      index += 1
      continue
    }
    const glued = text.match(/^(.*?)\s+lastVerified:\s+(\S+)\s+related:\s*$/)
    if (glued) {
      index += 1
      continue
    }
    if (looksLikeSourcePath(text)) {
      index += 1
      continue
    }
    if (looksLikeRelatedId(text)) {
      related.push(text)
      index += 1
      continue
    }
    break
  }

  const yaml = [
    `title: ${values.title ?? ''}`.trimEnd(),
    `description: ${values.description ?? ''}`.trimEnd(),
    `section: ${values.section ?? ''}`.trimEnd(),
    `order: ${values.order ?? ''}`.trimEnd(),
    `type: ${values.type ?? ''}`.trimEnd(),
    `audience: ${values.audience ?? ''}`.trimEnd(),
    'related:',
    ...related.map((item) => `  - ${item}`)
  ].join('\n')

  const body = blocksToMarkdown(blocks.slice(index), wrapLandingInline)
  return `---\n${yaml}\n---\n\n${body}${body.endsWith('\n') ? '' : '\n'}`
}

function attachmentsMarkdownTable() {
  return [
    '| Kind | Count | Per-item raw size | Processing |',
    '| --- | --- | --- | --- |',
    '| Extracted file | 5 | 8 MB | Main process extracts text; retained text caps at 120,000 characters |',
    '| Image | 4 | 12 MB | Image data URL; requires compatible model input |',
    '| Audio | 2 | 16 MB | Inline audio part; requires compatible provider/model handling |'
  ].join('\n')
}

function docxToText(docxPath) {
  const buf = readFileSync(docxPath)
  const rel = path.relative(root, docxPath).replace(/\\/g, '/')
  if (path.basename(docxPath).toLowerCase() === 'skill.md.docx') {
    return skillDocxToMarkdown(docxParagraphs(buf))
  }
  if (rel.startsWith('landing/src/content/')) {
    let markdown = landingDocxToMarkdown(docxBlocks(buf))
    if (rel.endsWith('/settings.md.docx')) {
      const split = markdown.split(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m)
      if (split.length > 1) {
        const frontmatter = markdown.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/m)?.[0] ?? ''
        const body = split.slice(1).join('')
        markdown = `${frontmatter}${formatSettingsReference(body)}`
      }
    }
    if (rel.endsWith('/attachments.md.docx') && !markdown.includes('| Extracted file |')) {
      markdown = markdown.replace(
        '\n---\n\n',
        `\n---\n\n${attachmentsMarkdownTable()}\n\n`
      )
    }
    return markdown
  }
  if (rel === 'landing/README.md.docx') {
    const markdown = blocksToMarkdown(docxBlocks(buf), (text) => text)
    return markdown.endsWith('\n') ? markdown : `${markdown}\n`
  }
  return `${docxParagraphs(buf)
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n\n')}\n`
}

const TARGET_DIRS = [
  path.join(root, 'tests', 'fixtures'),
  path.join(root, 'landing', 'src', 'content'),
  path.join(root, 'resources', 'marketplace')
]

/** Remaining single-file conversion outside TARGET_DIRS. */
const ROOT_FILES = [
  [path.join('landing', 'README.md.docx'), path.join('landing', 'README.md')]
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
  for (const [srcRel, outRel] of ROOT_FILES) {
    const src = path.join(root, srcRel)
    const out = path.join(root, outRel)
    let text
    try {
      text = docxToText(src)
    } catch {
      continue
    }
    if (outRel.replace(/\\/g, '/') === 'landing/README.md' && !text.startsWith('# ')) {
      const nl = text.indexOf('\n')
      text = nl < 0 ? `# ${text}` : `# ${text.slice(0, nl)}${text.slice(nl)}`
    }
    let existing = null
    try {
      existing = readFileSync(out, 'utf8')
    } catch {
      /* first run */
    }
    if (existing !== text) {
      writeFileSync(out, text, 'utf8')
      written++
      console.log(`[sync-docx-md] ${outRel}`)
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
