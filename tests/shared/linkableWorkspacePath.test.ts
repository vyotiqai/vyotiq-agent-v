import { describe, expect, it } from 'vitest'
import {
  autolinkWorkspacePathsInProse,
  formatCitationsInProse,
  isLinkableWorkspacePath,
  isOpenableAttachmentPath,
  parseLinkableWorkspacePath,
  parseVyFileHref
} from '@shared/utils/linkableWorkspacePath'

describe('parseLinkableWorkspacePath', () => {
  it('accepts workspace-relative paths with extension', () => {
    expect(parseLinkableWorkspacePath('src/foo.ts')).toEqual({ path: 'src/foo.ts' })
    expect(parseLinkableWorkspacePath('src/foo.ts:42')).toEqual({
      path: 'src/foo.ts',
      line: 42
    })
    expect(parseLinkableWorkspacePath('package.json')).toEqual({ path: 'package.json' })
  })

  it('rejects unsafe or implausible paths', () => {
    expect(parseLinkableWorkspacePath('../secret.ts')).toBeNull()
    expect(parseLinkableWorkspacePath('no extension')).toBeNull()
    expect(parseLinkableWorkspacePath('C:/Windows/System32/cmd.exe')).toBeNull()
  })
})

describe('isOpenableAttachmentPath', () => {
  it('requires a multi-segment workspace path or a known root config file', () => {
    expect(isOpenableAttachmentPath('src/lib/util.ts')).toBe(true)
    expect(isOpenableAttachmentPath('package.json')).toBe(true)
    expect(isOpenableAttachmentPath('report.pdf')).toBe(false)
  })
})

describe('autolinkWorkspacePathsInProse', () => {
  it('wraps bare paths in markdown links', () => {
    const out = autolinkWorkspacePathsInProse('See src/foo.ts:10 for details.')
    expect(out).toContain('[src/foo.ts:10](#vy-file:src/foo.ts:10)')
  })

  it('leaves non-path tokens alone', () => {
    const out = autolinkWorkspacePathsInProse('version 1.2.3 is fine')
    expect(out).toBe('version 1.2.3 is fine')
  })

  it('autolinks known root config files', () => {
    const out = autolinkWorkspacePathsInProse('Edit package.json before release.')
    expect(out).toContain('[package.json](#vy-file:package.json)')
  })

  it('points a link the agent wrote in-app instead of nesting a second link', () => {
    expect(autolinkWorkspacePathsInProse('See [the watcher](src/main/watch.ts:12).')).toBe(
      'See [the watcher](#vy-file:src/main/watch.ts:12).'
    )
    // A path in plain parentheses is still linked with its own label.
    expect(autolinkWorkspacePathsInProse('(src/a.ts)')).toBe('([src/a.ts](#vy-file:src/a.ts))')
  })

  it('opens a [[path:line]] citation — the form the tool descriptions ask for', () => {
    expect(autolinkWorkspacePathsInProse('Fixed in [[src/a/edit.ts:92]] and [[src/b.ts]].')).toBe(
      'Fixed in [src/a/edit.ts:92](#vy-file:src/a/edit.ts:92) and [src/b.ts](#vy-file:src/b.ts).'
    )
    // A range opens at its first line and keeps its label.
    expect(autolinkWorkspacePathsInProse('[[src/main/tools/index.ts:491-500]]')).toBe(
      '[src/main/tools/index.ts:491-500](#vy-file:src/main/tools/index.ts:491)'
    )
    expect(autolinkWorkspacePathsInProse('See [[https://example.com/docs]].')).toBe('See [example.com/docs](https://example.com/docs).')
  })

  it('reads a citation with no folder as code, and leaves non-citations alone', () => {
    expect(autolinkWorkspacePathsInProse('In [[Composer.tsx:368-389]].')).toBe('In `Composer.tsx:368-389`.')
    expect(autolinkWorkspacePathsInProse('rows = [[1, 2]]')).toBe('rows = [[1, 2]]')
    expect(autolinkWorkspacePathsInProse('`[[src/a.ts]]` as written')).toBe('`[[src/a.ts]]` as written')
  })

  it('reads every citation as code where nothing opens files', () => {
    expect(formatCitationsInProse('Fixed in [[src/a.ts:9]] — see [[https://x.dev/a]]')).toBe(
      'Fixed in `src/a.ts:9` — see [x.dev/a](https://x.dev/a)'
    )
  })

  it('leaves code spans as written, and links the prose around them', () => {
    // A link inside a code span renders as its literal syntax — and the path
    // was cut at ".test", leaving ".tsx" outside it.
    const command = '`npx vitest run tests/renderer/composer/composerMenuViewport.test.tsx` — 4 passed'
    expect(autolinkWorkspacePathsInProse(command)).toBe(command)
    expect(autolinkWorkspacePathsInProse('`tsc -p tsconfig.node.json` then src/a.ts')).toBe(
      '`tsc -p tsconfig.node.json` then [src/a.ts](#vy-file:src/a.ts)'
    )
    expect(autolinkWorkspacePathsInProse('``a `src/b.ts` c`` and src/c.ts')).toBe(
      '``a `src/b.ts` c`` and [src/c.ts](#vy-file:src/c.ts)'
    )
  })
})

describe('parseVyFileHref', () => {
  it('parses hash hrefs emitted by autolink', () => {
    expect(parseVyFileHref('#vy-file:src/a.ts:3')).toEqual({
      path: 'src/a.ts',
      line: 3
    })
    expect(isLinkableWorkspacePath('src/a.ts')).toBe(true)
  })
})
