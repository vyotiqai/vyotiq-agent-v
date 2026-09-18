import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { readJsonDocCached, resetJsonDocCacheForTests } from '@main/agent/jsonDocCache'

describe('jsonDocCache', () => {
  let dir: string

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetJsonDocCacheForTests()
  })

  it('parses once for unchanged files and re-parses after a rewrite', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-doc-cache-'))
    const path = join(dir, 'doc.json')
    writeFileSync(path, '{"a":1}', 'utf8')

    const first = await readJsonDocCached(path)
    const second = await readJsonDocCached(path)
    if (!first.ok || !second.ok) throw new Error('expected parsed docs')
    // Unchanged file → the exact same parsed object, no re-read.
    expect(second.doc).toBe(first.doc)

    writeFileSync(path, '{"a":2}', 'utf8')
    const third = await readJsonDocCached(path)
    expect(third).toEqual({ ok: true, doc: { a: 2 }, mtimeMs: expect.any(Number) })
  })

  it('detects same-length rewrites, not just size changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-doc-cache-'))
    const path = join(dir, 'doc.json')
    writeFileSync(path, '"aaa"', 'utf8')
    await readJsonDocCached(path)

    writeFileSync(path, '"bbb"', 'utf8')
    const after = await readJsonDocCached(path)

    expect(after).toEqual({ ok: true, doc: 'bbb', mtimeMs: expect.any(Number) })
  })

  it('treats missing and corrupt files as no-document', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-doc-cache-'))

    expect(await readJsonDocCached(join(dir, 'absent.json'))).toEqual({ ok: false })

    const corrupt = join(dir, 'corrupt.json')
    writeFileSync(corrupt, '{not json', 'utf8')
    expect(await readJsonDocCached(corrupt)).toEqual({ ok: false })

    // A corrupt file that is later fixed parses on the next read.
    writeFileSync(corrupt, '{"ok":true}', 'utf8')
    expect(await readJsonDocCached(corrupt)).toEqual({
      ok: true,
      doc: { ok: true },
      mtimeMs: expect.any(Number)
    })
  })

  it('re-parses when the file is touched without a size change', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-doc-cache-'))
    const path = join(dir, 'doc.json')
    writeFileSync(path, '{"a":1}', 'utf8')
    await readJsonDocCached(path)

    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    const after = await readJsonDocCached(path)

    // Content is unchanged, but the mtime no longer matches the cached
    // entry — the cache must not serve a document it can no longer vouch for.
    if (!after.ok) throw new Error('expected parsed doc')
    expect(after.doc).toEqual({ a: 1 })
    // stat reports mtimeMs as a float derived from nanosecond precision, so a
    // timestamp written as an exact millisecond can read back a fraction under
    // it (…628.999 for …629 on ext4 and APFS). Compare at millisecond
    // resolution rather than asserting the float landed exactly.
    expect(Math.round(after.mtimeMs)).toBe(old.getTime())
  })
})
