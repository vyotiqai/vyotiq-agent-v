import { describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolSearch } from '@main/agent/tools/search'
import { minimalDocx } from './helpers/minimalDocx'

describe('toolSearch chunking', () => {
  it('aborts during a large workspace scan', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-chunk-'))
    for (let i = 0; i < 120; i++) {
      const sub = join(dir, `dir-${i}`)
      mkdirSync(sub)
      writeFileSync(join(sub, `file-${i}.ts`), `export const token${i} = ${i}\n`, 'utf8')
    }

    const ac = new AbortController()
    const searchPromise = toolSearch(dir, 'token', 40, ac.signal)
    ac.abort()

    await expect(searchPromise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('finds matches across many files without blocking forever', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-many-'))
    for (let i = 0; i < 80; i++) {
      writeFileSync(join(dir, `f-${i}.ts`), `const needle = ${i}\n`, 'utf8')
    }

    const hits = await toolSearch(dir, 'needle', 5)
    expect(hits).toMatch(/f-\d+\.ts/)
    // Truncation / index notices are not hit lines.
    const hitLines = hits
      .split('\n')
      .filter((line) => line.trim() && !line.startsWith('…') && !line.startsWith('index='))
    expect(hitLines.length).toBeLessThanOrEqual(5)
  })

  it('searches extracted Word .docx text', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-docx-'))
    writeFileSync(join(dir, 'notes.md.docx'), minimalDocx(['UniqueSearchDocxHit in architecture']))
    const hits = await toolSearch(dir, 'UniqueSearchDocxHit', 10)
    expect(hits).toContain('notes.md.docx')
    expect(hits).toContain('UniqueSearchDocxHit')
  })

  it('regex mode treats ^ as the start of each line', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-caret-'))
    writeFileSync(join(dir, 'webFetch.ts'), 'import { x } from "./y"\nexport function toolWebFetch() {}\n', 'utf8')
    const hits = await toolSearch(dir, '^export', 10, undefined, true)
    expect(hits).toContain('webFetch.ts:2:')
    expect(hits).toContain('export function toolWebFetch')
  })
})
