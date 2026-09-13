import { describe, expect, it } from 'vitest'
import { parseRuleEditor, serializeRuleEditor } from '@renderer/features/marketplace/ruleEditorMarkdown'

describe('rule editor markdown', () => {
  it('preserves glob lists and other unknown frontmatter on save', () => {
    const raw = [
      '---',
      'globs:',
      '  - "*.ts"',
      '  - "*.tsx"',
      'alwaysApply: false',
      'description: TypeScript modules in this workspace',
      '---',
      '',
      'Prefer named exports.',
      ''
    ].join('\n')
    const parsed = parseRuleEditor(raw)
    expect(parsed.alwaysApply).toBe(false)
    expect(parsed.hadAlwaysApplyKey).toBe(true)
    expect(parsed.description).toBe('TypeScript modules in this workspace')
    expect(parsed.body).toContain('Prefer named exports')
    const saved = serializeRuleEditor({
      ...parsed,
      body: 'Prefer named exports in every TypeScript module.\n'
    })
    expect(saved).toContain('globs:')
    expect(saved).toContain('- "*.ts"')
    expect(saved).toContain('- "*.tsx"')
    expect(saved).toContain('alwaysApply: false')
    expect(saved).toContain('Prefer named exports in every TypeScript module')
  })

  it('does not insert alwaysApply into glob-only Cursor rules', () => {
    const raw = [
      '---',
      'globs: "*.md"',
      'description: Docs only',
      '---',
      '',
      'Keep the runbook in docs/release-runbook.md.',
      ''
    ].join('\n')
    const parsed = parseRuleEditor(raw)
    expect(parsed.hadAlwaysApplyKey).toBe(false)
    expect(parsed.alwaysApply).toBe(true)
    const saved = serializeRuleEditor(parsed)
    expect(saved).toContain('globs: "*.md"')
    expect(saved).not.toMatch(/^alwaysApply:/m)
    expect(saved).toContain('Keep the runbook')
  })

  it('writes alwaysApply when the user turns a glob-only rule off', () => {
    const raw = ['---', 'globs: "*.md"', '---', '', 'Docs.', ''].join('\n')
    const parsed = parseRuleEditor(raw)
    const saved = serializeRuleEditor({ ...parsed, alwaysApply: false })
    expect(saved).toContain('globs: "*.md"')
    expect(saved).toContain('alwaysApply: false')
  })
})
