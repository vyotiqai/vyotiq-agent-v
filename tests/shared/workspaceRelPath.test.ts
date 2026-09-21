import { describe, expect, it } from 'vitest'
import { toWorkspaceRelPath } from '@shared/utils/workspacePath'

const WIN_ROOT = 'C:\\Users\\dev\\proj'
const POSIX_ROOT = '/home/dev/proj'

describe('toWorkspaceRelPath — already relative', () => {
  it('passes a safe workspace-relative path through unchanged', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'src/a.ts')).toBe('src/a.ts')
  })

  it('normalizes backslash separators to forward slashes', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'src\\main\\a.ts')).toBe('src/main/a.ts')
  })

  it('strips a leading ./ and trailing slashes', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, './src/a.ts')).toBe('src/a.ts')
    expect(toWorkspaceRelPath(WIN_ROOT, 'src/a.ts/')).toBe('src/a.ts')
  })

  it('accepts extensionless files that prose autolinking rejects', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'Makefile')).toBe('Makefile')
    expect(toWorkspaceRelPath(WIN_ROOT, 'LICENSE')).toBe('LICENSE')
  })

  it('collapses doubled separators via the absolute round trip', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'src//a.ts')).toBe('src/a.ts')
  })
})

describe('toWorkspaceRelPath — absolute inside the workspace', () => {
  it('relativizes a Windows absolute path', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'C:\\Users\\dev\\proj\\src\\a.ts')).toBe('src/a.ts')
  })

  it('relativizes a Windows absolute path given with forward slashes', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'C:/Users/dev/proj/src/a.ts')).toBe('src/a.ts')
  })

  it('matches the drive and path case-insensitively on Windows roots', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'c:\\users\\DEV\\Proj\\src\\a.ts')).toBe('src/a.ts')
  })

  it('relativizes a POSIX absolute path', () => {
    expect(toWorkspaceRelPath(POSIX_ROOT, '/home/dev/proj/src/a.ts')).toBe('src/a.ts')
  })

  it('resolves . and .. segments that stay inside the workspace', () => {
    expect(toWorkspaceRelPath(POSIX_ROOT, '/home/dev/proj/src/../src/a.ts')).toBe('src/a.ts')
    expect(toWorkspaceRelPath(POSIX_ROOT, 'src/./a.ts')).toBe('src/a.ts')
  })
})

describe('toWorkspaceRelPath — not openable', () => {
  it('rejects an absolute path outside the workspace', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'C:\\Windows\\System32\\cmd.exe')).toBeNull()
    expect(toWorkspaceRelPath(POSIX_ROOT, '/etc/passwd')).toBeNull()
  })

  it('rejects a relative path that escapes the workspace', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, '../secret.ts')).toBeNull()
    expect(toWorkspaceRelPath(POSIX_ROOT, '../../etc/passwd')).toBeNull()
  })

  it('rejects the workspace root itself', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, WIN_ROOT)).toBeNull()
    expect(toWorkspaceRelPath(POSIX_ROOT, POSIX_ROOT)).toBeNull()
  })

  it('rejects empty, blank and nullish input', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, '')).toBeNull()
    expect(toWorkspaceRelPath(WIN_ROOT, '   ')).toBeNull()
    expect(toWorkspaceRelPath(WIN_ROOT, null)).toBeNull()
    expect(toWorkspaceRelPath(WIN_ROOT, undefined)).toBeNull()
  })

  it('rejects a NUL byte', () => {
    expect(toWorkspaceRelPath(WIN_ROOT, 'src/a\0.ts')).toBeNull()
  })

  it('rejects an absolute path when no workspace root is known', () => {
    expect(toWorkspaceRelPath(null, 'C:\\Users\\dev\\proj\\src\\a.ts')).toBeNull()
    expect(toWorkspaceRelPath('', '/home/dev/proj/src/a.ts')).toBeNull()
  })

  it('still accepts a relative path when no workspace root is known', () => {
    expect(toWorkspaceRelPath(null, 'src/a.ts')).toBe('src/a.ts')
  })
})
