/**
 * `.docx` is the source of truth for bundled SKILL.md — `pnpm sync:docx-md`
 * regenerates the Markdown on postinstall and before every test run. The
 * conversion used to go through `docxParagraphs`, which flattens a Word table
 * into one paragraph per cell, so a shipped skill's reference tables arrived as
 * a stack of stray lines with the columns gone. Nothing failed: the skill still
 * installed, it just taught the agent from a scrambled document.
 */
import { describe, expect, it } from 'vitest'
import { renderTable, skillDocxToMarkdown } from '../../../scripts/sync-docx-md.mjs'
import { parseSkillFrontmatter } from '@main/agent/skills/parse'

describe('renderTable', () => {
  it('writes a GitHub table with a separator row', () => {
    expect(
      renderTable([
        ['Method', 'Path'],
        ['GET', '/users']
      ])
    ).toBe(['| Method | Path |', '| --- | --- |', '| GET | /users |'].join('\n'))
  })

  it('pads short rows so the column count stays square', () => {
    // A Word row with a merged or missing trailing cell would otherwise emit a
    // row narrower than the header, which renders as a broken table.
    const table = renderTable([['A', 'B', 'C'], ['only']])
    expect(table.split('\n').map((line) => line.split('|').length)).toEqual([5, 5, 5])
    expect(table).toContain('| only |  |  |')
  })

  it('escapes a pipe inside a cell instead of splitting the column', () => {
    expect(renderTable([['Type'], ['string | null']])).toContain('| string \\| null |')
  })

  it('returns nothing for a table with no rows', () => {
    expect(renderTable([])).toBe('')
  })
})

describe('skillDocxToMarkdown', () => {
  it('keeps a table as a table rather than one line per cell', () => {
    const markdown = skillDocxToMarkdown([
      {
        type: 'p',
        style: 'Heading2',
        text: 'name: demo description: A demo skill. metadata: version: "1.0.0"',
        border: false
      },
      { type: 'p', style: 'Heading1', text: 'Demo', border: false },
      {
        type: 'table',
        rows: [
          ['Field', 'Purpose'],
          ['name', 'Identifier']
        ]
      }
    ])

    expect(markdown).toContain('| Field | Purpose |')
    expect(markdown).toContain('| name | Identifier |')
    // The old output: bare cell text on its own line, no pipes anywhere.
    expect(markdown).not.toMatch(/^Field$/m)

    const parsed = parseSkillFrontmatter(markdown)
    expect(parsed.name).toBe('demo')
    expect(parsed.body).toContain('| Field | Purpose |')
  })
})
