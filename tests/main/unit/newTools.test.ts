import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { toolGlob } from '@main/agent/tools/glob'
import { toolSearch } from '@main/agent/tools/search'
import { toolGrep } from '@main/agent/tools/grep'
import { toolListDir } from '@main/agent/tools/listDir'
import { toolDelete } from '@main/agent/tools/deletePath'
import { toolStrReplace } from '@main/agent/tools/strReplace'
import { readTodos, toolTodoWrite } from '@main/agent/tools/todo'
import { htmlToMarkdown, spaShellWarning, extractMainHtml } from '@main/agent/tools/webFetch'
import { globToRegExp } from '@main/agent/tools/walk'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
  mkdirSync(join(root, 'src', 'nested'), { recursive: true })
  mkdirSync(join(root, 'build'), { recursive: true })
  writeFileSync(join(root, '.gitignore'), 'ignored.ts\n', 'utf8')
  writeFileSync(join(root, 'README.md'), '# Readme\nalpha\n', 'utf8')
  writeFileSync(join(root, 'src', 'a.ts'), 'export const alpha = 1\nconst other = 2\n', 'utf8')
  writeFileSync(join(root, 'src', 'nested', 'b.ts'), 'export const beta = alpha\n', 'utf8')
  writeFileSync(join(root, 'src', 'ignored.ts'), 'export const ignored = true\n', 'utf8')
  writeFileSync(join(root, 'build', 'bundle.js'), 'alpha\n', 'utf8')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('globToRegExp', () => {
  it('matches ** across directories and zero directories', () => {
    const re = globToRegExp('src/**/*.ts')
    expect(re.test('src/a.ts')).toBe(true)
    expect(re.test('src/nested/b.ts')).toBe(true)
    expect(re.test('lib/a.ts')).toBe(false)
  })

  it('honours brace alternatives and single-segment stars', () => {
    const re = globToRegExp('*.{md,txt}')
    expect(re.test('README.md')).toBe(true)
    expect(re.test('notes.txt')).toBe(true)
    expect(re.test('src/README.md')).toBe(false)
  })

  it('escapes * and ? inside brace alternatives without throwing', () => {
    const re = globToRegExp('**/{AGENTS.md,package.json,README*,*.md}')
    expect(re.test('README*')).toBe(true)
    expect(re.test('*.md')).toBe(true)
    expect(re.test('AGENTS.md')).toBe(true)
    expect(re.test('README.md')).toBe(false)
  })
})

describe('toolGlob', () => {
  it('lists matching files and skips gitignored and build output', async () => {
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/nested/b.ts')
    expect(out).not.toContain('ignored.ts')
    expect(out).not.toContain('bundle.js')
  })

  it('reports no matches without throwing', async () => {
    expect(await toolGlob(root, '**/*.rs')).toContain('No files match')
    expect(await toolGlob(root, '**/*.rs')).not.toContain('Nested matches:')
  })

  it('lists nested matches when a root-relative glob misses a nested project folder', async () => {
    mkdirSync(join(root, 'murmur-youtube-main', 'windows'), { recursive: true })
    writeFileSync(
      join(root, 'murmur-youtube-main', 'windows', 'Murmur.CrossPlatform.slnf'),
      '<Solution />\n',
      'utf8'
    )
    writeFileSync(
      join(root, 'murmur-youtube-main', 'windows', 'Murmur.App.csproj'),
      '<Project />\n',
      'utf8'
    )
    const out = await toolGlob(root, 'windows/**/*.{sln,slnf,csproj}')
    expect(out).toContain('No files match windows/**/*.{sln,slnf,csproj}')
    expect(out).toContain('Paths are relative to the workspace root.')
    expect(out).toContain('Nested matches:')
    expect(out).toContain('murmur-youtube-main/windows/Murmur.CrossPlatform.slnf')
    expect(out).toContain('murmur-youtube-main/windows/Murmur.App.csproj')
  })

  it('defaults to 100 paths with a … N more suffix for a larger set', async () => {
    mkdirSync(join(root, 'gen'), { recursive: true })
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(root, 'gen', `f${String(i).padStart(3, '0')}.txt`), 'x\n', 'utf8')
    }
    const out = await toolGlob(root, 'gen/*.txt')
    const listed = out.split('\n').filter((l) => l.startsWith('gen/'))
    expect(listed).toHaveLength(100)
    expect(out).toContain('… 50 more (raise maxResults or narrow the pattern)')
  })

  it('honours an explicit maxResults over the 100 default', async () => {
    mkdirSync(join(root, 'gen'), { recursive: true })
    for (let i = 0; i < 150; i++) {
      writeFileSync(join(root, 'gen', `f${String(i).padStart(3, '0')}.txt`), 'x\n', 'utf8')
    }
    const out = await toolGlob(root, 'gen/*.txt', 10)
    const listed = out.split('\n').filter((l) => l.startsWith('gen/'))
    expect(listed).toHaveLength(10)
    expect(out).toContain('… 140 more (raise maxResults or narrow the pattern)')
  })

  it('lists everything without a suffix when under the default cap', async () => {
    const out = await toolGlob(root, '**/*.ts')
    expect(out).toContain('src/a.ts')
    expect(out).toContain('src/nested/b.ts')
    expect(out).not.toContain('more (raise maxResults or narrow the pattern)')
  })
})

describe('toolGrep', () => {
  it('reports every matching line, not just the first file', async () => {
    const out = await toolGrep(root, 'alpha')
    expect(out).toContain('README.md:2')
    expect(out).toContain('src/a.ts:1')
    expect(out).toContain('src/nested/b.ts:1')
  })

  it('limits the search with an include glob', async () => {
    const out = await toolGrep(root, 'alpha', { include: 'src/**/*.ts' })
    expect(out).toContain('src/a.ts:1')
    expect(out).not.toContain('README.md')
  })

  it('adds context lines around a hit', async () => {
    const out = await toolGrep(root, 'other', { contextLines: 1 })
    expect(out).toContain('> 2|')
    expect(out).toContain('  1|')
  })

  it('rejects an invalid pattern instead of matching nothing', async () => {
    await expect(toolGrep(root, '([')).rejects.toThrow(/Invalid regex/)
  })
})

describe('toolSearch', () => {
  const writeNeedleFiles = (count: number) => {
    for (let i = 0; i < count; i++) {
      writeFileSync(join(root, 'src', `gen${String(i).padStart(3, '0')}.ts`), `export const needle = ${i}\n`, 'utf8')
    }
  }

  it('defaults to 40 hits and reports the truncation notice', async () => {
    writeNeedleFiles(70)
    const out = await toolSearch(root, 'needle')
    const hitLines = out.split('\n').filter((l) => l.includes('needle'))
    expect(hitLines).toHaveLength(40)
    expect(out).toContain('… stopped at 40 matches')
  })

  it('honours an explicit maxResults over the 40 default', async () => {
    writeNeedleFiles(70)
    const out = await toolSearch(root, 'needle', 5)
    const hitLines = out.split('\n').filter((l) => l.includes('needle'))
    expect(hitLines).toHaveLength(5)
    expect(out).toContain('… stopped at 5 matches')
  })

  it('shows no truncation notice under the default cap', async () => {
    const out = await toolSearch(root, 'alpha')
    expect(out).toContain('README.md:2')
    expect(out).not.toContain('stopped at')
  })
})

describe('toolListDir', () => {
  it('lists directories first and hides ignored entries', () => {
    const out = toolListDir(root, 'src')
    expect(out.indexOf('[dir]  nested/')).toBeLessThan(out.indexOf('[file] a.ts'))
    expect(out).not.toContain('ignored.ts')
  })

  it('refuses a file path', () => {
    expect(() => toolListDir(root, 'README.md')).toThrow(/Not a directory/)
  })
})

describe('toolDelete', () => {
  it('deletes a file', () => {
    expect(toolDelete(root, 'README.md')).toContain('Deleted README.md')
    expect(existsSync(join(root, 'README.md'))).toBe(false)
  })

  it('requires recursive for a non-empty directory', () => {
    expect(() => toolDelete(root, 'src')).toThrow(/recursive=true/)
    expect(existsSync(join(root, 'src'))).toBe(true)
    toolDelete(root, 'src', true)
    expect(existsSync(join(root, 'src'))).toBe(false)
  })

  it('refuses to escape the workspace or delete its root', () => {
    expect(() => toolDelete(root, '..')).toThrow()
    expect(() => toolDelete(root, '.')).toThrow(/workspace root/)
  })

  it('reports File not found with similar names when the path is missing', () => {
    expect(() => toolDelete(root, 'src/missing.ts')).toThrow(/File not found: src\/missing\.ts/)
    expect(() => toolDelete(root, 'src/missing.ts')).toThrow(/Similar names in parent directory/)
  })
})

describe('toolStrReplace', () => {
  it('replaces a unique occurrence', () => {
    const out = toolStrReplace(root, 'src/a.ts', 'alpha', 'gamma')
    expect(out).toContain('1 occurrence')
    expect(readFileSync(join(root, 'src', 'a.ts'), 'utf8')).toContain('gamma')
  })

  it('fails when old_string matches more than once unless replace_all', () => {
    writeFileSync(join(root, 'dup.ts'), 'aa aa aa\n', 'utf8')
    expect(() => toolStrReplace(root, 'dup.ts', 'aa', 'bb')).toThrow(/matched 3 times/)
    const out = toolStrReplace(root, 'dup.ts', 'aa', 'bb', true)
    expect(out).toContain('3 occurrences')
    expect(readFileSync(join(root, 'dup.ts'), 'utf8')).toBe('bb bb bb\n')
  })

  it('fails when old_string is missing', () => {
    expect(() => toolStrReplace(root, 'src/a.ts', 'nope', 'x')).toThrow(/not found/)
  })

  it('does not treat an empty file line as the closest match', () => {
    writeFileSync(
      join(root, 'loopish.ts'),
      ['import { x } from "y"', '', '', 'export const keep = 1', ''].join('\n'),
      'utf8'
    )
    try {
      toolStrReplace(root, 'loopish.ts', 'export const REMOVED_CONSTANT = 1', 'export const keep = 2')
      expect.fail('expected throw')
    } catch (err) {
      const text = String(err)
      expect(text).toMatch(/old_string not found/)
      expect(text).not.toMatch(/Closest match near line \d+: ""/)
      expect(text).toMatch(/export const keep = 1/)
    }
  })
})

describe('toolTodoWrite', () => {
  it('persists the list and renders progress', () => {
    const { content } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'completed' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])

    expect(content).toContain('1/2 complete')
    expect(content).toContain('[x] (1) First')
    expect(content).toContain('[~] (2) Second')
    expect(readTodos(root)).toHaveLength(2)
  })

  it('merges status updates into the existing list', () => {
    toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'pending' },
      { id: '2', content: 'Second', status: 'pending' }
    ])
    toolTodoWrite(root, [{ id: '2', content: 'Second', status: 'completed' }], true)

    const todos = readTodos(root)
    expect(todos).toHaveLength(2)
    expect(todos.find((todo) => todo.id === '2')?.status).toBe('completed')
  })

  it('backfills omitted content from the stored todo on status-only merges', () => {
    toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'pending' },
      { id: '2', content: 'Second', status: 'pending' }
    ])
    const { content, todos } = toolTodoWrite(root, [{ id: '1', status: 'completed' }], true)

    expect(todos.find((todo) => todo.id === '1')).toEqual({
      id: '1',
      content: 'First',
      status: 'completed'
    })
    expect(todos.find((todo) => todo.id === '2')?.content).toBe('Second')
    expect(content).toContain('1/2 complete')
    expect(content).toContain('[x] (1) First')
  })

  it('drops an omitted-content merge entry with no stored match', () => {
    toolTodoWrite(root, [{ id: '1', content: 'First', status: 'pending' }])
    const { todos } = toolTodoWrite(root, [{ id: 'missing', status: 'completed' }], true)

    expect(todos).toEqual([{ id: '1', content: 'First', status: 'pending' }])
  })

  it('upserts a new id with content on merge', () => {
    toolTodoWrite(root, [{ id: '1', content: 'First', status: 'pending' }])
    toolTodoWrite(root, [{ id: '2', content: 'Second', status: 'in_progress' }], true)

    const todos = readTodos(root)
    expect(todos).toHaveLength(2)
    expect(todos.find((todo) => todo.id === '2')).toEqual({
      id: '2',
      content: 'Second',
      status: 'in_progress'
    })
  })

  it('auto-demotes earlier in-progress tasks, keeping the last', () => {
    const { content, todos, notice } = toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'in_progress' },
      { id: '2', content: 'Second', status: 'in_progress' }
    ])
    expect(todos.find((todo) => todo.id === '1')?.status).toBe('pending')
    expect(todos.find((todo) => todo.id === '2')?.status).toBe('in_progress')
    expect(notice).toMatch(/demoted 1 to pending/i)
    expect(content).not.toMatch(/^Note:/m)
    expect(content).toContain('[ ] (1) First')
    expect(content).toContain('[~] (2) Second')
  })

  it('collapses newlines in content and keeps one line per task', () => {
    const { content, todos } = toolTodoWrite(root, [
      { id: '1', content: 'First\nline', status: 'pending' }
    ])
    expect(todos[0]?.content).toBe('First line')
    expect(content).toBe('0/1 complete\n[ ] (1) First line')
  })

  it('summarizes merged list length, not input length', async () => {
    toolTodoWrite(root, [
      { id: '1', content: 'First', status: 'pending' },
      { id: '2', content: 'Second', status: 'pending' },
      { id: '3', content: 'Third', status: 'pending' }
    ])
    const result = await executeTool(
      'todo_write',
      JSON.stringify({
        todos: [{ id: '2', content: 'Second', status: 'completed' }],
        merge: true
      }),
      root,
      new AbortController().signal,
      { runDir: root }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('3 tasks')
    expect(result.content).toContain('1/3 complete')
  })
})

describe('htmlToMarkdown', () => {
  it('keeps headings, links and list items while dropping scripts', () => {
    const md = htmlToMarkdown(
      '<html><head><style>body{}</style></head><body><h1>Title</h1><script>evil()</script>' +
        '<p>Hello &amp; welcome</p><ul><li>one</li><li>two</li></ul>' +
        '<a href="https://example.test">link</a></body></html>'
    )

    expect(md).toContain('# Title')
    expect(md).toContain('Hello & welcome')
    expect(md).toContain('- one')
    expect(md).toContain('[link](https://example.test)')
    expect(md).not.toContain('evil()')
    expect(md).not.toContain('body{}')
  })

  it('strips nav chrome and empty list bullets from SPA shells', () => {
    const hfShell =
      '<html><body>' +
      '<header><nav><ul><li></li><li><a href="/models">Models</a></li>' +
      '<li><a href="/datasets">Datasets</a></li><li><a href="/spaces">Spaces</a></li></ul></nav></header>' +
      '<main><h1>LFM2.5-2.6B-GGUF</h1><p>Compact edge model for on-device inference.</p>' +
      '<ul><li>Q4_K_M quant</li><li>5.0 GB total</li></ul></main>' +
      '<footer><a href="/pricing">Pricing</a></footer>' +
      '</body></html>'

    const md = htmlToMarkdown(hfShell)

    expect(md).toContain('LFM2.5-2.6B-GGUF')
    expect(md).toContain('Compact edge model')
    expect(md).toContain('- Q4_K_M quant')
    expect(md).not.toMatch(/^-\s*$/m)
    expect(md).not.toContain('Models')
    expect(md).not.toContain('Datasets')
    expect(md).not.toContain('Pricing')
  })

  it('prefers main landmark content when present', () => {
    const html =
      '<div><nav>Skip me</nav><main><h2>Real title</h2><p>Body copy with enough substance to keep.</p></main></div>'
    expect(extractMainHtml(html)).toContain('Real title')
    expect(extractMainHtml(html)).not.toContain('Skip me')
  })
})

describe('spaShellWarning', () => {
  it('warns when markdown is mostly navigation labels', () => {
    const md = [
      '- Models',
      '- Datasets',
      '- Spaces',
      '- Docs',
      '- Enterprise',
      '- Pricing'
    ].join('\n')

    expect(spaShellWarning(md)).toMatch(/JavaScript-rendered shell/i)
  })

  it('does not warn when substantive prose is present', () => {
    const md = [
      '# LiquidAI/LFM2.5-2.6B-GGUF',
      'Compact edge model for on-device inference with 2.6B parameters.',
      'Recommended quant: Q4_K_M (~1.6 GB download).',
      'Use huggingface-cli download LiquidAI/LFM2.5-2.6B-GGUF --include "*.gguf"'
    ].join('\n')

    expect(spaShellWarning(md)).toBeNull()
  })
})
