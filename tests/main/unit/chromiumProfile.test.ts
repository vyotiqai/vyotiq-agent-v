import { describe, expect, it } from 'vitest'
import { buildCacheFingerprint } from '@main/app/chromiumProfile'
import { mkdtempSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

describe('buildCacheFingerprint', () => {
  it('changes when the main bundle mtime changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-cache-'))
    const bundle = join(dir, 'index.js')
    writeFileSync(bundle, 'v1', 'utf8')
    // Same byte length, forced distinct mtimes — back-to-back writes can land
    // inside one filesystem mtime tick and flake on identical fingerprints.
    const before = new Date(Date.now() - 2000)
    utimesSync(bundle, before, before)
    const first = buildCacheFingerprint(bundle)
    writeFileSync(bundle, 'v2', 'utf8')
    const after = new Date(Date.now() + 2000)
    utimesSync(bundle, after, after)
    const second = buildCacheFingerprint(bundle)
    expect(first).not.toBe(second)
  })

  it('is stable for the same bundle bytes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-cache-'))
    const bundle = join(dir, 'index.js')
    writeFileSync(bundle, 'stable', 'utf8')
    expect(buildCacheFingerprint(bundle)).toBe(buildCacheFingerprint(bundle))
  })
})
