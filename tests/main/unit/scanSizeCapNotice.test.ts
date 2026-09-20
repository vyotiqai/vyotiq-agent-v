/**
 * A file skipped for size is a coverage gap, not an absence of matches.
 *
 * GREP_MAX_FILE_BYTES / SEARCH_MAX_FILE_BYTES were declared but unenforced, so
 * enforcing them silently turned "the symbol is in a 600KB file" into "no
 * matches" — a wrong answer rather than a slow one. Both tools now say what
 * they did not read.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolGrep, GREP_MAX_FILE_BYTES } from '@main/agent/tools/grep'
import { toolSearch, SEARCH_MAX_FILE_BYTES } from '@main/agent/tools/search'

const NEEDLE = 'zzUniqueNeedlezz'

describe('scan size caps are reported, not silent', () => {
  const roots: string[] = []

  afterEach(() => {
    for (const root of roots.splice(0)) {
      if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    }
  })

  /** A workspace with one small matching file and one oversized matching file. */
  function makeWorkspace(capBytes: number, prefix: string): string {
    const root = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'src'), { recursive: true })
    roots.push(root)
    writeFileSync(join(root, 'src', 'small.ts'), `export const a = '${NEEDLE}'\n`, 'utf8')
    const filler = `// ${'x'.repeat(200)}\n`.repeat(Math.ceil(capBytes / 200) + 200)
    writeFileSync(join(root, 'src', 'huge.ts'), `${filler}export const b = '${NEEDLE}'\n`, 'utf8')
    return root
  }

  it('grep reports the files its size cap kept out of the scan', async () => {
    const root = makeWorkspace(GREP_MAX_FILE_BYTES, 'vyotiq-grep-cap')
    const out = await toolGrep(root, NEEDLE)

    // The small file is still found; the oversized one is named as skipped
    // rather than quietly dropped.
    expect(out).toContain('small.ts')
    expect(out).not.toContain('huge.ts')
    expect(out).toMatch(/…\s1 file over \d+KB not scanned/)
  }, 60_000)

  it('search reports the files its size cap kept out of the scan', async () => {
    const root = makeWorkspace(SEARCH_MAX_FILE_BYTES, 'vyotiq-search-cap')
    const out = await toolSearch(root, NEEDLE, 40)

    expect(out).toMatch(/…\s1 file over \d+KB not scanned/)
  }, 60_000)

  it('says nothing when every candidate fitted under the cap', async () => {
    const root = join(tmpdir(), `vyotiq-nocap-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'src'), { recursive: true })
    roots.push(root)
    writeFileSync(join(root, 'src', 'a.ts'), `export const a = '${NEEDLE}'\n`, 'utf8')

    const grepOut = await toolGrep(root, NEEDLE)
    const searchOut = await toolSearch(root, NEEDLE, 40)
    expect(grepOut).toContain('a.ts')
    expect(grepOut).not.toMatch(/not scanned/)
    expect(searchOut).not.toMatch(/not scanned/)
  }, 60_000)

  it('list_dir applies its declared cap and says how much it cut', async () => {
    const { toolListDir, LIST_DIR_CAP } = await import('@main/agent/tools/listDir')
    const root = join(tmpdir(), `vyotiq-listdir-cap-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'many'), { recursive: true })
    roots.push(root)
    const total = LIST_DIR_CAP + 37
    for (let i = 0; i < total; i++) {
      writeFileSync(join(root, 'many', `f${String(i).padStart(4, '0')}.ts`), 'x\n', 'utf8')
    }

    const countEntries = (text: string): number =>
      text.split('\n').filter((l) => l.trim().startsWith('[file]')).length

    const out = toolListDir(root, 'many')
    // The cap was declared but never reached the default, so one call used to
    // put the entire directory into context.
    expect(countEntries(out)).toBe(LIST_DIR_CAP)
    expect(out).toContain(`… ${total - LIST_DIR_CAP} more entries`)

    // An explicit cap still wins.
    expect(countEntries(toolListDir(root, 'many', 5))).toBe(5)
  }, 60_000)

  it('keeps the notice out of the parsed hit paths', async () => {
    const { searchHitPathsFromResult } = await import('@main/agent/tools/search')
    const root = makeWorkspace(SEARCH_MAX_FILE_BYTES, 'vyotiq-search-parse')
    const out = await toolSearch(root, NEEDLE, 40)

    // The leading `…` keeps the notice from being read back as a file path and
    // seeded into the loop's known-paths set.
    const paths = searchHitPathsFromResult(out)
    expect(paths.every((p) => !p.includes('not scanned'))).toBe(true)
  }, 60_000)
})
