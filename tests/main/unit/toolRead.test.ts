import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, promises as fsp } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { deflateRawSync } from 'zlib'
import { toolRead } from '@main/agent/tools/read'
import { extractDocxText } from '@main/agent/tools/docxText'
import { READ_DEFAULT_MAX_LINES } from '@main/agent/tools/read'

function crc32(buf: Buffer): number {
  let crc = ~0
  for (const b of buf) {
    crc ^= b
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return ~crc >>> 0
}

/** Minimal ZIP (stored or deflate) for Word-shaped fixtures. */
function buildZip(entries: { name: string; data: Buffer; store?: boolean }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const raw = entry.store ? entry.data : deflateRawSync(entry.data)
    const method = entry.store ? 0 : 8
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + name.length + raw.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(raw.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    name.copy(local, 30)
    raw.copy(local, 30 + name.length)
    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(raw.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    locals.push(local)
    centrals.push(central)
    offset += local.length
  }
  const cdSize = centrals.reduce((sum, b) => sum + b.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, ...centrals, eocd])
}

function wordDocumentXml(paragraphs: string[]): Buffer {
  const body = paragraphs
    .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
    .join('')
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
    'utf8'
  )
}

describe('toolRead', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-read-'))
    mkdirSync(join(root, 'subdir'), { recursive: true })
    writeFileSync(join(root, 'hello.txt'), 'hello world', 'utf8')
    writeFileSync(join(root, 'subdir', 'nested.txt'), 'nested', 'utf8')
    writeFileSync(join(root, 'lines.txt'), 'one\ntwo\nthree\nfour\nfive\n', 'utf8')
    writeFileSync(join(root, 'binary.dat'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('reads a small file', async () => {
    expect(await toolRead(root, 'hello.txt')).toBe('hello world')
  })

  it('reads files larger than the former 512 KiB full-read cap', async () => {
    const body = 'x'.repeat(512 * 1024 + 80)
    writeFileSync(join(root, 'over-old-cap.txt'), body, 'utf8')
    expect(await toolRead(root, 'over-old-cap.txt')).toBe(body)
  })

  it('lists directory contents instead of throwing not-a-file', async () => {
    const out = await toolRead(root, 'subdir')
    expect(out).toContain('Path is a directory')
    expect(out).toContain('nested.txt')
  })

  it('suggests similar names when file is missing', async () => {
    try {
      await toolRead(root, 'hell.txt')
      expect.fail('expected throw')
    } catch (err) {
      expect(String(err)).toContain('File not found')
      expect(String(err)).toContain('hello.txt')
    }
  })

  it('supports offset/limit for partial reads', async () => {
    const out = await toolRead(root, 'hello.txt', { offset: 6, limit: 5 })
    expect(out).toContain('world')
  })

  it('rejects binary files on the offset/limit path too', async () => {
    await expect(toolRead(root, 'binary.dat', { offset: 1, limit: 2 })).rejects.toThrow(
      /Binary file detected: binary\.dat\. Read is text-only\./
    )
    // A window with no NUL is treated as text — mid-file has no BOM to inspect.
    const out = await toolRead(root, 'binary.dat', { offset: 2 })
    expect(out).toContain('BC')
  })

  it('rejects binary files on full and line-range reads', async () => {
    await expect(toolRead(root, 'binary.dat')).rejects.toThrow(/Binary file detected/)
    await expect(toolRead(root, 'binary.dat', { startLine: 1 })).rejects.toThrow(/Binary file detected/)
  })

  it('reads UTF-16 LE BOM text (PowerShell log pattern)', async () => {
    const utf16Path = join(root, 'utf16le.log')
    const body = 'download started\r\nline two'
    const buf = Buffer.alloc(2 + body.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      buf[2 + i * 2] = body.charCodeAt(i)
      buf[2 + i * 2 + 1] = 0
    }
    writeFileSync(utf16Path, buf)
    expect(await toolRead(root, 'utf16le.log')).toBe('download started\r\nline two')
  })

  it('reads UTF-16 LE BOM text with offset/limit', async () => {
    const utf16Path = join(root, 'utf16-offset.log')
    const body = 'download started\r\nline two'
    const buf = Buffer.alloc(2 + body.length * 2)
    buf[0] = 0xff
    buf[1] = 0xfe
    for (let i = 0; i < body.length; i++) {
      buf[2 + i * 2] = body.charCodeAt(i)
      buf[2 + i * 2 + 1] = 0
    }
    writeFileSync(utf16Path, buf)
    const out = await toolRead(root, 'utf16-offset.log', { offset: 0, limit: 20 })
    expect(out).toContain('download')
    expect(out).not.toContain('line two')
  })

  it('streams a byte window on large files', async () => {
    const bigPath = join(root, 'big-offset.txt')
    writeFileSync(bigPath, 'x'.repeat(512 * 1024 + 1))
    const out = await toolRead(root, 'big-offset.txt', { offset: 0, limit: 10 })
    expect(out).toContain('--- offset 0, limit 10')
    expect(out).toContain('xxxxxxxxxx')
    expect(out).not.toMatch(/File too large/)
  })

  it('returns an inclusive line range with a header naming it', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 2, endLine: 4 })
    expect(out).toBe('--- lines 2-4 of 5 ---\ntwo\nthree\nfour')
  })

  it('swaps inverted startLine/endLine and reads that window', async () => {
    writeFileSync(
      join(root, 'many-lines.txt'),
      Array.from({ length: 25 }, (_, i) => `L${i + 1}`).join('\n')
    )
    const out = await toolRead(root, 'many-lines.txt', { startLine: 20, endLine: 5 })
    expect(out).toMatch(/^--- lines 5-20 of 25 ---/)
    const body = out.split('\n').slice(1)
    expect(body[0]).toBe('L5')
    expect(body[body.length - 1]).toBe('L20')
    expect(body).toHaveLength(16)
  })

  it('runs to the end of the file when endLine is omitted', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 4 })
    expect(out).toBe('--- lines 4-5 of 5 ---\nfour\nfive')
  })

  it('clamps an endLine past the end rather than padding blank lines', async () => {
    const out = await toolRead(root, 'lines.txt', { startLine: 5, endLine: 900 })
    expect(out).toBe('--- lines 5-5 of 5 ---\nfive')
  })

  it('refuses a startLine past the end instead of returning nothing', async () => {
    await expect(toolRead(root, 'lines.txt', { startLine: 12 })).rejects.toThrow(/past the end/)
  })

  it('does not count a trailing newline as an extra line', async () => {
    expect(await toolRead(root, 'lines.txt', { startLine: 1 })).toContain('of 5 ---')
  })

  it('streams a requested line range in full without a returned-text cap', async () => {
    const line = 'y'.repeat(200)
    const count = 400
    writeFileSync(join(root, 'big-lines.txt'), Array.from({ length: count }, () => line).join('\n'))
    const out = await toolRead(root, 'big-lines.txt', { startLine: 10, endLine: 12 })
    expect(out).toMatch(/^--- lines 10-12 of 400 ---/)
    expect(out).not.toMatch(/capped/)
    expect(out).toContain(line)
    const body = out.split('\n').slice(1)
    expect(body).toHaveLength(3)
    expect(body.every((row) => row === line)).toBe(true)
  })

  it('overlaps I/O for two concurrent reads of different files', async () => {
    writeFileSync(join(root, 'overlap-a.txt'), 'alpha', 'utf8')
    writeFileSync(join(root, 'overlap-b.txt'), 'bravo', 'utf8')

    let inFlight = 0
    let maxConcurrent = 0
    // Default reads stream via fsp.open/fh.read, so overlap is observed there.
    const origOpen = fsp.open.bind(fsp)
    const spy = vi.spyOn(fsp, 'open').mockImplementation((async (...args: unknown[]) => {
      inFlight += 1
      maxConcurrent = Math.max(maxConcurrent, inFlight)
      await new Promise((r) => setTimeout(r, 40))
      try {
        return await origOpen(...(args as Parameters<typeof origOpen>))
      } finally {
        inFlight -= 1
      }
    }) as unknown as typeof fsp.open)

    try {
      const [a, b] = await Promise.all([
        toolRead(root, 'overlap-a.txt'),
        toolRead(root, 'overlap-b.txt')
      ])
      expect(a).toBe('alpha')
      expect(b).toBe('bravo')
      expect(maxConcurrent).toBeGreaterThan(1)
    } finally {
      spy.mockRestore()
    }
  })

  it('extracts Word .docx paragraph text instead of rejecting the zip as binary', async () => {
    const xml = wordDocumentXml(['Hello architecture', 'Second para &amp; more'])
    writeFileSync(join(root, 'notes.md.docx'), buildZip([{ name: 'word/document.xml', data: xml }]))
    const out = await toolRead(root, 'notes.md.docx')
    expect(out).toBe('Hello architecture\n\nSecond para & more')
    expect(out).not.toMatch(/Binary file detected/)
  })

  it('extracts stored-method .docx and applies line/byte windows to the text', async () => {
    const xml = wordDocumentXml(['alpha', 'bravo', 'charlie'])
    writeFileSync(
      join(root, 'stored.docx'),
      buildZip([{ name: 'word/document.xml', data: xml, store: true }])
    )
    const lines = await toolRead(root, 'stored.docx', { startLine: 1, endLine: 1 })
    expect(lines).toMatch(/^--- lines 1-1 of /)
    expect(lines).toContain('alpha')
    expect(lines).not.toContain('charlie')

    // Same-case byte window: ubuntu CI is case-sensitive, so the former
    // 'stored.DOCX' argument missed the file there ("File not found") instead
    // of exercising the byte-window path this test pins.
    const bytes = await toolRead(root, 'stored.docx', { offset: 0, limit: 5 })
    expect(bytes).toMatch(/--- offset 0, limit 5 of \d+ bytes ---/)
    expect(bytes).toContain('alpha')
    expect(bytes).not.toContain('bravo')
  })

  it('rejects a .docx that is not a valid Word zip', async () => {
    writeFileSync(join(root, 'fake.docx'), Buffer.from([0x41, 0x00, 0x42, 0x43]))
    await expect(toolRead(root, 'fake.docx')).rejects.toThrow(
      /Binary file detected: fake\.docx\. Word \.docx text extraction failed/
    )
  })

  it('extractDocxText joins w:t runs from a deflated document.xml', () => {
    const xml = wordDocumentXml(['Architecture overview'])
    const buf = buildZip([{ name: 'word/document.xml', data: xml }])
    expect(extractDocxText(buf)).toBe('Architecture overview')
  })

  it('truncates a default read past READ_DEFAULT_MAX_LINES with a header and hint', async () => {
    const count = READ_DEFAULT_MAX_LINES + 500
    writeFileSync(
      join(root, 'over-cap.txt'),
      Array.from({ length: count }, (_, i) => `L${i + 1}`).join('\n') + '\n',
      'utf8'
    )
    const out = await toolRead(root, 'over-cap.txt')
    const lines = out.split('\n')
    expect(lines[0]).toBe(`--- lines 1-${READ_DEFAULT_MAX_LINES} of ${count} ---`)
    expect(lines[1]).toBe('L1')
    expect(lines[READ_DEFAULT_MAX_LINES]).toBe(`L${READ_DEFAULT_MAX_LINES}`)
    expect(lines).toHaveLength(READ_DEFAULT_MAX_LINES + 2)
    expect(lines[READ_DEFAULT_MAX_LINES + 1]).toBe(
      `… read truncated at ${READ_DEFAULT_MAX_LINES} lines; pass startLine/endLine to read further.`
    )
    expect(out).not.toContain(`L${READ_DEFAULT_MAX_LINES + 1}`)
  })

  it('keeps byte-identical output for files at or under the cap (no header)', async () => {
    const atCap =
      Array.from({ length: READ_DEFAULT_MAX_LINES }, (_, i) => `L${i + 1}`).join('\n') + '\n'
    writeFileSync(join(root, 'at-cap.txt'), atCap, 'utf8')
    expect(await toolRead(root, 'at-cap.txt')).toBe(atCap)

    writeFileSync(join(root, 'trail.txt'), 'one\ntwo\n', 'utf8')
    expect(await toolRead(root, 'trail.txt')).toBe('one\ntwo\n')

    writeFileSync(join(root, 'no-trail.txt'), 'one\ntwo', 'utf8')
    expect(await toolRead(root, 'no-trail.txt')).toBe('one\ntwo')

    writeFileSync(join(root, 'crlf.txt'), 'a\r\nb\r\n', 'utf8')
    expect(await toolRead(root, 'crlf.txt')).toBe('a\r\nb\r\n')

    writeFileSync(join(root, 'empty.txt'), '', 'utf8')
    expect(await toolRead(root, 'empty.txt')).toBe('')
  })

  it('explicit startLine/endLine still reads exact ranges in a file past the cap', async () => {
    const start = READ_DEFAULT_MAX_LINES + 1
    const out = await toolRead(root, 'over-cap.txt', { startLine: start })
    expect(out).toBe(
      `--- lines ${start}-${start + 499} of ${READ_DEFAULT_MAX_LINES + 500} ---\n` +
        Array.from({ length: 500 }, (_, i) => `L${start + i}`).join('\n')
    )
  })
})
