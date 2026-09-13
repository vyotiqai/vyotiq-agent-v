import { inflateRawSync } from 'zlib'

/** Zip archive cap for Word .docx opened by `read`. */
export const MAX_DOCX_ARCHIVE_BYTES = 32 * 1024 * 1024
/** Inflated `word/document.xml` cap (zip-bomb guard). */
export const MAX_DOCX_ENTRY_BYTES = 8 * 1024 * 1024

const EOCD_SIG = 0x06054b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50
const ZIP64_SIZE = 0xffffffff

export function isDocxPath(pathArg: string): boolean {
  return /\.docx$/i.test(pathArg.replace(/\\/g, '/'))
}

/**
 * Minimal ZIP reader (stored / deflate), same approach as scripts/sync-harness.mjs.
 * Only `word/document.xml` is requested — nothing is written to disk.
 */
export function readZipEntry(buf: Buffer, wantedName: string): Buffer {
  let eocd = -1
  const minEocd = Math.max(0, buf.length - 66_000)
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('not a zip archive (no EOCD)')

  const entryCount = buf.readUInt16LE(eocd + 10)
  let ptr = buf.readUInt32LE(eocd + 16)
  for (let n = 0; n < entryCount; n++) {
    if (ptr + 46 > buf.length || buf.readUInt32LE(ptr) !== CENTRAL_SIG) {
      throw new Error('bad central directory')
    }
    const method = buf.readUInt16LE(ptr + 10)
    const compressedSize = buf.readUInt32LE(ptr + 20)
    const uncompressedSize = buf.readUInt32LE(ptr + 24)
    const nameLen = buf.readUInt16LE(ptr + 28)
    const extraLen = buf.readUInt16LE(ptr + 30)
    const commentLen = buf.readUInt16LE(ptr + 32)
    const localOffset = buf.readUInt32LE(ptr + 42)
    if (
      compressedSize === ZIP64_SIZE ||
      uncompressedSize === ZIP64_SIZE ||
      localOffset === ZIP64_SIZE
    ) {
      throw new Error('zip64 archives are not supported')
    }
    const nameEnd = ptr + 46 + nameLen
    if (nameEnd > buf.length) throw new Error('bad central directory name')
    const name = buf.toString('utf8', ptr + 46, nameEnd)
    if (name === wantedName) {
      if (uncompressedSize > MAX_DOCX_ENTRY_BYTES || compressedSize > MAX_DOCX_ENTRY_BYTES) {
        throw new Error('zip entry too large')
      }
      if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOCAL_SIG) {
        throw new Error('bad local header')
      }
      const localNameLen = buf.readUInt16LE(localOffset + 26)
      const localExtraLen = buf.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLen + localExtraLen
      const dataEnd = dataStart + compressedSize
      if (dataEnd > buf.length) throw new Error('truncated zip entry')
      const raw = buf.subarray(dataStart, dataEnd)
      if (method === 0) {
        if (raw.length > MAX_DOCX_ENTRY_BYTES) throw new Error('zip entry too large')
        return Buffer.from(raw)
      }
      if (method === 8) {
        return inflateRawSync(raw, { maxOutputLength: MAX_DOCX_ENTRY_BYTES })
      }
      throw new Error(`unsupported zip compression method: ${method}`)
    }
    ptr += 46 + nameLen + extraLen + commentLen
  }
  throw new Error(`zip entry not found: ${wantedName}`)
}

function unescapeXml(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
}

function decodeRuns(paragraphXml: string): string {
  const withoutBreaks = paragraphXml.replace(/<w:br\s*\/>/g, '\n').replace(/<w:tab\s*\/>/g, ' ')
  const runs: string[] = []
  const runRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
  let match: RegExpExecArray | null
  while ((match = runRe.exec(withoutBreaks)) !== null) runs.push(match[1] ?? '')
  return unescapeXml(runs.join(''))
}

/** Extract paragraph text from a Word .docx buffer (OOXML zip). */
export function extractDocxText(buf: Buffer): string {
  if (buf.length > MAX_DOCX_ARCHIVE_BYTES) {
    throw new Error(`archive larger than ${MAX_DOCX_ARCHIVE_BYTES} bytes`)
  }
  const xml = readZipEntry(buf, 'word/document.xml').toString('utf8')
  if (xml.length > MAX_DOCX_ENTRY_BYTES) {
    throw new Error('document.xml too large')
  }
  const paras: string[] = []
  const pRe = /<w:p[\s>][\s\S]*?<\/w:p>/g
  let match: RegExpExecArray | null
  while ((match = pRe.exec(xml)) !== null) {
    const text = decodeRuns(match[0]).replace(/[ \t]+\n/g, '\n').trim()
    if (text) paras.push(text)
  }
  return paras.join('\n\n')
}
