/**
 * Validate the canonical plain-text runtime harness.
 *
 * resources/harness/default.md is source of truth. This script intentionally
 * never reads a Word copy and never rewrites harness policy.
 *
 * docxParagraphs remains exported for scripts/sync-docx-md.mjs, which converts
 * unrelated documentation and fixture assets.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(__dirname, '..')

/** Minimal ZIP reader used by the separate documentation conversion script. */
export function readZipEntry(buf, wantedName) {
  let eocd = -1
  const minEocd = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD)')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(ptr) !== 0x02014b50) throw new Error('bad central directory')
    const method = buf.readUInt16LE(ptr + 10)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
    if (name === wantedName) {
      if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('bad local header')
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const raw = buf.subarray(dataStart, dataStart + compressedSize)
      if (method === 0) return Buffer.from(raw)
      if (method === 8) return inflateRawSync(raw)
      throw new Error(`unsupported zip compression method: ${method}`)
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip entry not found: ${wantedName}`)
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

function decodeRuns(paragraphXml) {
  const withoutBreaks = paragraphXml.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, ' ')
  const runs = []
  const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let match
  while ((match = runRe.exec(withoutBreaks)) !== null) runs.push(match[1])
  return unescapeXml(runs.join(''))
}

function headingStyle(paragraphXml) {
  return paragraphXml.match(/<w:pStyle w:val="([^"]+)"/)?.[1] ?? ''
}

function parseNumbering(numberingXml) {
  const abstracts = new Map()
  const abstractRe = /<w:abstractNum w:abstractNumId="(\d+)"[\s\S]*?<\/w:abstractNum>/g
  let abstractMatch
  while ((abstractMatch = abstractRe.exec(numberingXml))) {
    const levels = new Map()
    const levelRe = /<w:lvl w:ilvl="(\d+)"[\s\S]*?<\/w:lvl>/g
    let levelMatch
    while ((levelMatch = levelRe.exec(abstractMatch[0]))) {
      const fmt = levelMatch[0].match(/<w:numFmt w:val="([^"]+)"/)?.[1] ?? 'bullet'
      levels.set(Number(levelMatch[1]), fmt === 'decimal' || fmt === 'lowerLetter' || fmt === 'upperLetter' || fmt === 'lowerRoman' || fmt === 'upperRoman' ? 'number' : 'bullet')
    }
    abstracts.set(abstractMatch[1], levels)
  }
  const instances = new Map()
  const numRe = /<w:num w:numId="(\d+)"[\s\S]*?<\/w:num>/g
  let numMatch
  while ((numMatch = numRe.exec(numberingXml))) {
    const abstractId = numMatch[0].match(/<w:abstractNumId w:val="(\d+)"/)?.[1]
    instances.set(numMatch[1], abstracts.get(abstractId) ?? new Map())
  }
  return {
    kind(numId, ilvl) {
      return instances.get(String(numId))?.get(Number(ilvl)) ?? 'bullet'
    }
  }
}

function listInfo(paragraphXml, numbering) {
  const numId = paragraphXml.match(/<w:numId w:val="([^"]+)"/)?.[1]
  const ilvl = Number(paragraphXml.match(/<w:ilvl w:val="([^"]+)"/)?.[1] ?? 0)
  const style = headingStyle(paragraphXml)
  if (numId) {
    return { kind: numbering?.kind(numId, ilvl) ?? 'bullet', indent: ilvl }
  }
  if (/listparagraph|listbullet/i.test(style)) return { kind: 'bullet', indent: 0 }
  if (/listnumber/i.test(style)) return { kind: 'number', indent: 0 }
  return null
}

function parseParagraphBlock(paragraphXml, numbering) {
  const text = decodeRuns(paragraphXml).trim()
  const border = /<w:pBdr[\s>]/.test(paragraphXml)
  const style = headingStyle(paragraphXml)
  const list = listInfo(paragraphXml, numbering)
  return { type: 'p', style, text, border, list }
}

function parseTableBlock(tableXml) {
  const rows = []
  for (const rowChunk of tableXml.split('</w:tr>')) {
    if (!/<w:tr[\s>]/.test(rowChunk)) continue
    const cells = []
    for (const cellChunk of rowChunk.split('</w:tc>')) {
      if (!/<w:tc[\s>]/.test(cellChunk)) continue
      const paras = []
      for (const paraChunk of cellChunk.split('</w:p>')) {
        const openIndex = paraChunk.search(/<w:p(?:\s[^>]*)?>/)
        if (openIndex < 0) continue
        const text = decodeRuns(paraChunk.slice(openIndex)).trim()
        if (text) paras.push(text)
      }
      cells.push(paras.join(' / '))
    }
    if (cells.length) rows.push(cells)
  }
  return { type: 'table', rows }
}

function loadNumbering(docxBuf) {
  try {
    return parseNumbering(readZipEntry(docxBuf, 'word/numbering.xml').toString('utf8'))
  } catch {
    return null
  }
}

/** Ordered body blocks (paragraphs and tables) for documentation conversion. */
export function docxBlocks(docxBuf) {
  const xml = readZipEntry(docxBuf, 'word/document.xml').toString('utf8')
  const numbering = loadNumbering(docxBuf)
  const body = xml.match(/<w:body\b[^>]*>([\s\S]*)<\/w:body>/)?.[1] ?? xml
  const blocks = []
  let index = 0
  while (index < body.length) {
    const tableAt = body.indexOf('<w:tbl', index)
    const rest = body.slice(index)
    const paragraphOffset = rest.search(/<w:p[\s>]/)
    const paragraphAt = paragraphOffset < 0 ? -1 : index + paragraphOffset
    if (tableAt < 0 && paragraphAt < 0) break
    const takeTable = tableAt >= 0 && (paragraphAt < 0 || tableAt < paragraphAt)
    if (takeTable) {
      const end = body.indexOf('</w:tbl>', tableAt)
      if (end < 0) break
      const table = parseTableBlock(body.slice(tableAt, end + '</w:tbl>'.length))
      if (table.rows.length) blocks.push(table)
      index = end + '</w:tbl>'.length
      continue
    }
    const end = body.indexOf('</w:p>', paragraphAt)
    if (end < 0) break
    const paragraph = parseParagraphBlock(body.slice(paragraphAt, end + '</w:p>'.length), numbering)
    if (paragraph.text || paragraph.border) blocks.push(paragraph)
    index = end + '</w:p>'.length
  }
  return blocks
}

/** Paragraph blocks consumed only by scripts/sync-docx-md.mjs. */
export function docxParagraphs(docxBuf) {
  return docxBlocks(docxBuf).flatMap((block) => {
    if (block.type === 'table') {
      return block.rows.flatMap((row) =>
        row.filter(Boolean).map((text) => ({ style: '', text, border: false }))
      )
    }
    return [{ style: block.style, text: block.text, border: block.border }]
  })
}

export const REQUIRED_HARNESS_SECTION_TAGS = [
  'role',
  'capabilities',
  'tool_policy',
  'constraints',
  'work_style',
  'memory',
  'output_format'
]

export function validateHarnessMarkdown(text) {
  const errors = []
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n')
  if (!normalized.startsWith('# Agent V\n')) errors.push('must start with "# Agent V"')
  text = normalized
  if (/^##\s+/m.test(text)) errors.push('must use section tags, not level-two headings')
  if (text.includes('<workspace_harness>') || text.includes('</workspace_harness>')) {
    errors.push('must not wrap the canonical spine as a workspace appendix')
  }
  for (const tag of REQUIRED_HARNESS_SECTION_TAGS) {
    const opens = text.match(new RegExp(`<${tag}>`, 'g'))?.length ?? 0
    const closes = text.match(new RegExp(`</${tag}>`, 'g'))?.length ?? 0
    if (opens !== 1 || closes !== 1) errors.push(`<${tag}> must appear exactly once as a pair`)
  }
  return errors
}

function main() {
  const harnessPath = path.join(ROOT, 'resources', 'harness', 'default.md')
  const errors = validateHarnessMarkdown(readFileSync(harnessPath, 'utf8'))
  if (errors.length > 0) {
    throw new Error(`invalid canonical harness:\n- ${errors.join('\n- ')}`)
  }
  console.log('[sync-harness] canonical resources/harness/default.md is valid')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (err) {
    console.error('[sync-harness] failed:', err)
    process.exit(1)
  }
}
