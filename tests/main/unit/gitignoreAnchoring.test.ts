import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clearGitignoreMatcherCache, gitignoreMatcherForDir } from '@main/agent/tools/gitignore'
import { collectWorkspaceFiles } from '@main/agent/tools/walk'

/**
 * Git anchors a pattern with a leading or interior slash to its .gitignore's
 * directory. `/lib` in the root used to hide every `lib` below it too, so
 * grep/glob/search reported "no match" for code under `src/lib`.
 */
let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vyotiq-gitignore-anchor-'))
  clearGitignoreMatcherCache()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('anchored gitignore patterns', () => {
  it('a rooted pattern matches only at its own level', async () => {
    writeFileSync(join(dir, '.gitignore'), '/lib\n', 'utf8')
    mkdirSync(join(dir, 'lib'))
    mkdirSync(join(dir, 'src', 'lib'), { recursive: true })
    writeFileSync(join(dir, 'lib', 'out.ts'), 'x\n', 'utf8')
    writeFileSync(join(dir, 'src', 'lib', 'util.ts'), 'x\n', 'utf8')

    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('lib', true)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'src').shouldIgnoreEntry('lib', true)).toBe(false)
    const rels = (await collectWorkspaceFiles(dir)).map((f) => f.rel)
    expect(rels).toContain('src/lib/util.ts')
    expect(rels).not.toContain('lib/out.ts')
  })

  it('an interior slash anchors to the .gitignore directory', () => {
    writeFileSync(join(dir, '.gitignore'), 'docs/gen\n', 'utf8')
    expect(gitignoreMatcherForDir(dir, 'docs').shouldIgnoreEntry('gen', true)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'pkg/docs').shouldIgnoreEntry('gen', true)).toBe(false)
  })

  it('a nested .gitignore anchors to its own directory', () => {
    mkdirSync(join(dir, 'pkg'))
    writeFileSync(join(dir, 'pkg', '.gitignore'), '/build\n', 'utf8')
    expect(gitignoreMatcherForDir(dir, 'pkg').shouldIgnoreEntry('build', true)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'pkg/src').shouldIgnoreEntry('build', true)).toBe(false)
  })

  it('leading **/ and bare names still match at any depth', () => {
    writeFileSync(join(dir, '.gitignore'), '**/tmp\nnotes.md\n', 'utf8')
    expect(gitignoreMatcherForDir(dir, '').shouldIgnoreEntry('tmp', true)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'a/b').shouldIgnoreEntry('tmp', true)).toBe(true)
    expect(gitignoreMatcherForDir(dir, 'a/b').shouldIgnoreEntry('notes.md', false)).toBe(true)
  })
})
