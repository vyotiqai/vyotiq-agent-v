import { resolveInsideWorkspace } from '../../workspace/safePath'
import { existsSync, readdirSync, statSync, promises as fsp } from 'fs'
import { basename, dirname, join } from 'path'
import {
  extractDocxText,
  isDocxPath,
  MAX_DOCX_ARCHIVE_BYTES
} from './docxText'

const SUGGEST_CAP = 8
const LINE_STREAM_CHUNK = 64 * 1024
/** Default (no-window) read cap: larger files return a bounded line window. */
export const READ_DEFAULT_MAX_LINES = 2000

export type ReadOptions = {
  offset?: number
  limit?: number
  startLine?: number
  endLine?: number
}

async function listDirectoryEntries(resolved: string, relPath: string): Promise<string> {
  const entries = (await fsp.readdir(resolved, { withFileTypes: true })).map(
    (e) => `${e.isDirectory() ? '[dir]' : '[file]'} ${e.name}`
  )
  return [
    `Path is a directory, not a file: ${relPath}`,
    'Contents:',
    ...entries,
    'Use read on a file path, or list_dir / glob / search to explore further.'
  ]
    .filter(Boolean)
    .join('\n')
}

function suggestSimilarPaths(workspaceRoot: string, relPath: string): string[] {
  const parent = dirname(relPath)
  const target = basename(relPath).toLowerCase()
  const parentResolved =
    parent === '.' ? workspaceRoot : resolveInsideWorkspace(workspaceRoot, parent)
  if (!existsSync(parentResolved)) return []
  try {
    const names = readdirSync(parentResolved)
    const fuzzy = names
      .filter((name) => {
        const lower = name.toLowerCase()
        const targetStem = target.replace(/\.[^.]+$/, '')
        const nameStem = lower.replace(/\.[^.]+$/, '')
        return (
          lower.includes(target) ||
          target.includes(nameStem) ||
          nameStem.includes(targetStem) ||
          targetStem.includes(nameStem)
        )
      })
      .slice(0, SUGGEST_CAP)
      .map((name) => (parent === '.' ? name : join(parent, name)).replace(/\\/g, '/'))
    if (fuzzy.length) return fuzzy
    return names
      .slice(0, SUGGEST_CAP)
      .map((name) => (parent === '.' ? name : join(parent, name)).replace(/\\/g, '/'))
  } catch {
    return []
  }
}

/** Decode text files; UTF-16 BOM (common for PowerShell logs) before binary rejection. */
function isUtf16Bom(buf: Buffer): boolean {
  return (
    buf.length >= 2 &&
    ((buf[0] === 0xff && buf[1] === 0xfe) || (buf[0] === 0xfe && buf[1] === 0xff))
  )
}

function decodeTextBuffer(buf: Buffer, pathArg: string, encoding: 'utf8' | 'utf16le' = 'utf8'): string {
  if (encoding === 'utf16le') {
    return buf.toString('utf16le')
  }
  if (buf.length >= 2) {
    if (buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le')
    }
    if (buf[0] === 0xfe && buf[1] === 0xff) {
      const body = buf.subarray(2)
      const le = Buffer.allocUnsafe(body.length)
      for (let i = 0; i + 1 < body.length; i += 2) {
        le[i] = body[i + 1]!
        le[i + 1] = body[i]!
      }
      return le.toString('utf16le')
    }
  }
  if (buf.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }
  return buf.toString('utf8')
}

function formatMissingFileHint(workspaceRoot: string, relPath: string): string {
  const suggestions = suggestSimilarPaths(workspaceRoot, relPath)
  if (!suggestions.length) {
    return `File not found: ${relPath}. Verify the path exists in this workspace.`
  }
  return [
    `File not found: ${relPath}`,
    'Similar names in parent directory:',
    ...suggestions.map((s) => `- ${s}`)
  ].join('\n')
}

/** Shared by read/delete so missing-path errors stay consistent for the model. */
export function missingPathHint(workspaceRoot: string, relPath: string): string {
  return formatMissingFileHint(workspaceRoot, relPath)
}

/** list_dir missing-folder errors: workspace-relative, plus parent-dir names / glob hint. */
export function missingDirectoryHint(
  workspaceRoot: string,
  pathArg: string,
  relDir: string,
  nestedRels: string[] = []
): string {
  const leaf = (relDir || pathArg).replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? pathArg
  const lines = [
    `Directory not found: ${pathArg}. Paths are relative to the workspace root.`
  ]
  if (nestedRels.length > 0) {
    lines.push('Nested matches:', ...nestedRels.map((s) => `- ${s}`))
  } else {
    const suggestions = suggestSimilarPaths(workspaceRoot, relDir || pathArg)
    if (suggestions.length > 0) {
      lines.push('Similar names in parent directory:', ...suggestions.map((s) => `- ${s}`))
    }
  }
  if (leaf && leaf !== '.' && !/[*?]/.test(leaf)) {
    lines.push(`If it is nested, glob **/${leaf} or list_dir from '.' first.`)
  }
  return lines.join('\n')
}

export async function toolRead(
  workspaceRoot: string,
  pathArg: string,
  options: ReadOptions = {}
): Promise<string> {
  const resolved = resolveInsideWorkspace(workspaceRoot, pathArg)
  if (!existsSync(resolved)) {
    throw new Error(formatMissingFileHint(workspaceRoot, pathArg))
  }
  const st = statSync(resolved)
  if (st.isDirectory()) {
    return listDirectoryEntries(resolved, pathArg)
  }
  if (!st.isFile()) {
    throw new Error(`Not a file: ${pathArg}`)
  }

  if (isDocxPath(pathArg)) {
    return readDocx(resolved, pathArg, st.size, options)
  }

  if (options.startLine !== undefined || options.endLine !== undefined) {
    return readLineRange(resolved, pathArg, st.size, options)
  }

  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = options.limit === undefined ? undefined : Math.trunc(options.limit)

  if (limit !== undefined || offset > 0) {
    return readByteRange(resolved, pathArg, st.size, offset, limit)
  }

  return readDefaultWindow(resolved, pathArg, st.size)
}

/** Word .docx is a zip; extract paragraph text, then apply line/byte windows. */
async function readDocx(
  resolved: string,
  pathArg: string,
  size: number,
  options: ReadOptions
): Promise<string> {
  if (size > MAX_DOCX_ARCHIVE_BYTES) {
    throw new Error(`Word .docx too large to extract: ${pathArg} (${size} bytes).`)
  }
  const buf = await fsp.readFile(resolved)
  let text: string
  try {
    text = extractDocxText(buf)
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Binary file detected: ${pathArg}. Word .docx text extraction failed (${reason}).`
    )
  }
  if (!text.trim()) {
    text = '(no extractable text in Word document)'
  }
  return applyTextReadWindows(text, pathArg, options)
}

function applyTextReadWindows(text: string, pathArg: string, options: ReadOptions): string {
  if (options.startLine !== undefined || options.endLine !== undefined) {
    return sliceTextLineRange(text, pathArg, options)
  }
  const offset = Math.max(0, Math.trunc(options.offset ?? 0))
  const limit = options.limit === undefined ? undefined : Math.trunc(options.limit)
  if (limit !== undefined || offset > 0) {
    const buf = Buffer.from(text, 'utf8')
    if (offset > buf.length) {
      throw new Error(`offset ${offset} is past the end of ${pathArg} (${buf.length} bytes).`)
    }
    const remaining = Math.max(0, buf.length - offset)
    const want = limit === undefined ? remaining : Math.min(Math.max(0, limit), remaining)
    const header = `--- offset ${offset}${limit !== undefined ? `, limit ${limit}` : ''} of ${buf.length} bytes ---\n`
    return header + buf.subarray(offset, offset + want).toString('utf8')
  }
  return text
}

function sliceTextLineRange(text: string, pathArg: string, options: ReadOptions): string {
  const raw = text.split('\n')
  const lines =
    raw.length > 0 && text.endsWith('\n') && raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw
  const total = Math.max(1, lines.length)
  const startRaw = Math.max(1, Math.trunc(options.startLine ?? 1))
  const endRaw =
    options.endLine == null ? Number.POSITIVE_INFINITY : Math.trunc(options.endLine)
  const start = Number.isFinite(endRaw) && endRaw < startRaw ? Math.max(1, endRaw) : startRaw
  const endLimit = Number.isFinite(endRaw) && endRaw < startRaw ? startRaw : endRaw
  if (start > total) {
    throw new Error(`startLine ${start} is past the end of ${pathArg} (${total} lines).`)
  }
  const actualEnd = Math.min(endLimit, total)
  const collected = lines.slice(start - 1, actualEnd)
  return `--- lines ${start}-${actualEnd} of ${total} ---\n` + collected.join('\n')
}

/**
 * Read a byte window without loading the whole file.
 */
async function readByteRange(
  resolved: string,
  pathArg: string,
  size: number,
  offset: number,
  limit: number | undefined
): Promise<string> {
  if (offset > size) {
    throw new Error(`offset ${offset} is past the end of ${pathArg} (${size} bytes).`)
  }
  const remaining = Math.max(0, size - offset)
  const want = limit === undefined ? remaining : Math.min(Math.max(0, limit), remaining)
  const buf = Buffer.alloc(want)
  const fh = await fsp.open(resolved, 'r')
  let read: number
  try {
    read = want > 0 ? (await fh.read(buf, 0, want, offset)).bytesRead : 0
  } finally {
    await fh.close()
  }
  const slice = buf.subarray(0, read)
  // A window starting mid-file has no BOM to inspect; only offset 0 can be UTF-16.
  const utf16 = offset === 0 && isUtf16Bom(slice)
  if (!utf16 && slice.includes(0)) {
    throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
  }
  const header = `--- offset ${offset}${limit !== undefined ? `, limit ${limit}` : ''} of ${size} bytes ---\n`
  const body = utf16 ? decodeTextBuffer(slice, pathArg) : slice.toString('utf8')
  return header + body
}

type LineEncoding = 'utf8' | 'utf16le' | 'utf16be'

function detectLineEncoding(head: Buffer): { encoding: LineEncoding; skip: number } {
  if (head.length >= 2 && head[0] === 0xff && head[1] === 0xfe) {
    return { encoding: 'utf16le', skip: 2 }
  }
  if (head.length >= 2 && head[0] === 0xfe && head[1] === 0xff) {
    return { encoding: 'utf16be', skip: 2 }
  }
  return { encoding: 'utf8', skip: 0 }
}

function decodeLineBytes(buf: Buffer, encoding: LineEncoding): string {
  if (encoding === 'utf8') return buf.toString('utf8')
  if (encoding === 'utf16le') return buf.toString('utf16le')
  const le = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i + 1 < buf.length; i += 2) {
    le[i] = buf[i + 1]!
    le[i + 1] = buf[i]!
  }
  return le.toString('utf16le')
}

function splitCompleteLines(
  text: string
): { lines: string[]; leftover: string } {
  const parts = text.split('\n')
  const leftover = parts.pop() ?? ''
  return { lines: parts, leftover }
}

/**
 * Index where the last complete '\n' starts in `raw`, or -1. utf16 newline
 * detection only considers even indices so code units stay file-aligned.
 */
function lastNewlineStart(raw: Buffer, encoding: LineEncoding): number {
  if (encoding === 'utf8') return raw.lastIndexOf(0x0a)
  const lastEven = raw.length % 2 === 0 ? raw.length - 2 : raw.length - 3
  if (encoding === 'utf16le') {
    for (let i = lastEven; i >= 0; i -= 2) {
      if (raw[i] === 0x0a && raw[i + 1] === 0x00) return i
    }
  } else {
    for (let i = lastEven; i >= 0; i -= 2) {
      if (raw[i] === 0x00 && raw[i + 1] === 0x0a) return i
    }
  }
  return -1
}

/**
 * Stream lines without loading the whole file into a string.
 * Lines are 1-based; `[start, endLimit]` is the inclusive window whose lines
 * are collected (up to `maxCollected`), while `total` keeps counting every
 * line so callers can name the real total. Decoding cuts at complete newlines
 * so a multi-byte UTF-8 character straddling a chunk boundary stays intact.
 */
async function streamLines(
  resolved: string,
  pathArg: string,
  size: number,
  start: number,
  endLimit: number,
  maxCollected: number
): Promise<{ collected: string[]; total: number; trailingNewline: boolean }> {
  const fh = await fsp.open(resolved, 'r')
  try {
    const peek = Buffer.alloc(Math.min(4, size))
    const peeked = size > 0 ? (await fh.read(peek, 0, peek.length, 0)).bytesRead : 0
    const { encoding, skip } = detectLineEncoding(peek.subarray(0, peeked))
    const unit = encoding === 'utf8' ? 1 : 2

    let leftoverBytes = Buffer.alloc(0)
    let leftoverText = ''
    let offset = skip
    let lineNo = 0
    let total = 0
    let sawNul = false
    let trailingNewline = false
    const collected: string[] = []
    const pushLine = (line: string): void => {
      lineNo += 1
      total = lineNo
      if (lineNo >= start && lineNo <= endLimit && collected.length < maxCollected) {
        collected.push(line)
      }
    }

    while (offset < size) {
      const want = Math.min(LINE_STREAM_CHUNK, size - offset)
      const aligned = unit === 1 ? want : want - (want % 2)
      if (aligned <= 0) break
      const buf = Buffer.alloc(aligned)
      const n = (await fh.read(buf, 0, aligned, offset)).bytesRead
      if (n <= 0) break
      offset += n
      const raw = Buffer.concat([leftoverBytes, buf.subarray(0, n)])
      if (encoding === 'utf8' && raw.includes(0)) {
        sawNul = true
        break
      }
      const cut = lastNewlineStart(raw, encoding)
      if (cut >= 0) {
        const complete = cut + (encoding === 'utf8' ? 1 : 2)
        const decoded = leftoverText + decodeLineBytes(raw.subarray(0, complete), encoding)
        leftoverBytes = raw.subarray(complete)
        leftoverText = ''
        trailingNewline = true
        // decoded ends with '\n', so the split leftover is always empty here.
        for (const line of splitCompleteLines(decoded).lines) pushLine(line)
      } else if (encoding === 'utf8') {
        // No complete newline yet: hold raw bytes so a multi-byte character
        // straddling the chunk boundary decodes with its continuation bytes.
        leftoverBytes = raw
      } else {
        const take = raw.length - (raw.length % unit)
        leftoverBytes = raw.subarray(take)
        const decoded = leftoverText + decodeLineBytes(raw.subarray(0, take), encoding)
        const split = splitCompleteLines(decoded)
        leftoverText = split.leftover
        trailingNewline = false
        for (const line of split.lines) pushLine(line)
      }
    }

    if (sawNul) {
      throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
    }

    if (leftoverBytes.length > 0 && encoding === 'utf8' && leftoverBytes.includes(0)) {
      throw new Error(`Binary file detected: ${pathArg}. Read is text-only.`)
    }

    if (leftoverText.length > 0 || leftoverBytes.length > 0) {
      const tail =
        leftoverText +
        (leftoverBytes.length > 0 ? decodeLineBytes(leftoverBytes, encoding) : '')
      pushLine(tail)
      trailingNewline = false
    } else if (total === 0) {
      // Empty file (or BOM-only): one empty line, matching split('\n') on ''.
      total = 1
      if (start === 1 && endLimit >= 1 && maxCollected >= 1) collected.push('')
    }

    return { collected, total, trailingNewline }
  } finally {
    await fh.close()
  }
}

/**
 * Default (no-window) read. Files at or under READ_DEFAULT_MAX_LINES keep the
 * exact full-text output (no header); larger files return the first
 * READ_DEFAULT_MAX_LINES lines with a header naming the total and a hint.
 */
async function readDefaultWindow(
  resolved: string,
  pathArg: string,
  size: number
): Promise<string> {
  const cap = READ_DEFAULT_MAX_LINES
  const { collected, total, trailingNewline } = await streamLines(
    resolved,
    pathArg,
    size,
    1,
    Number.POSITIVE_INFINITY,
    cap
  )
  if (total <= cap) {
    // Byte-identical with a full read: no header, trailing newline preserved.
    return collected.join('\n') + (trailingNewline ? '\n' : '')
  }
  return (
    `--- lines 1-${cap} of ${total} ---\n` +
    collected.join('\n') +
    `\n… read truncated at ${cap} lines; pass startLine/endLine to read further.`
  )
}

/**
 * Stream an inclusive, 1-based line range without loading the whole file into a string.
 * The header names the range actually returned.
 */
async function readLineRange(
  resolved: string,
  pathArg: string,
  size: number,
  options: ReadOptions
): Promise<string> {
  const startRaw = Math.max(1, Math.trunc(options.startLine ?? 1))
  const endRaw =
    options.endLine == null ? Number.POSITIVE_INFINITY : Math.trunc(options.endLine)
  const start = Number.isFinite(endRaw) && endRaw < startRaw ? Math.max(1, endRaw) : startRaw
  const endLimit = Number.isFinite(endRaw) && endRaw < startRaw ? startRaw : endRaw

  const { collected, total } = await streamLines(
    resolved,
    pathArg,
    size,
    start,
    endLimit,
    Number.POSITIVE_INFINITY
  )

  // A trailing newline terminates the last line rather than starting a new one.
  // streamLines pops the final empty split piece into leftoverText and only
  // counts it when leftover text/bytes are non-empty — matching split('\n')+pop.

  if (start > total) {
    throw new Error(`startLine ${start} is past the end of ${pathArg} (${total} lines).`)
  }

  const actualEnd = Math.min(endLimit, total)
  return `--- lines ${start}-${actualEnd} of ${total} ---\n` + collected.join('\n')
}
