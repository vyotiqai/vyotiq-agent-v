import { describe, expect, it } from 'vitest'
import { resolveFileIcon, resolveFolderIcon } from '@renderer/lib/fileIcons/resolve'

describe('resolveFileIcon', () => {
  it('maps common language extensions', () => {
    expect(resolveFileIcon('src/app.ts')).toBe('typescript')
    expect(resolveFileIcon('src/App.tsx')).toBe('react_ts')
    expect(resolveFileIcon('src/app.js')).toBe('javascript')
    expect(resolveFileIcon('src/App.jsx')).toBe('react')
    expect(resolveFileIcon('main.py')).toBe('python')
    expect(resolveFileIcon('lib.rs')).toBe('rust')
    expect(resolveFileIcon('main.go')).toBe('go')
    expect(resolveFileIcon('styles.css')).toBe('css')
    expect(resolveFileIcon('index.html')).toBe('html')
  })

  it('uses longest compound extension matches', () => {
    expect(resolveFileIcon('types.d.ts')).toBe('typescript-def')
    expect(resolveFileIcon('Button.test.tsx')).toBe('test-jsx')
    expect(resolveFileIcon('util.spec.ts')).toBe('test-ts')
  })

  it('resolves special filenames', () => {
    expect(resolveFileIcon('package.json')).toBe('nodejs')
    expect(resolveFileIcon('tsconfig.json')).toBe('tsconfig')
    expect(resolveFileIcon('Dockerfile')).toBe('docker')
    expect(resolveFileIcon('.gitignore')).toBe('git')
  })

  it('falls back to the default file icon', () => {
    expect(resolveFileIcon('archive.backup2024')).toBe('file')
    expect(resolveFileIcon('weirdname')).toBe('file')
  })

  it('resolves README by filename', () => {
    expect(resolveFileIcon('README')).toBe('readme')
  })

  it('handles Windows paths', () => {
    expect(resolveFileIcon('C:\\ws\\App.tsx')).toBe('react_ts')
  })
})

describe('resolveFolderIcon', () => {
  it('maps known folder names', () => {
    expect(resolveFolderIcon('src')).toBe('folder-src')
    expect(resolveFolderIcon('src', true)).toBe('folder-src-open')
  })

  it('falls back to default folder icons', () => {
    expect(resolveFolderIcon('my-random-dir')).toBe('folder')
    expect(resolveFolderIcon('my-random-dir', true)).toBe('folder-open')
  })
})
