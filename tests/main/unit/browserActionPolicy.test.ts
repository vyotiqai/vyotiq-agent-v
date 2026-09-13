import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertBrowserActionAllowed,
  resolveBrowserUploadPath
} from '@main/app/browserActionPolicy'

describe('browser action policy', () => {
  let dir: string

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('allows upload and download and denies eval', () => {
    expect(assertBrowserActionAllowed('upload').allowed).toBe(true)
    expect(assertBrowserActionAllowed('download').allowed).toBe(true)
    expect(assertBrowserActionAllowed('eval').allowed).toBe(false)
  })

  it('resolves workspace files and rejects escapes', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-upload-'))
    const inside = join(dir, 'photo.png')
    writeFileSync(inside, 'x')
    expect(resolveBrowserUploadPath(dir, 'photo.png')).toBe(inside)
    expect(() => resolveBrowserUploadPath(dir, '../secret.png')).toThrow(/workspace/)
    expect(() => resolveBrowserUploadPath(dir, 'missing.png')).toThrow(/not found/)
    expect(() => resolveBrowserUploadPath(undefined, 'photo.png')).toThrow(/workspace/)
  })

  it('accepts an absolute path still inside the workspace', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-upload-abs-'))
    mkdirSync(join(dir, 'assets'))
    const inside = join(dir, 'assets', 'a.txt')
    writeFileSync(inside, 'ok')
    expect(resolveBrowserUploadPath(dir, inside)).toBe(inside)
  })
})
