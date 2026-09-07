import { describe, expect, it } from 'vitest'
import {
  canonicalizeAgentToolName,
  formatUnknownToolError,
  BUILTIN_TOOL_NAMES
} from '@main/agent/schemas/tools'

describe('canonicalizeAgentToolName', () => {
  it('leaves catalog names and MCP names unchanged', () => {
    expect(canonicalizeAgentToolName('read')).toBe('read')
    expect(canonicalizeAgentToolName('Skill')).toBe('Skill')
    expect(canonicalizeAgentToolName('mcp__browser__click')).toBe('mcp__browser__click')
  })

  it('folds PascalCase / compact forms onto builtins', () => {
    expect(canonicalizeAgentToolName('Read')).toBe('read')
    expect(canonicalizeAgentToolName('Grep')).toBe('grep')
    expect(canonicalizeAgentToolName('StrReplace')).toBe('str_replace')
    expect(canonicalizeAgentToolName('TodoWrite')).toBe('todo_write')
    expect(canonicalizeAgentToolName('skill')).toBe('Skill')
    expect(canonicalizeAgentToolName('BrowserSearch')).toBe('browser_search')
  })

  it('maps common invented aliases onto real tools', () => {
    expect(canonicalizeAgentToolName('Write')).toBe('edit')
    expect(canonicalizeAgentToolName('write_file')).toBe('edit')
    expect(canonicalizeAgentToolName('Shell')).toBe('terminal')
    expect(canonicalizeAgentToolName('Bash')).toBe('terminal')
    expect(canonicalizeAgentToolName('WebSearch')).toBe('browser_search')
    expect(canonicalizeAgentToolName('WebFetch')).toBe('browser_navigate')
    expect(canonicalizeAgentToolName('read_file')).toBe('read')
    expect(canonicalizeAgentToolName('ls')).toBe('list_dir')
    expect(canonicalizeAgentToolName('Todo')).toBe('todo_write')
    expect(canonicalizeAgentToolName('write_plan')).toBe('create_plan')
    expect(canonicalizeAgentToolName('CreatePlan')).toBe('create_plan')
    expect(canonicalizeAgentToolName('CreateGoal')).toBe('create_goal')
    expect(canonicalizeAgentToolName('UpdateGoal')).toBe('update_goal')
  })

  it('maps Task / subagent onto spawn_agent_instance and leaves Agent alone', () => {
    expect(canonicalizeAgentToolName('Task')).toBe('spawn_agent_instance')
    expect(canonicalizeAgentToolName('subagent')).toBe('spawn_agent_instance')
    expect(canonicalizeAgentToolName('Agent')).toBe('Agent')
    expect(canonicalizeAgentToolName('EditNotebook')).toBe('edit_notebook')
    expect(canonicalizeAgentToolName('notebookedit')).toBe('edit_notebook')
    expect(canonicalizeAgentToolName('ReadLints')).toBe('lsp')
    expect(canonicalizeAgentToolName('write_file_check')).toBe('write_file_check')
    expect(canonicalizeAgentToolName('apply_patch')).toBe('apply_patch')
  })

  it('compact keys for builtins do not collide', () => {
    const seen = new Map<string, string>()
    for (const name of BUILTIN_TOOL_NAMES) {
      const key = name.toLowerCase().replace(/_/g, '')
      const prior = seen.get(key)
      expect(prior, `compact collision ${prior} vs ${name}`).toBeUndefined()
      seen.set(key, name)
    }
  })
})

describe('formatUnknownToolError', () => {
  it('points leftover names at the turn catalog', () => {
    expect(formatUnknownToolError('foo_bar')).toMatch(/this turn's tool catalog/)
  })

  it('steers Task toward spawn_agent_instance', () => {
    expect(formatUnknownToolError('Task')).toMatch(/spawn_agent_instance/)
  })

  it('keeps write_file_check on the file-edit hint', () => {
    expect(formatUnknownToolError('write_file_check')).toMatch(
      /edit or str_replace/
    )
  })
})
