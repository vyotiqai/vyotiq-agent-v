import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))

import { READ_MAX_WINDOW_CHARS, toolRead } from '@main/agent/tools/read'
import { grepFilesForTest } from '@main/agent/tools/grep'
import { toolSearch } from '@main/agent/tools/search'

/**
 * Pathological files must not enter history whole: one minified line, a
 * huge line range, a big byte window or a crowded directory. Normal files are
 * covered by the existing read/grep suites and must read exactly as before.
 */
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-output-caps-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('read caps', () => {
  it('truncates one huge line with a hint', async () => {
    writeFileSync(join(root, 'bundle.js'), 'x'.repeat(3 * 1024 * 1024), 'utf8')
    const out = await toolRead(root, 'bundle.js')
    expect(out.length).toBeLessThan(20_000)
    expect(out).toMatch(/line truncated: \d+ more chars — read them with offset\/limit/)
  })

  it('stops a huge line range at the window budget and names where to continue', async () => {
    const line = 'y'.repeat(1000)
    writeFileSync(join(root, 'wide.txt'), `${line}\n`.repeat(3000), 'utf8')
    const out = await toolRead(root, 'wide.txt', { startLine: 1, endLine: 3000 })
    expect(out.length).toBeLessThan(READ_MAX_WINDOW_CHARS + 1024)
    expect(out).toMatch(/^--- lines 1-(\d+) of 3000 ---/)
    expect(out).toMatch(/pass startLine \d+ to read further\.$/)
  })

  it('caps a byte window and names the next offset', async () => {
    writeFileSync(join(root, 'big.txt'), 'z'.repeat(3 * 1024 * 1024), 'utf8')
    const out = await toolRead(root, 'big.txt', { offset: 0, limit: 3 * 1024 * 1024 })
    expect(out.length).toBeLessThan(READ_MAX_WINDOW_CHARS + 1024)
    expect(out.endsWith(`pass offset ${READ_MAX_WINDOW_CHARS} to continue.`)).toBe(true)
  })

  it('lists a crowded directory like list_dir does', async () => {
    mkdirSync(join(root, 'many'))
    for (let i = 0; i < 260; i++) writeFileSync(join(root, 'many', `f${i}.txt`), '', 'utf8')
    const out = await toolRead(root, 'many')
    expect(out.split('\n').filter((l) => l.startsWith('[file]'))).toHaveLength(200)
    expect(out).toContain('… 60 more entries')
  })
})

describe('grep and search cap a hit line', () => {
  it('grep prints the head of a minified line, not all of it', () => {
    writeFileSync(join(root, 'min.js'), `${'a'.repeat(100_000)}NEEDLE${'b'.repeat(100_000)}\n`, 'utf8')
    const out = grepFilesForTest(root, 'a+', ['min.js'])
    expect(out.length).toBeLessThan(3000)
    expect(out).toMatch(/… \[\+\d+ chars\]/)
  })

  it('search does the same', async () => {
    writeFileSync(join(root, 'min.ts'), `${'a'.repeat(100_000)}NEEDLE${'b'.repeat(100_000)}\n`, 'utf8')
    const out = await toolSearch(root, 'NEEDLE', 10, new AbortController().signal)
    expect(out).toContain('min.ts:1:')
    expect(out.length).toBeLessThan(3000)
  })
})
