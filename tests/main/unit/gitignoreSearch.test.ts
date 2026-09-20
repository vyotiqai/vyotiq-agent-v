import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearGitignoreMatcherCache,
  gitignoreMatcherForDir,
  isGitignoreRelPath
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

describe('gitignore match order and path helpers', () => {
  const dirs: string[] = []

  afterEach(() => {
    clearGitignoreMatcherCache()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('lets the last matching line win, including a later re-ignore', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-order-'))
    dirs.push(dir)
    // Matching stops at the first hit scanning backwards, so a pattern that
    // re-ignores after a negation must still win over both earlier lines.
    writeFileSync(join(dir, '.gitignore'), '*.log\n!keep.log\nkeep.log\n', 'utf8')

    const m = gitignoreMatcherForDir(dir, '')
    expect(m.shouldIgnoreEntry('a.log', false)).toBe(true)
    expect(m.shouldIgnoreEntry('keep.log', false)).toBe(true)
    expect(m.shouldIgnoreEntry('a.txt', false)).toBe(false)
  })

  it('lets a deeper .gitignore negate a rule set by the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-depth-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, '.gitignore'), '*.gen.ts\n', 'utf8')
    writeFileSync(join(dir, 'pkg', '.gitignore'), '!api.gen.ts\n', 'utf8')

    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('api.gen.ts', false)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'pkg').shouldIgnoreEntry('api.gen.ts', false)).toBe(false)
  })

  it('matches a bare filename pattern at any depth', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-base-'))
    dirs.push(dir)
    writeFileSync(join(dir, '.gitignore'), 'notes.md\n', 'utf8')

    // The pattern regex is slash-anchored, so the full relative path carries
    // the basename case on its own.
    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('notes.md', false)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'a').shouldIgnoreEntry('notes.md', false)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'a/b').shouldIgnoreEntry('notes.md', false)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'a/b').shouldIgnoreEntry('other.md', false)).toBe(false)
  })

  it('applies a trailing-slash pattern to directories only', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-dironly-'))
    dirs.push(dir)
    mkdirSync(join(dir, 'nested'))
    writeFileSync(join(dir, '.gitignore'), 'build/\n', 'utf8')

    const m = gitignoreMatcherForDir(dir, '')
    // `build/` means the directory, not a script that happens to be called
    // `build` — git keeps the file.
    expect(m.shouldIgnoreEntry('build', true)).toBe(true)
    expect(m.shouldIgnoreEntry('build', false)).toBe(false)

    // Anything under a matched directory stays ignored whatever its own type.
    const inside = gitignoreMatcherForDir(dir, 'build')
    expect(inside.shouldIgnoreEntry('out.js', false)).toBe(true)
    expect(inside.shouldIgnoreEntry('sub', true)).toBe(true)

    // A directory of the same name deeper in the tree still matches.
    const nested = gitignoreMatcherForDir(dir, 'nested')
    expect(nested.shouldIgnoreEntry('build', true)).toBe(true)
    expect(nested.shouldIgnoreEntry('build', false)).toBe(false)
  })

  it('recognises .gitignore paths in every form a tool reports them', () => {
    expect(isGitignoreRelPath('.gitignore')).toBe(true)
    expect(isGitignoreRelPath('./.gitignore')).toBe(true)
    expect(isGitignoreRelPath('landing/.gitignore')).toBe(true)
    expect(isGitignoreRelPath('landing\\.gitignore')).toBe(true)
    expect(isGitignoreRelPath('src/index.ts')).toBe(false)
    expect(isGitignoreRelPath('docs/gitignore.md')).toBe(false)
    expect(isGitignoreRelPath('.gitignore.bak')).toBe(false)
  })
})
