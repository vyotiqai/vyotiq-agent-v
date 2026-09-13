import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolRead } from '@main/agent/tools/read'
import { READ_DEFAULT_MAX_LINES } from '@main/agent/tools/read'

/** UTF-16 LE BOM + one code unit (LE) per character, '\n'-separated lines. */
function utf16leBuf(lines: string[]): Buffer {
  const text = lines.join('\n')
  const buf = Buffer.alloc(2 + text.length * 2)
  buf[0] = 0xff
  buf[1] = 0xfe
  for (let i = 0; i < text.length; i++) {
    buf[2 + i * 2] = text.charCodeAt(i) & 0xff
    buf[2 + i * 2 + 1] = text.charCodeAt(i) >> 8
  }
  return buf
}

/** UTF-16 BE BOM + byte-swapped code units, '\n'-separated lines. */
function utf16beBuf(lines: string[]): Buffer {
  const text = lines.join('\n')
  const buf = Buffer.alloc(2 + text.length * 2)
  buf[0] = 0xfe
  buf[1] = 0xff
  for (let i = 0; i < text.length; i++) {
    buf[2 + i * 2] = text.charCodeAt(i) >> 8
    buf[2 + i * 2 + 1] = text.charCodeAt(i) & 0xff
  }
  return buf
}

describe('read default window edge cases', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-read-default-window-'))
    const lines = Array.from({ length: 2500 }, (_, i) => `L${i + 1}`)
    writeFileSync(join(root, 'over-cap-le.log'), utf16leBuf(lines))
    writeFileSync(join(root, 'over-cap-be.log'), utf16beBuf(lines))
    // Binary guard past the cap: plain text lines with a NUL byte injected
    // after line 2000, inside the default window's uncollected tail.
    const head = lines.slice(0, 2000).join('\n') + '\n'
    const tail = lines.slice(2000).join('\n')
    writeFileSync(
      join(root, 'nul-past-cap.txt'),
      Buffer.concat([Buffer.from(head, 'utf8'), Buffer.from([0x00]), Buffer.from(tail, 'utf8')])
    )
    writeFileSync(
      join(root, 'over-cap-ascii.txt'),
      Buffer.from(lines.join('\n'), 'utf8')
    )
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  async function expectDefaultUtf16Window(relPath: string): Promise<void> {
    const out = await toolRead(root, relPath)
    const rows = out.split('\n')
    expect(rows[0]).toBe(
      `--- lines 1-${READ_DEFAULT_MAX_LINES} of 2500 ---`
    )
    expect(rows[1]).toBe('L1')
    expect(rows[READ_DEFAULT_MAX_LINES]).toBe(`L${READ_DEFAULT_MAX_LINES}`)
    expect(rows).toHaveLength(READ_DEFAULT_MAX_LINES + 2)
    expect(out).toContain(
      `… read truncated at ${READ_DEFAULT_MAX_LINES} lines; pass startLine/endLine to read further.`
    )
    // Fully decoded: no raw UTF-16 code units, NUL padding, or BOM survive.
    expect(out).not.toContain('\u0000')
    expect(out).not.toContain('\uFEFF')
    expect(out).not.toContain('\uFFFD')
    expect(out).not.toContain('L2001')
  }

  it('default-reads an over-cap UTF-16 LE BOM file as a decoded 2000-line window', async () => {
    await expectDefaultUtf16Window('over-cap-le.log')
  })

  it('default-reads an over-cap UTF-16 BE BOM file as a decoded 2000-line window', async () => {
    await expectDefaultUtf16Window('over-cap-be.log')
  })

  it('rejects a NUL byte past line 2000 on the default path', async () => {
    await expect(toolRead(root, 'nul-past-cap.txt')).rejects.toThrow(/Binary file detected/)
  })

  it('still windows an over-cap plain ASCII file correctly (fixture sanity)', async () => {
    const out = await toolRead(root, 'over-cap-ascii.txt')
    const rows = out.split('\n')
    expect(rows[0]).toBe(`--- lines 1-${READ_DEFAULT_MAX_LINES} of 2500 ---`)
    expect(rows[1]).toBe('L1')
    expect(rows[READ_DEFAULT_MAX_LINES]).toBe(`L${READ_DEFAULT_MAX_LINES}`)
    expect(rows).toHaveLength(READ_DEFAULT_MAX_LINES + 2)
    expect(out).toContain(
      `… read truncated at ${READ_DEFAULT_MAX_LINES} lines; pass startLine/endLine to read further.`
    )
    expect(out).not.toContain('L2001')
  })
})
