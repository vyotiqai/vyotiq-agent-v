import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearGitignoreMatcherCache,
  gitignoreMatcherForDir
} from '@main/agent/tools/gitignore'
import { toolSearch } from '@main/agent/tools/search'

describe('gitignore-aware search', () => {
  const dirs: string[] = []

  afterEach(() => {
    clearGitignoreMatcherCache()
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips paths matched by root .gitignore', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'src'))
    mkdirSync(join(dir, 'ignored'))
    writeFileSync(join(dir, 'src', 'keep.ts'), 'export const keep = true\n', 'utf8')
    writeFileSync(join(dir, 'ignored', 'skip.ts'), 'export const skip = true\n', 'utf8')
    writeFileSync(join(dir, '.gitignore'), 'ignored/\n', 'utf8')

    const matcher = gitignoreMatcherForDir(dir, '')
    expect(matcher.shouldIgnoreEntry('ignored', true)).toBe(true)

    const hits = await toolSearch(dir, 'export', 40)
    expect(hits).toMatch(/keep\.ts/)
    expect(hits).not.toMatch(/skip\.ts/)
  })

  it('applies nested .gitignore files relative to their directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-nested-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'src', 'generated'), { recursive: true })
    mkdirSync(join(dir, 'src', 'lib'))
    writeFileSync(join(dir, 'src', 'generated', 'auto.ts'), 'export const auto = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'lib', 'hand.ts'), 'export const hand = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', '.gitignore'), 'generated/\n', 'utf8')

    const srcMatcher = gitignoreMatcherForDir(dir, 'src')
    expect(srcMatcher.shouldIgnoreEntry('generated', true)).toBe(true)
    expect(srcMatcher.shouldIgnoreEntry('lib', true)).toBe(false)

    const hits = await toolSearch(dir, 'export', 40)
    expect(hits).toMatch(/hand\.ts/)
    expect(hits).not.toMatch(/auto\.ts/)
  })

  it('clearGitignoreMatcherCache reloads rules after .gitignore changes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-cache-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'secret'))
    writeFileSync(join(dir, 'secret', 'x.ts'), 'export const x = 1\n', 'utf8')
    writeFileSync(join(dir, '.gitignore'), '', 'utf8')

    const before = gitignoreMatcherForDir(dir, '')
    expect(before.shouldIgnoreEntry('secret', true)).toBe(false)

    writeFileSync(join(dir, '.gitignore'), 'secret/\n', 'utf8')
    // Stale without clear:
    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('secret', true)).toBe(false)

    clearGitignoreMatcherCache(dir)
    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('secret', true)).toBe(true)
  })
})
