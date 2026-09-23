import { describe, expect, it } from 'vitest'
import type { UiItem } from '@shared/transcript'
import { collectAgentFileMarks, markKey } from '@renderer/features/inspector/agentFileMarks'
import { encodingLabel, eolLabel, languageName } from '@renderer/features/inspector/fileFacts'

const tool = (id: string, name: string, args: Record<string, unknown>, status: 'done' | 'running' = 'done'): UiItem => ({
  kind: 'tool',
  id,
  tool: { id, name, summary: String(args.path ?? ''), status, argsPreview: JSON.stringify(args) }
})

describe('collectAgentFileMarks', () => {
  it('marks what the task read, with the lines when the call named them', () => {
    const marks = collectAgentFileMarks(
      [
        tool('r1', 'read', { path: 'C:/ws/src/app.ts', startLine: 40, endLine: 80 }),
        tool('r2', 'read', { path: 'README.md' })
      ],
      'C:/ws'
    )
    expect(marks.get('src/app.ts')).toEqual({ read: { startLine: 40, endLine: 80 } })
    expect(marks.get('README.md')).toEqual({ read: {} })
  })

  it('marks what the task edited, and keeps a later read beside it', () => {
    const marks = collectAgentFileMarks(
      [
        tool('e1', 'edit', { path: 'src/app.ts', old_string: 'a', new_string: 'b' }),
        tool('r1', 'read', { path: 'src/app.ts', startLine: 1, endLine: 5 })
      ],
      'C:/ws'
    )
    const mark = marks.get('src/app.ts')
    expect(mark?.change).toBeDefined()
    expect(mark?.read).toEqual({ startLine: 1, endLine: 5 })
  })

  it('ignores reads still in flight', () => {
    const marks = collectAgentFileMarks([tool('r1', 'read', { path: 'a.ts' }, 'running')], 'C:/ws')
    expect(marks.size).toBe(0)
  })

  it('keys by the tree’s own path form', () => {
    expect(markKey('C:/ws', 'C:\\ws\\src\\a.ts')).toBe('src/a.ts')
    expect(markKey('C:/ws', './src/a.ts')).toBe('src/a.ts')
  })
})

describe('fileFacts', () => {
  it('names the file type from its name', () => {
    expect(languageName('src/app.tsx')).toBe('TypeScript React')
    expect(languageName('docs/README.md')).toBe('Markdown')
    expect(languageName('Dockerfile')).toBe('Dockerfile')
    expect(languageName('LICENSE')).toBe('Plain text')
    expect(languageName('data.parquet')).toBe('PARQUET')
  })

  it('says the encoding and line endings as read from disk', () => {
    expect(encodingLabel('utf8', false)).toBe('UTF-8')
    expect(encodingLabel('utf8', true)).toBe('UTF-8 with BOM')
    expect(encodingLabel('utf16le', false)).toBe('UTF-16 LE')
    expect(eolLabel('crlf')).toBe('CRLF')
    expect(eolLabel('none')).toBeNull()
  })
})
