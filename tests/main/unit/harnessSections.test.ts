import { describe, expect, it } from 'vitest'
import {
  HARNESS_SECTION_TAGS,
  isWellFormedHarness,
  splitHarnessSections
} from '@main/agent/harnessSections'
import { capHarness, capToTokenBudget } from '@main/agent/context/assemble'
import { parseOuterPromptSection, wrapPromptSection } from '@main/agent/promptSections'

describe('harnessSections', () => {
  it('treats markdown headings or paired allowlist tags as well-formed', () => {
    expect(isWellFormedHarness('# Agent V\n')).toBe(true)
    expect(isWellFormedHarness('<role>\nBe terse.\n</role>\n')).toBe(true)
    expect(isWellFormedHarness('plain text')).toBe(false)
    expect(isWellFormedHarness('<role>\nno close\n')).toBe(false)
  })

  it('splits XML allowlist tags and keeps mcp placeholders inside tool_policy', () => {
    const text = [
      '# Agent V',
      '',
      '<role>',
      'You are Agent V.',
      '</role>',
      '',
      '<tool_policy>',
      'MCP server tools are named `mcp__<serverId>__<toolName>`.',
      '</tool_policy>'
    ].join('\n')
    const chunks = splitHarnessSections(text)
    expect(chunks.map((c) => c.name)).toEqual(['', 'role', 'tool_policy'])
    const policy = chunks.find((c) => c.name === 'tool_policy')
    expect(policy?.text).toContain('mcp__<serverId>__<toolName>')
    expect(policy?.text.startsWith('<tool_policy>')).toBe(true)
    expect(policy?.text.endsWith('</tool_policy>')).toBe(true)
  })

  it('splits leftover markdown ## headings', () => {
    const text = '# Agent V\n\n## Role\nHello\n\n## Memory\nNotes\n'
    expect(splitHarnessSections(text).map((c) => c.name)).toEqual(['', 'Role', 'Memory'])
  })

  it('keeps nested example tags inside examples', () => {
    const text = [
      '<examples>',
      '<example>',
      'Do: Null-checked the missing value in src/parser.py:42.',
      '</example>',
      '</examples>'
    ].join('\n')
    const chunks = splitHarnessSections(text)
    expect(chunks.map((c) => c.name)).toEqual(['examples'])
    expect(chunks[0]?.text).toContain('<example>')
    expect(chunks[0]?.text).toContain('</example>')
    expect(chunks[0]?.text.startsWith('<examples>')).toBe(true)
    expect(chunks[0]?.text.endsWith('</examples>')).toBe(true)
  })

  it('keeps nested untrusted_content inside workspace_harness', () => {
    const text = [
      '<constraints>',
      'Keep writes inside the workspace.',
      '</constraints>',
      '<workspace_harness>',
      '<untrusted_content>',
      '## Role',
      'Be terse.',
      '</untrusted_content>',
      '</workspace_harness>'
    ].join('\n')
    const chunks = splitHarnessSections(text)
    expect(chunks.map((c) => c.name)).toEqual(['constraints', 'workspace_harness'])
    expect(chunks[1]?.text).toContain('<untrusted_content>')
    expect(chunks[1]?.text).toContain('## Role')
  })
})

describe('capHarness', () => {
  it('drops workspace_harness and memory before constraints under a tiny budget', () => {
    const text = [
      '<constraints>',
      `Keep writes inside root. ${'C'.repeat(60)}`,
      '</constraints>',
      '<memory>',
      `Notes live on disk. ${'M'.repeat(80)}`,
      '</memory>',
      '<workspace_harness>',
      '<untrusted_content>',
      `Be terse. ${'W'.repeat(80)}`,
      '</untrusted_content>',
      '</workspace_harness>'
    ].join('\n')
    expect(text.length).toBeGreaterThan(200)
    const capped = capHarness(text, 1)
    expect(capped).toContain('<constraints>')
    expect(capped).toContain('Keep writes inside root.')
    expect(capped).not.toContain('<workspace_harness>')
    expect(capped).not.toContain('<memory>')
  })

  it('drops markdown ## Workspace harness before ## Constraints', () => {
    const text = [
      '## Constraints',
      `Keep writes inside root. ${'C'.repeat(60)}`,
      '## Memory',
      `Notes live on disk. ${'M'.repeat(80)}`,
      '## Workspace harness',
      `Be terse. ${'W'.repeat(80)}`
    ].join('\n')
    expect(text.length).toBeGreaterThan(200)
    const capped = capHarness(text, 1)
    expect(capped).toContain('## Constraints')
    expect(capped).not.toContain('## Workspace harness')
    expect(capped).not.toContain('## Memory')
  })

  it('drops workspace_harness and memory before compaction under a tiny budget', () => {
    const text = [
      '<constraints>',
      'Keep writes inside root.',
      '</constraints>',
      '<compaction>',
      'The loop auto-compacts.',
      '</compaction>',
      '<memory>',
      `Notes live on disk. ${'M'.repeat(80)}`,
      '</memory>',
      '<workspace_harness>',
      '<untrusted_content>',
      `Be terse. ${'W'.repeat(80)}`,
      '</untrusted_content>',
      '</workspace_harness>'
    ].join('\n')
    expect(text.length).toBeGreaterThan(200)
    const capped = capHarness(text, 1)
    expect(capped).toContain('<constraints>')
    expect(capped).toContain('<compaction>')
    expect(capped).not.toContain('<workspace_harness>')
    expect(capped).not.toContain('<memory>')
  })

  it('drops examples before constraints under a tiny budget', () => {
    const text = [
      '<constraints>',
      `Keep writes inside root. ${'C'.repeat(60)}`,
      '</constraints>',
      '<examples>',
      `Do not: verbose recap. ${'E'.repeat(80)}`,
      '</examples>'
    ].join('\n')
    expect(text.length).toBeGreaterThan(200)
    const capped = capHarness(text, 1)
    expect(capped).toContain('<constraints>')
    expect(capped).toContain('Keep writes inside root.')
    expect(capped).not.toContain('<examples>')
  })

  it('keeps constraints paired when last-resort inner-cap is required', () => {
    const text = [
      '<role>',
      'You are Agent V.',
      '</role>',
      '<constraints>',
      `Keep writes inside root. ${'C'.repeat(4_000)}`,
      '</constraints>'
    ].join('\n')
    const capped = capHarness(text, 1)
    expect(capped).toContain('<constraints>')
    expect(capped).toContain('</constraints>')
    expect(capped).toContain('Keep writes inside root.')
    expect(capped.length).toBeLessThan(text.length)
    expect(capped.length).toBeLessThanOrEqual(200)
    const start = capped.indexOf('<constraints>')
    const end = capped.lastIndexOf('</constraints>')
    expect(start).toBeGreaterThanOrEqual(0)
    expect(end).toBeGreaterThan(start)
    expect(capped.slice(end)).toBe('</constraints>')
    expect(parseOuterPromptSection(capped.slice(start))?.tag).toBe('constraints')
  })
})

describe('capToTokenBudget', () => {
  const model = {
    id: 'test',
    inputModalities: ['text'] as const,
    outputModalities: ['text'] as const,
    supportsTools: true,
    supportsVision: false,
    contextWindow: 8_000
  }

  it('keeps a single overlay wrap paired when the body is truncated', () => {
    const wrapped = wrapPromptSection('workspace_rules', `Keep named exports.\n${'A'.repeat(8_000)}`)
    const capped = capToTokenBudget(wrapped, 20, model)
    expect(capped.startsWith('<workspace_rules>\n')).toBe(true)
    expect(capped.endsWith('\n</workspace_rules>')).toBe(true)
    expect(capped.length).toBeLessThan(wrapped.length)
    expect(capped).toContain('Keep named exports.')
    expect(parseOuterPromptSection(capped)?.tag).toBe('workspace_rules')
  })

  it('still truncates unwrapped text', () => {
    const capped = capToTokenBudget('plain '.repeat(2_000), 20, model)
    expect(capped.length).toBeLessThan('plain '.repeat(2_000).length)
    expect(capped).not.toMatch(/<\/[a-z]+>/)
  })
})

describe('HARNESS_SECTION_TAGS', () => {
  it('lists spine tags plus workspace_harness', () => {
    expect([...HARNESS_SECTION_TAGS]).toEqual([
      'role',
      'capabilities',
      'tool_policy',
      'constraints',
      'work_style',
      'memory',
      'compaction',
      'output_format',
      'patterns',
      'reference_points',
      'scope_boundaries',
      'aliases',
      'examples',
      'workspace_harness'
    ])
  })
})
