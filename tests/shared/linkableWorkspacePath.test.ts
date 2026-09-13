import { describe, expect, it } from 'vitest'
import {
  autolinkWorkspacePathsInProse,
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
