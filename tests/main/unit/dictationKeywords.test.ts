import { describe, expect, it } from 'vitest'
import { MAX_DICTATION_KEYWORDS, dictationKeywordsFromFiles } from '@main/dictation/keywords'

describe('dictation keywords from the workspace', () => {
  it('keeps camelCase and PascalCase names, most used first, and drops plain words', () => {
    const files = [
      'src/renderer/composer/take/takeController.ts',
      'src/renderer/composer/take/useTake.ts',
      'tests/renderer/composer/takeController.test.ts',
      'src/renderer/settings/sections/VoiceSection.tsx',
      'src/main/ipc/register.ts',
      'README.md',
      'docs/what-is-new.md',
      'src/IPCHandler.ts'
    ]
    const words = dictationKeywordsFromFiles(files)
    expect(words[0]).toBe('takeController')
    expect(words).toEqual(expect.arrayContaining(['useTake', 'VoiceSection', 'IPCHandler']))
    for (const plain of ['src', 'renderer', 'register', 'README', 'what-is-new', 'take']) expect(words).not.toContain(plain)
  })

  it('never sends what the API rejects, and caps the list', () => {
    const files = Array.from({ length: 400 }, (_, i) => `pkg/moduleName${i}.ts`)
    files.push('odd/<bad>Name.ts', 'odd/line\nBreakName.ts')
    const words = dictationKeywordsFromFiles(files)
    expect(words).toHaveLength(MAX_DICTATION_KEYWORDS)
    for (const w of words) expect(w).toMatch(/^[A-Za-z][A-Za-z0-9]+$/)
  })

  it('reuses the answer for the same list', () => {
    const files = ['a/fooBar.ts']
    expect(dictationKeywordsFromFiles(files)).toBe(dictationKeywordsFromFiles(files))
  })
})
