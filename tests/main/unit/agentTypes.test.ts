import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  agentTypeToolAllowlist,
  buildAgentTypesSection,
  clearAgentTypesCache,
  findAgentType,
  formatAgentTypeInstructions,
  loadAgentTypes,
  parseAgentTypeMarkdown,
  resolveAgentType,
  resolveAgentTypeModel,
  setUserAgentTypesDirForTests,
  unknownAgentTypeError
} from '@main/agent/agentTypes'
import { assertToolAllowedInMode, filterToolDefsForMode } from '@main/agent/tools/modePolicy'
import { assertNotRetiredAgentDataPath } from '@main/agent/tools/writeGuard'

/** Claude Code's documented subagent example, verbatim in shape. */
const CLAUDE_CODE_REVIEWER = `---
name: code-reviewer
description: Expert code review specialist. Proactively reviews code for quality, security, and maintainability. Use immediately after writing or modifying code.
tools: Read, Grep, Glob, Bash
model: inherit
color: blue
---

You are a senior code reviewer ensuring high standards of code quality and security.

When invoked:
1. Run git diff to see recent changes
2. Focus on modified files
`

describe('parseAgentTypeMarkdown', () => {
  it('reads a Claude Code subagent file, mapping its tool names onto the builtins', () => {
    const parsed = parseAgentTypeMarkdown(CLAUDE_CODE_REVIEWER)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.type.name).toBe('code-reviewer')
    expect(parsed.type.description).toMatch(/^Expert code review specialist\./)
    expect(parsed.type.tools).toEqual(['read', 'grep', 'glob', 'terminal'])
    expect(parsed.type.model).toBe('inherit')
    expect(parsed.type.body).toMatch(/^You are a senior code reviewer/)
    expect(parsed.warnings).toEqual([])
  })

  it('takes tools as a block list or a flow list, and leaves them unrestricted when absent', () => {
    const block = parseAgentTypeMarkdown('---\nname: a\ndescription: d\ntools:\n  - read\n  - Edit\n---\nbody')
    expect(block.ok && block.type.tools).toEqual(['read', 'edit', 'str_replace'])
    const flow = parseAgentTypeMarkdown('---\nname: a\ndescription: d\ntools: [grep, "mcp__github__*"]\n---\n')
    expect(flow.ok && flow.type.tools).toEqual(['grep', 'mcp__github'])
    const open = parseAgentTypeMarkdown('---\nname: a\ndescription: d\n---\nbody')
    expect(open.ok && open.type.tools).toBeUndefined()
  })

  it('drops unknown and nesting tools with a warning, and rejects a list that keeps nothing', () => {
    const partial = parseAgentTypeMarkdown('---\nname: a\ndescription: d\ntools: Read, Frobnicate, Task\n---\n')
    expect(partial.ok).toBe(true)
    if (partial.ok) {
      expect(partial.type.tools).toEqual(['read'])
      expect(partial.warnings.join(' ')).toMatch(/unknown tool "Frobnicate"/)
      expect(partial.warnings.join(' ')).toMatch(/"Task" \(helpers cannot spawn helpers/)
    }
    const none = parseAgentTypeMarkdown('---\nname: a\ndescription: d\ntools: Frobnicate\n---\n')
    expect(none).toEqual({ ok: false, error: 'tools names no tool a helper can use' })
  })

  it('rejects a file without frontmatter, without a description, or with a bad name', () => {
    expect(parseAgentTypeMarkdown('just a body').ok).toBe(false)
    expect(parseAgentTypeMarkdown('---\nname: a\n').ok).toBe(false)
    const noDescription = parseAgentTypeMarkdown('---\nname: reviewer\n---\nbody')
    expect(noDescription).toEqual({ ok: false, error: 'description is required' })
    const badName = parseAgentTypeMarkdown('---\nname: two words\ndescription: d\n---\n')
    expect(badName.ok).toBe(false)
    if (!badName.ok) expect(badName.error).toMatch(/name may use only/)
  })
})

describe('loadAgentTypes', () => {
  const root = join(tmpdir(), `vyotiq-agent-types-${process.pid}-${Date.now()}`)
  const workspace = join(root, 'ws')
  const userDir = join(root, 'user-agent-types')
  const write = (dir: string, name: string, text: string): string => {
    mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, text)
    return path
  }
  const typeFile = (name: string, description: string, body = 'instructions'): string =>
    `---\nname: ${name}\ndescription: ${description}\n---\n${body}\n`

  beforeEach(() => {
    mkdirSync(workspace, { recursive: true })
    setUserAgentTypesDirForTests(userDir)
    clearAgentTypesCache()
  })

  afterEach(() => {
    setUserAgentTypesDirForTests(null)
    rmSync(root, { recursive: true, force: true })
  })

  it('lets the workspace override the user on a name clash, .vyotiq over .claude', () => {
    write(join(workspace, '.vyotiq', 'agent-types'), 'reviewer.md', typeFile('reviewer', 'workspace reviewer'))
    write(join(workspace, '.claude', 'agents'), 'reviewer.md', typeFile('Reviewer', 'claude reviewer'))
    write(join(workspace, '.claude', 'agents'), 'tester.md', typeFile('tester', 'claude tester'))
    write(userDir, 'tester.md', typeFile('tester', 'user tester'))
    write(userDir, 'writer.md', typeFile('writer', 'user writer'))

    const catalog = loadAgentTypes(workspace)
    expect(catalog.types.map((t) => [t.name, t.source, t.description])).toEqual([
      ['reviewer', 'workspace', 'workspace reviewer'],
      ['tester', 'claude', 'claude tester'],
      ['writer', 'user', 'user writer']
    ])
    // The shadowed files are reported, not silently lost.
    expect(catalog.issues.filter((i) => /already defined/.test(i.message)).map((i) => i.displayPath)).toEqual([
      '.claude/agents/reviewer.md',
      '<userData>/agent-types/tester.md'
    ])
    expect(findAgentType(catalog, 'REVIEWER')?.source).toBe('workspace')
  })

  it('reports an invalid file without dropping the valid ones', () => {
    write(join(workspace, '.vyotiq', 'agent-types'), 'broken.md', '---\nname: broken\n---\nno description')
    write(join(workspace, '.vyotiq', 'agent-types'), 'ok.md', typeFile('ok', 'fine'))
    write(join(workspace, '.vyotiq', 'agent-types'), 'notes.txt', 'not markdown')
    const catalog = loadAgentTypes(workspace)
    expect(catalog.types.map((t) => t.name)).toEqual(['ok'])
    expect(catalog.issues).toEqual([
      { displayPath: '.vyotiq/agent-types/broken.md', severity: 'error', message: 'description is required' }
    ])
    const error = unknownAgentTypeError(catalog, 'nope')
    expect(error).toMatch(/Unknown agent_type "nope"\. Available: ok\./)
    expect(error).toMatch(/\.vyotiq\/agent-types\/broken\.md \(description is required\)/)
  })

  it('sees an edited file on the next load', () => {
    const path = write(join(workspace, '.vyotiq', 'agent-types'), 'r.md', typeFile('r', 'first'))
    expect(loadAgentTypes(workspace).types[0]?.description).toBe('first')
    writeFileSync(path, typeFile('r', 'second, longer'))
    const later = new Date(Date.now() + 5_000)
    utimesSync(path, later, later)
    expect(loadAgentTypes(workspace).types[0]?.description).toBe('second, longer')
  })

  it('names no types when nothing is defined', () => {
    const catalog = loadAgentTypes(workspace)
    expect(catalog.types).toEqual([])
    expect(buildAgentTypesSection(catalog.types)).toBe('')
    expect(unknownAgentTypeError(catalog, 'x')).toMatch(/no agent types are defined/)
  })
})

describe('agent type prompt text', () => {
  it('lists each type with its tools in one <agent_types> section', () => {
    const parsed = parseAgentTypeMarkdown(CLAUDE_CODE_REVIEWER)
    if (!parsed.ok) throw new Error(parsed.error)
    const section = buildAgentTypesSection([{ ...parsed.type, source: 'claude', displayPath: '.claude/agents/r.md' }])
    expect(section.startsWith('<agent_types>\n')).toBe(true)
    expect(section).toMatch(/pass `agent_type`/)
    expect(section).toMatch(/- \*\*code-reviewer\*\*: Expert code review specialist\..*\(tools: read, grep, glob, terminal\)/)
  })

  it('wraps the body in <agent_type> naming the type', () => {
    const text = formatAgentTypeInstructions({ name: 'reviewer', body: 'Review carefully.' })
    expect(text).toBe(
      '<agent_type>\nYou are running as the "reviewer" helper type. Its instructions below apply to this whole task, alongside the brief above.\n\nReview carefully.\n</agent_type>'
    )
  })
})

describe('typed helper tool restriction', () => {
  const defs = [
    'read',
    'grep',
    'edit',
    'terminal',
    'todo_write',
    'create_plan',
    'check_done_when',
    'spawn_agent_instance',
    'mcp__github__search',
    'mcp__slack__post',
    'request_mcp_tools'
  ].map((name) => ({ name }))

  it('adds the bookkeeping tools, and MCP loading only when an MCP tool is granted', () => {
    expect(agentTypeToolAllowlist(undefined)).toBeUndefined()
    expect(agentTypeToolAllowlist(['read'])).toEqual(['read', 'todo_write', 'create_plan', 'check_done_when'])
    expect(agentTypeToolAllowlist(['mcp__github'])).toEqual([
      'mcp__github',
      'todo_write',
      'create_plan',
      'check_done_when',
      'mcp_list_tools',
      'request_mcp_tools',
      'release_mcp_tools'
    ])
  })

  it('intersects the type list with what the mode and nesting already allow', () => {
    const allowlist = agentTypeToolAllowlist(['read', 'edit', 'mcp__github', 'spawn_agent_instance'])!
    const agent = filterToolDefsForMode('agent', defs, { inlineInstance: true, toolAllowlist: allowlist }).map((d) => d.name)
    expect(agent).toEqual(['read', 'edit', 'todo_write', 'create_plan', 'check_done_when', 'mcp__github__search', 'request_mcp_tools'])
    // read_only still applies: Ask mode keeps only what both allow.
    const ask = filterToolDefsForMode('ask', defs, { inlineInstance: true, toolAllowlist: allowlist }).map((d) => d.name)
    expect(ask).toEqual(['read'])
    // No list: unchanged.
    expect(filterToolDefsForMode('agent', defs, { inlineInstance: true })).toHaveLength(defs.length - 1)
  })

  it('refuses a call outside the list at the tool gate, even when the mode would allow it', () => {
    const allowlist = agentTypeToolAllowlist(['read', 'mcp__github'])!
    expect(assertToolAllowedInMode('agent', 'read', {}, { toolAllowlist: allowlist })).toEqual({ ok: true })
    expect(assertToolAllowedInMode('agent', 'mcp__github__search', {}, { toolAllowlist: allowlist })).toEqual({ ok: true })
    const denied = assertToolAllowedInMode('agent', 'terminal', {}, { toolAllowlist: allowlist })
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error).toMatch(/not in this helper's agent-type tool list/)
    expect(assertToolAllowedInMode('agent', 'mcp__slack__post', {}, { toolAllowlist: allowlist }).ok).toBe(false)
    // The list never widens Ask mode.
    expect(assertToolAllowedInMode('ask', 'edit', {}, { toolAllowlist: ['edit'] }).ok).toBe(false)
  })

  it('resolves a definition into what a spawn applies', () => {
    const parsed = parseAgentTypeMarkdown(CLAUDE_CODE_REVIEWER)
    if (!parsed.ok) throw new Error(parsed.error)
    const resolved = resolveAgentType({ ...parsed.type, source: 'claude', displayPath: 'x' })
    expect(resolved.name).toBe('code-reviewer')
    expect(resolved.model).toBe('inherit')
    expect(resolved.tools).toEqual(['read', 'grep', 'glob', 'terminal', 'todo_write', 'create_plan', 'check_done_when'])
  })
})

describe('resolveAgentTypeModel', () => {
  const parent = { provider: 'openai' as const, model: 'gpt-5' }
  const helper = { provider: 'openrouter' as const, model: 'anthropic/claude-haiku-4.5' }
  const all = (): boolean => true

  it('keeps the general helper model when the type names none', () => {
    expect(resolveAgentTypeModel(undefined, { parent, helper, hasCredentials: all })).toEqual({ choice: helper })
    expect(resolveAgentTypeModel(undefined, { parent, helper: null, hasCredentials: all })).toEqual({ choice: parent })
  })

  it('maps inherit to the task model', () => {
    expect(resolveAgentTypeModel('inherit', { parent, helper, hasCredentials: all })).toEqual({ choice: parent })
  })

  it('maps a family alias to a seeded model on the first provider with credentials', () => {
    const onlyAnthropic = (p: string): boolean => p === 'anthropic'
    expect(resolveAgentTypeModel('opus', { parent, helper, hasCredentials: onlyAnthropic })).toEqual({
      choice: { provider: 'anthropic', model: 'claude-opus-5' }
    })
    // The task already runs that family: keep its exact model.
    const onOpus = { provider: 'anthropic' as const, model: 'claude-opus-5-5' }
    expect(resolveAgentTypeModel('opus', { parent: onOpus, helper, hasCredentials: all })).toEqual({ choice: onOpus })
  })

  it('takes provider:model exactly when that provider has credentials, else falls back with a note', () => {
    expect(resolveAgentTypeModel('anthropic:claude-sonnet-4', { parent, helper, hasCredentials: all })).toEqual({
      choice: { provider: 'anthropic', model: 'claude-sonnet-4' }
    })
    const none = resolveAgentTypeModel('anthropic:claude-sonnet-4', { parent, helper, hasCredentials: () => false })
    expect(none.choice).toEqual(helper)
    expect(none.note).toMatch(/needs anthropic credentials; the helper runs on openrouter:anthropic\/claude-haiku-4\.5 instead/)
    const noAlias = resolveAgentTypeModel('haiku', { parent, helper, hasCredentials: () => false })
    expect(noAlias.choice).toEqual(helper)
    expect(noAlias.note).toMatch(/matches no model/)
  })

  it('places a bare model id on a provider that lists it, else on the helper provider', () => {
    expect(resolveAgentTypeModel('claude-haiku-4-5', { parent, helper, hasCredentials: all })).toEqual({
      choice: { provider: 'anthropic', model: 'claude-haiku-4-5' }
    })
    expect(resolveAgentTypeModel('some/model', { parent, helper, hasCredentials: all })).toEqual({
      choice: { provider: 'openrouter', model: 'some/model' }
    })
  })
})

describe('retired agent data guard', () => {
  it('still blocks .vyotiq/agents/ but not the new .vyotiq/agent-types/', () => {
    expect(() => assertNotRetiredAgentDataPath(['.vyotiq/agents/p1/notes.md'])).toThrow(/retired per-profile data/)
    expect(() => assertNotRetiredAgentDataPath(['.vyotiq/agent-types/reviewer.md'])).not.toThrow()
    expect(() => assertNotRetiredAgentDataPath(['.claude/agents/reviewer.md'])).not.toThrow()
  })
})
