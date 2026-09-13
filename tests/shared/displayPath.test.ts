import { describe, expect, it } from 'vitest'
import {
  extractPathFromTerminalCommand,
  formatListDirPathLabel,
  formatDisplaySize,
  formatPathLabel,
  formatUrlLabel,
  isReadOnlyTerminalCommand,
  joinWorkspaceRel,
  sanitizeDisplayPath
} from '@shared/utils/displayPath'

describe('displayPath', () => {
  it('strips wrapping quotes and escapes', () => {
    expect(sanitizeDisplayPath('"C:\\foo\\bar"')).toBe('C:\\foo\\bar')
    expect(sanitizeDisplayPath(String.raw`C:\Users\"youtube tools"\app`)).toBe(
      'C:\\Users\\youtube tools\\app'
    )
  })

  it('detects read-only terminal commands', () => {
    expect(isReadOnlyTerminalCommand('type C:\\foo.txt')).toBe(true)
    expect(isReadOnlyTerminalCommand('Get-Content .\\src\\a.ts')).toBe(true)
    expect(isReadOnlyTerminalCommand('pnpm build')).toBe(false)
  })

  it('extracts paths from read-only commands', () => {
    expect(extractPathFromTerminalCommand('type "C:\\foo\\bar.txt"')).toBe('C:\\foo\\bar.txt')
  })

  it('formats path labels with parent', () => {
    expect(formatPathLabel('src/components/Button.tsx')).toContain('Button.tsx')
  })

  it('labels workspace root without ambiguous dots', () => {
    expect(formatListDirPathLabel('.')).toBe('workspace root')
    expect(formatListDirPathLabel('..')).toBe('parent directory')
  })

  it('joins listing names onto a directory path', () => {
    expect(joinWorkspaceRel('src', 'index.ts')).toBe('src/index.ts')
    expect(joinWorkspaceRel('.', 'README.md')).toBe('README.md')
    expect(joinWorkspaceRel('src\\app', 'main.ts')).toBe('src/app/main.ts')
  })

  it('normalizes display sizes', () => {
    expect(formatDisplaySize('133B')).toBe('133B')
    expect(formatDisplaySize('392K')).toBe('392K')
    expect(formatDisplaySize('1338')).toBe('1K')
  })

  it('compacts http(s) URLs for tool headers', () => {
    expect(formatUrlLabel('https://www.stackoverflow.blog/ai-engineering')).toBe(
      'stackoverflow.blog/ai-engineering'
    )
    expect(formatUrlLabel('https://example.com/')).toBe('example.com')
    expect(formatUrlLabel('search query text')).toBe('search query text')
  })
})
