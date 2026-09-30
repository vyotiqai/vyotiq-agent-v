import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { toolRead } from '@main/agent/tools/read'
import { buildPdf } from '../../helpers/buildPdf'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vy-read-pdf-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** One page whose text wraps onto `lines` lines of 240 characters. */
const pageOf = (tag: string, lines: number): string =>
  Array.from({ length: lines }, (_, i) => `${tag} line ${i + 1} `.padEnd(240, 'x')).join('')

describe('read on a PDF', () => {
  it('returns the text of every page under its page line', async () => {
    writeFileSync(join(root, 'spec.pdf'), buildPdf(['Scope of work', 'Acceptance criteria', 'Payment terms']))
    const out = await toolRead(root, 'spec.pdf')
    expect(out).toBe(
      ['--- page 1 of 3 ---', 'Scope of work', '--- page 2 of 3 ---', 'Acceptance criteria', '--- page 3 of 3 ---', 'Payment terms'].join('\n')
    )
  })

  it('stops parsing where the default window ends, and says which pages it read', async () => {
    writeFileSync(join(root, 'big.pdf'), buildPdf(Array.from({ length: 40 }, (_, i) => pageOf(`p${i + 1}`, 100))))
    const out = await toolRead(root, 'big.pdf')
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^--- lines 1-2000 \(pages 1-(\d+) of 40 read\) ---$/)
    const readPages = Number(/pages 1-(\d+) of 40/.exec(lines[0]!)![1])
    expect(readPages).toBeLessThan(40)
    expect(lines).toHaveLength(2002)
    expect(lines[lines.length - 1]).toBe('… read truncated at 2000 lines; pass startLine/endLine to read further.')
  })

  it('a line window reaches later pages and names what it parsed', async () => {
    writeFileSync(join(root, 'big.pdf'), buildPdf(Array.from({ length: 40 }, (_, i) => pageOf(`p${i + 1}`, 100))))
    const out = await toolRead(root, 'big.pdf', { startLine: 2525, endLine: 2527 })
    const [header, ...body] = out.split('\n')
    expect(header).toMatch(/^--- lines 2525-2527 \(pages 1-\d+ of 40 read\) ---$/)
    // Page k's heading sits at line 1 + (k-1)*101; line 2525 is 100 lines into page 25's heading... page 25 starts at 2425.
    expect(body[0]).toMatch(/^p25 line 100 x+$/)
    expect(body[1]).toBe('--- page 26 of 40 ---')
    expect(body[2]).toMatch(/^p26 line 1 x+$/)
  })

  it('a byte window works like text', async () => {
    writeFileSync(join(root, 'spec.pdf'), buildPdf(['Scope of work', 'Acceptance criteria']))
    // "--- page 1 of 2 ---\n" is 20 bytes; a window inside page 1 parses only page 1.
    expect(await toolRead(root, 'spec.pdf', { offset: 20, limit: 13 })).toBe('--- offset 20, limit 13 (pages 1-1 of 2 read) ---\nScope of work')
    // A window reaching page 2 parses it too, and then knows the whole length.
    expect(await toolRead(root, 'spec.pdf', { offset: 54, limit: 19 })).toBe('--- offset 54, limit 19 of 73 bytes ---\nAcceptance criteria')
  })

  it('says so when a PDF has no text, and when it is not a PDF at all', async () => {
    writeFileSync(join(root, 'scan.pdf'), buildPdf(['', '']))
    expect(await toolRead(root, 'scan.pdf')).toBe('(no extractable text in scan.pdf: 2 pages, likely scanned images)')
    writeFileSync(join(root, 'fake.pdf'), 'not a pdf at all')
    await expect(toolRead(root, 'fake.pdf')).rejects.toThrow(/^Could not read PDF fake\.pdf: /)
  })
})
