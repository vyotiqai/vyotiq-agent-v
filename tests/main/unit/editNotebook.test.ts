import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'
import { toolEditNotebook } from '@main/agent/tools/editNotebook'

function notebook(cells: Array<{ cell_type: string; source: string[] }>): string {
  return `${JSON.stringify(
    {
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells
    },
    null,
    2
  )}\n`
}

describe('edit_notebook', () => {
  const signal = new AbortController().signal

  it('creates a notebook cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nb-'))
    const result = toolEditNotebook(dir, {
      target_notebook: 'demo.ipynb',
      cell_idx: 0,
      is_new_cell: true,
      cell_language: 'python',
      new_string: 'print("hi")'
    })
    expect(result).toMatch(/Created/)
    const parsed = JSON.parse(readFileSync(join(dir, 'demo.ipynb'), 'utf8')) as {
      cells: Array<{ source: string[] }>
    }
    expect(parsed.cells).toHaveLength(1)
    expect(parsed.cells[0]!.source.join('')).toContain('print("hi")')
  })

  it('replaces a unique snippet in a cell', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nb-'))
    writeFileSync(
      join(dir, 'demo.ipynb'),
      notebook([{ cell_type: 'code', source: ['x = 1\n', 'y = 2\n'] }]),
      'utf8'
    )
    const result = toolEditNotebook(dir, {
      target_notebook: 'demo.ipynb',
      cell_idx: 0,
      old_string: 'x = 1',
      new_string: 'x = 3'
    })
    expect(result).toMatch(/Updated cell 0/)
    const parsed = JSON.parse(readFileSync(join(dir, 'demo.ipynb'), 'utf8')) as {
      cells: Array<{ source: string[] }>
    }
    expect(parsed.cells[0]!.source.join('')).toContain('x = 3')
  })

  it('errors when the cell is missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nb-'))
    writeFileSync(
      join(dir, 'demo.ipynb'),
      notebook([{ cell_type: 'code', source: ['ok'] }]),
      'utf8'
    )
    expect(() =>
      toolEditNotebook(dir, {
        target_notebook: 'demo.ipynb',
        cell_idx: 4,
        old_string: 'ok',
        new_string: 'nope'
      })
    ).toThrow(/out of range/)
  })

  it('errors on invalid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nb-'))
    writeFileSync(join(dir, 'demo.ipynb'), '{not json', 'utf8')
    expect(() =>
      toolEditNotebook(dir, {
        target_notebook: 'demo.ipynb',
        cell_idx: 0,
        old_string: 'a',
        new_string: 'b'
      })
    ).toThrow(/not valid notebook JSON/)
  })

  it('Ask mode denies edit_notebook', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-nb-'))
    const result = await executeTool(
      'edit_notebook',
      JSON.stringify({
        target_notebook: 'demo.ipynb',
        cell_idx: 0,
        is_new_cell: true,
        cell_language: 'python',
        new_string: 'print(1)'
      }),
      dir,
      signal,
      { agentMode: 'ask' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Ask mode does not allow/)
    expect(existsSync(join(dir, 'demo.ipynb'))).toBe(false)
  })
})
