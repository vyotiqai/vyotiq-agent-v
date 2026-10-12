import { describe, expect, it } from 'vitest'
import { join } from 'path'
import { formatLspEditFeedback, lspEditFeedback, lspEditPath, lspEditTarget, newErrorsSince } from '@main/agent/editLspFeedback'

const err = (line: number, message: string) => ({ line, character: 0, message, severity: 'error' as const })

describe('edit LSP feedback', () => {
  it('targets edit and str_replace inside the workspace only', () => {
    const ws = join('C:', 'ws')
    expect(lspEditPath(ws, 'str_replace', { path: 'src/a.ts' })).toBe('src/a.ts')
    expect(lspEditPath(ws, 'edit', { path: join(ws, 'src', 'b.ts') })).toBe('src/b.ts')
    expect(lspEditPath(ws, 'edit', { path: '../outside.ts' })).toBeNull()
    expect(lspEditPath(ws, 'read', { path: 'src/a.ts' })).toBeNull()
    // No server running for it: nothing to target, nothing awaited.
    expect(lspEditTarget(ws, 'str_replace', { path: 'src/a.ts' })).toBeNull()
  })

  it('reports only errors the edit added', () => {
    const before = [err(3, "Cannot find name 'x'.")]
    const after = [err(5, "Cannot find name 'x'."), err(9, "Property 'foo' does not exist.")]
    expect(newErrorsSince(before, after).map((d) => d.message)).toEqual(["Property 'foo' does not exist."])
    expect(newErrorsSince(null, after)).toHaveLength(2)
  })

  it('formats a capped, 1-based list, and says nothing when clean', () => {
    const many = Array.from({ length: 10 }, (_, i) => err(i, `e${i}`))
    const text = formatLspEditFeedback('TypeScript Language Server', 'src/a.ts', many)!
    expect(text.split('\n')[0]).toBe('[TypeScript Language Server: 10 new errors in src/a.ts after this edit]')
    expect(text).toContain('  1:1 e0')
    expect(text).toContain('…and 2 more')
    expect(formatLspEditFeedback('TS', 'a.ts', [])).toBeNull()
    expect(formatLspEditFeedback('TS', 'a.ts', [err(0, 'x')], { comparedWithBefore: false })).toMatch(/1 error in/)
  })

  it('stays silent when no language server is running for the file', async () => {
    expect(await lspEditFeedback(process.cwd(), 'package.json', null)).toBeNull()
  })
})
