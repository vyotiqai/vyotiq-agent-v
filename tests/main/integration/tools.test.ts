import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyUnifiedDiff, toolEdit } from '@main/agent/tools/edit'
import { toolSearch } from '@main/agent/tools/search'
import { toolRead } from '@main/agent/tools/read'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'

describe('tools', () => {
  it('applies unified diff and writes via toolEdit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
    const original = 'line1\nline2\nline3\n'
    const diff = `@@ -1,3 +1,3 @@
 line1
-line2
+line2-changed
 line3
`
    expect(applyUnifiedDiff(original, diff)).toBe('line1\nline2-changed\nline3\n')

    writeFileSync(join(dir, 'a.txt'), original, 'utf8')
    expect(toolEdit(dir, 'a.txt', undefined, diff)).toBe('Applied diff to a.txt')
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('line2-changed')

    expect(toolEdit(dir, 'b/new.txt', 'hello', undefined)).toBe('Created b/new.txt (5 chars)')
    expect(readFileSync(join(dir, 'b', 'new.txt'), 'utf8')).toBe('hello')
    expect(toolEdit(dir, 'b/new.txt', 'hello!', undefined)).toBe('Wrote b/new.txt (6 chars)')
    expect(() => toolEdit(dir, 'a.txt', '', undefined)).toThrow(/refuses.*empty contents/i)
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toContain('line2-changed')
    expect(toolEdit(dir, 'b/empty.txt', '', undefined)).toBe('Created b/empty.txt (0 chars)')
  })

  it('accepts bare @@ hunk headers (T1/E5)', () => {
    const original = [
      '  <script src="js/audio.js"></script>',
      '  <script src="js/input.js"></script>',
      '  <script src="js/particles.js"></script>',
      '  <script src="js/game.js"></script>',
      ''
    ].join('\n')
    const diff = [
      '@@',
      '-  <script src="js/audio.js"></script>',
      '-  <script src="js/input.js"></script>',
      '-  <script src="js/particles.js"></script>',
      '-  <script src="js/game.js"></script>',
      '+  <script src="js/setup.js"></script>',
      '+  <script src="js/audio.js"></script>',
      '+  <script src="js/input.js"></script>',
      '+  <script src="js/particles.js"></script>',
      '+  <script src="js/entities.js"></script>',
      '+  <script src="js/flow.js"></script>',
      '+  <script src="js/game.js"></script>',
      ''
    ].join('\n')
    const next = applyUnifiedDiff(original, diff)
    expect(next).toContain('js/setup.js')
    expect(next).toContain('js/entities.js')
    expect(next).toContain('js/flow.js')
  })

  it('rejects path escapes on edit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tools-'))
    toolTodoWrite(dir, [{ id: '1', content: 'Write a workspace file', status: 'in_progress' }])
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: '../escape.txt', contents: 'x' }),
      dir,
      signal,
      { runDir: dir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Path escapes workspace/i)
    expect(result.content).not.toMatch(/Agent mode requires todo_write/)
  })

  it('does not collapse absolute path-escapes to a basename in tool results', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tools-escape-'))
    const signal = new AbortController().signal
    const result = await executeTool(
      'read',
      JSON.stringify({ path: 'C:\\Users\\ajay\\AppData\\Roaming\\vyotiq' }),
      dir,
      signal,
      { runDir: dir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/outside the workspace root/i)
    expect(result.content).not.toBe('Path escapes workspace: vyotiq')
    expect(result.content).not.toMatch(/Roaming/i)
  })

  it('rejects empty search query (would otherwise match everything)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-empty-'))
    writeFileSync(join(dir, 'a.ts'), 'x\n', 'utf8')
    await expect(toolSearch(dir, '  ', 40)).rejects.toThrow(/required/i)
  })

  it('search is substring not regex', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-search-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'const foo = 1\n', 'utf8')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const bar = 2\n', 'utf8')

    const hits = await toolSearch(dir, 'foo', 40)
    expect(hits).toMatch(/a\.ts/)
    expect(hits).not.toMatch(/b\.ts/)

    const literal = await toolSearch(dir, 'foo.*', 40)
    expect(literal).toMatch(/No matches/i)
  })

  it('honors AbortSignal on search/read/edit path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-abort-'))
    writeFileSync(join(dir, 'x.txt'), 'hello', 'utf8')
    const ac = new AbortController()
    ac.abort()
    await expect(
      executeTool('read', JSON.stringify({ path: 'x.txt' }), dir, ac.signal)
    ).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reads files inside workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-read-'))
    writeFileSync(join(dir, 'r.txt'), 'payload', 'utf8')
    expect(await toolRead(dir, 'r.txt')).toBe('payload')
  })

  it('reads and writes memory tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-mem-tools-'))
    const signal = new AbortController().signal
    const write = await executeTool(
      'memory_write',
      JSON.stringify({ path: 'notes/t.md', contents: 'note' }),
      dir,
      signal
    )
    expect(write.ok).toBe(true)
    const read = await executeTool(
      'memory_read',
      JSON.stringify({ path: 'notes/t.md' }),
      dir,
      signal
    )
    expect(read.content).toContain('note')
    const list = await executeTool('memory_list', '{}', dir, signal)
    expect(list.content).toContain('t.md')
  })
})
