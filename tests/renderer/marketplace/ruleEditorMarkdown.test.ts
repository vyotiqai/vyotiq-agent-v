import { describe, expect, it } from 'vitest'
import { parseRuleFrontmatter } from '@shared/rules'
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

  it('reads and rewrites frontmatter in a CRLF-authored rule file', () => {
    // The last frontmatter line keeps its CR (the block ends at the `\n` before
    // the closing fence) and `.` does not match a CR, so a line-anchored key
    // pattern missed that key: the editor opened this rule with an empty
    // description.
    const raw =
      '---\r\nalwaysApply: false\r\ndescription: "Docs only"\r\n---\r\n\r\nBody.\r\n'
    const parsed = parseRuleEditor(raw)
    expect(parsed.hadAlwaysApplyKey).toBe(true)
    expect(parsed.alwaysApply).toBe(false)
    expect(parsed.description).toBe('Docs only')

    const saved = serializeRuleEditor({ ...parsed, alwaysApply: true })
    expect(saved.match(/alwaysApply:/g)).toHaveLength(1)
    expect(saved).toContain('alwaysApply: true')
    expect(saved).toContain('Body.')
  })

  it('round-trips an unknown key the agent rule parser ignores', () => {
    const raw = ['---', 'owner: platform-team', 'alwaysApply: false', '---', '', 'Body.', ''].join(
      '\n'
    )
    // The agent only understands three keys; `owner` is not one of them.
    expect(parseRuleFrontmatter(raw).meta).toEqual({ alwaysApply: false })

    const parsed = parseRuleEditor(raw)
    expect(parsed.hadAlwaysApplyKey).toBe(true)
    expect(serializeRuleEditor(parsed)).toContain('owner: platform-team')
  })

  it('records an alwaysApply key the agent rule parser leaves unset', () => {
    // `maybe` is not a boolean, so the agent treats the flag as absent...
    expect(parseRuleFrontmatter('---\nalwaysApply: maybe\n---\nx').meta.alwaysApply).toBeUndefined()
    // ...while the editor still knows the line is there and must be rewritten.
    expect(parseRuleEditor('---\nalwaysApply: maybe\n---\nx').hadAlwaysApplyKey).toBe(true)
  })
})
