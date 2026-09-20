/**
 * `.docx` is the source of truth for bundled SKILL.md — `pnpm sync:docx-md`
 * regenerates the Markdown on postinstall and before every test run. The
 * conversion used to go through `docxParagraphs`, which flattens a Word table
 * into one paragraph per cell, so a shipped skill's reference tables arrived as
 * a stack of stray lines with the columns gone. Nothing failed: the skill still
 * installed, it just taught the agent from a scrambled document.
 */
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { renderTable, skillDocxToMarkdown } from '../../../scripts/sync-docx-md.mjs'
import { docxBlocks } from '../../../scripts/sync-harness.mjs'
import { parseSkillFrontmatter } from '@main/agent/skills/parse'

const PACKAGES = join(process.cwd(), 'resources/marketplace/packages')

function skillMarkdownFor(id: string): string {
  return skillDocxToMarkdown(docxBlocks(readFileSync(join(PACKAGES, id, 'SKILL.md.docx'))))
}

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

describe('the bundled skills that ship a table', () => {
  it.each(['create-skill', 'analyze-api'])('%s converts its tables intact', (id) => {
    const fromDocx = skillMarkdownFor(id)
    const tables = docxBlocks(readFileSync(join(PACKAGES, id, 'SKILL.md.docx'))).filter(
      (block: { type: string }) => block.type === 'table'
    )
    expect(tables.length).toBeGreaterThan(0)

    for (const table of tables as Array<{ rows: string[][] }>) {
      expect(fromDocx).toContain(`| ${table.rows[0].join(' | ')} |`)
    }

    // The committed .md is generated, so it must already match — otherwise the
    // tree is out of sync with its source and `pnpm sync:docx-md` is pending.
    expect(readFileSync(join(PACKAGES, id, 'SKILL.md'), 'utf8')).toBe(fromDocx)
  })

  it('gives analyze-api the frontmatter its Word source was missing', () => {
    // It was the one bundled skill whose .docx had no `name: … description: …`
    // paragraph, so the generated SKILL.md had no frontmatter to parse at all.
    const parsed = parseSkillFrontmatter(skillMarkdownFor('analyze-api'))
    expect(parsed.name).toBe('analyze-api')
    expect(parsed.description).toMatch(/Use when/)
  })
})
