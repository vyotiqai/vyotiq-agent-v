import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolListDir } from '@main/agent/tools/listDir'

describe('toolListDir', () => {
  let root: string

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'vyotiq-listdir-'))
    mkdirSync(join(root, 'murmur-youtube-main', 'Sources'), { recursive: true })
    writeFileSync(join(root, 'murmur-youtube-main', 'Sources', 'a.swift'), 'x\n', 'utf8')
  })

  afterAll(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('hints workspace-relative paths when a top-level folder is missing', () => {
    expect(() => toolListDir(root, 'Sources')).toThrow(/Directory not found: Sources/)
    try {
      toolListDir(root, 'Sources')
    } catch (err) {
      const text = String(err)
      expect(text).toMatch(/relative to the workspace root/i)
      expect(text).toMatch(/Nested matches:/)
      expect(text).toMatch(/murmur-youtube-main\/Sources/)
      expect(text).toMatch(/\*\*\/Sources/)
    }
  })

  it('does not invent nested matches for a name that is absent', () => {
    try {
      toolListDir(root, 'DefinitelyNoSuchDir_xyz')
      expect.fail('expected throw')
    } catch (err) {
      expect(String(err)).not.toMatch(/Nested matches:/)
    }
  })
})
