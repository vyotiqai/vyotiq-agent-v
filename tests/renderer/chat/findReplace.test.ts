import { describe, expect, it } from 'vitest'
import type { WorkspaceFileReadResult } from '@shared/ipc'
import {
  compileFind,
  describeReplaceCount,
  expandReplacement,
  findPatternSource,
  lineMatches,
  planReplaceAll,
  planReplaceInText,
  uniquePaths,
  type FindOptions
} from '@renderer/features/chat/components/findReplace'

const literal = (query: string, extra: Partial<FindOptions> = {}): FindOptions => ({
  query,
  regex: false,
  matchCase: false,
  wholeWord: false,
  ...extra
})

function read(path: string, content: string, extra: Partial<WorkspaceFileReadResult> = {}): WorkspaceFileReadResult {
  return {
    path,
    kind: 'text',
    content,
    encoding: 'utf8',
    eol: 'lf',
    bom: false,
    size: content.length,
    version: { mtimeMs: 1, size: content.length, sha256: 'a'.repeat(64) },
    truncated: false,
    ...extra
  } as WorkspaceFileReadResult
}

describe('findPatternSource', () => {
  it('escapes a literal query and wraps whole words', () => {
    expect(findPatternSource(literal('a.b(c)'))).toBe('a\\.b\\(c\\)')
    expect(findPatternSource(literal('foo', { wholeWord: true }))).toBe('\\b(?:foo)\\b')
    expect(findPatternSource(literal('fo+', { regex: true }))).toBe('fo+')
  })

  it('reports a regex that does not compile', () => {
    const compiled = compileFind(literal('(', { regex: true }))
    expect(compiled.ok).toBe(false)
  })
})

describe('planReplaceInText', () => {
  it('replaces a literal query case-insensitively by default', () => {
    const { edits, next } = planReplaceInText('Foo foo FOO a.b', literal('foo'), 'bar')
    expect(edits.map((e) => [e.from, e.to])).toEqual([
      [0, 3],
      [4, 7],
      [8, 11]
    ])
    expect(next).toBe('bar bar bar a.b')
  })

  it('treats regex characters in a literal query as text', () => {
    expect(planReplaceInText('a.b axb', literal('a.b'), 'X').next).toBe('X axb')
  })

  it('honours match case', () => {
    expect(planReplaceInText('Foo foo', literal('foo', { matchCase: true }), 'x').next).toBe('Foo x')
  })

  it('honours whole word', () => {
    expect(planReplaceInText('cat concat cat_s cat.', literal('cat', { wholeWord: true }), 'dog').next).toBe(
      'dog concat cat_s dog.'
    )
  })

  it('expands groups in a regex replacement and leaves them alone in a literal one', () => {
    const regex = literal('(\\w+)@(\\w+)', { regex: true })
    expect(planReplaceInText('me@host', regex, '$2 at $1 ($&) $$').next).toBe('host at me (me@host) $')
    expect(planReplaceInText('me@host', literal('me'), '$1').next).toBe('$1@host')
  })

  it('anchors ^ and $ per line and moves past zero-length matches', () => {
    const { edits, next } = planReplaceInText('a\nb\n', literal('^', { regex: true }), '> ')
    expect(edits).toHaveLength(3)
    expect(next).toBe('> a\n> b\n> ')
  })

  it('returns the text untouched when nothing matches', () => {
    const plan = planReplaceInText('abc', literal('zzz'), 'y')
    expect(plan.edits).toEqual([])
    expect(plan.next).toBe('abc')
  })
})

describe('planReplaceAll', () => {
  it('plans each file once and refuses unsaved, binary and truncated ones', async () => {
    const files: Record<string, WorkspaceFileReadResult | null> = {
      'a.ts': read('a.ts', 'foo foo'),
      'b.ts': read('b.ts', 'no match'),
      'dirty.ts': read('dirty.ts', 'foo'),
      'img.png': read('img.png', 'foo', { kind: 'binary' }),
      'big.log': read('big.log', 'foo', { truncated: true }),
      'gone.ts': null
    }
    const paths = uniquePaths([
      { path: 'a.ts' },
      { path: 'a.ts' },
      { path: 'b.ts' },
      { path: 'dirty.ts' },
      { path: 'img.png' },
      { path: 'big.log' },
      { path: 'gone.ts' }
    ])
    const plan = await planReplaceAll({
      paths,
      options: literal('foo'),
      replacement: 'bar',
      hasUnsavedEdits: (path) => path === 'dirty.ts',
      readFile: async (path) => files[path] ?? null
    })
    expect(plan.matches).toBe(2)
    expect(plan.files.map((f) => [f.path, f.count, f.next])).toEqual([['a.ts', 2, 'bar bar']])
    expect(plan.skipped).toEqual([
      { path: 'dirty.ts', reason: 'unsaved' },
      { path: 'img.png', reason: 'binary' },
      { path: 'big.log', reason: 'truncated' },
      { path: 'gone.ts', reason: 'unreadable' }
    ])
  })
})

describe('helpers', () => {
  it('re-checks a grep line against the exact query', () => {
    const compiled = compileFind(literal('Foo', { matchCase: true }))
    if (!compiled.ok) throw new Error('should compile')
    expect(lineMatches(compiled.regex, 'a Foo b')).toBe(true)
    expect(lineMatches(compiled.regex, 'a foo b')).toBe(false)
    // The global regex's position is reset between lines.
    expect(lineMatches(compiled.regex, 'Foo')).toBe(true)
  })

  it('expands named groups', () => {
    const match = /(?<word>\w+)/.exec('hello')!
    expect(expandReplacement('<$<word>>', match)).toBe('<hello>')
  })

  it('counts in words', () => {
    expect(describeReplaceCount(1, 1)).toBe('1 match in 1 file')
    expect(describeReplaceCount(3, 2)).toBe('3 matches in 2 files')
  })
})
