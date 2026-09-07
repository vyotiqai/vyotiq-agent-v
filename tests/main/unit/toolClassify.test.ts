import { afterEach, describe, expect, it } from 'vitest'
import { resetMcpSessionsForTests, setMcpReadOnlyHintsForTests } from '@main/agent/mcp'
import { groupStepToolCalls } from '@main/agent/executeStepTools'
import {
  isApprovalExemptTool,
  isParallelAwaitTool,
  isParallelBatchClass,
  isParallelMutationTool,
  isParallelSafeTool,
  isParallelSpawnTool,
  MAX_PARALLEL_MUTATION_TOOLS,
  MAX_PARALLEL_READ_TOOLS,
  parallelLimitForBatchClass,
  parallelMutationPathKey,
  stepToolBatchClass
} from '@main/agent/tools/classify'
import { isToolGated } from '@main/agent/toolApproval'

afterEach(() => {
  resetMcpSessionsForTests()
})

describe('tool classify', () => {
  it('marks built-in parallel-safe tools', () => {
    expect(isParallelSafeTool('read')).toBe(true)
    expect(isParallelSafeTool('search')).toBe(true)
    expect(isParallelSafeTool('glob')).toBe(true)
    expect(isParallelSafeTool('grep')).toBe(true)
    expect(isParallelSafeTool('list_dir')).toBe(true)
    expect(isParallelSafeTool('memory_read')).toBe(true)
    expect(isParallelSafeTool('Skill')).toBe(true)
  })

  it('marks mutating built-in tools as serial-only', () => {
    expect(isParallelSafeTool('edit')).toBe(false)
    expect(isParallelSafeTool('terminal')).toBe(false)
    expect(isParallelSafeTool('memory_write')).toBe(false)
  })

  it('treats ask_question and switch_mode as serial and approval-exempt', () => {
    expect(isParallelSafeTool('ask_question')).toBe(false)
    expect(isApprovalExemptTool('ask_question')).toBe(true)
    expect(isToolGated('ask_question', 'mutating', new Set(), [])).toBe(false)
    expect(isParallelSafeTool('switch_mode')).toBe(false)
    expect(isApprovalExemptTool('switch_mode')).toBe(true)
    expect(isToolGated('switch_mode', 'mutating', new Set(), [])).toBe(false)
    expect(isParallelSafeTool('todo_write')).toBe(false)
    expect(isApprovalExemptTool('todo_write')).toBe(true)
    expect(isToolGated('todo_write', 'mutating', new Set(), [])).toBe(false)
  })

  it('marks spawn_agent_instance serial/exempt and await_agent_instance serial/exempt', () => {
    expect(isParallelSafeTool('spawn_agent_instance')).toBe(false)
    expect(isApprovalExemptTool('spawn_agent_instance')).toBe(true)
    expect(isToolGated('spawn_agent_instance', 'mutating', new Set(), [])).toBe(false)
    expect(isParallelSafeTool('await_agent_instance')).toBe(false)
    expect(isApprovalExemptTool('await_agent_instance')).toBe(true)
    expect(isToolGated('await_agent_instance', 'mutating', new Set(), [])).toBe(false)
    expect(isParallelSafeTool('pull_agent_instance')).toBe(true)
    expect(isApprovalExemptTool('pull_agent_instance')).toBe(true)
    expect(isToolGated('pull_agent_instance', 'mutating', new Set(), [])).toBe(false)
    expect(isParallelSafeTool('merge_agent_instance')).toBe(false)
    expect(isApprovalExemptTool('merge_agent_instance')).toBe(false)
    expect(isToolGated('merge_agent_instance', 'mutating', new Set(), [])).toBe(true)
  })

  it('serializes browser_search with other browser tools', () => {
    expect(isParallelSafeTool('browser_search')).toBe(false)
    expect(isApprovalExemptTool('browser_search')).toBe(false)
    expect(isToolGated('browser_search', 'mutating', new Set(), [])).toBe(true)
  })

  it('serializes browser tools on the shared window and gates approval', () => {
    for (const name of [
      'browser_search',
      'browser_navigate',
      'browser_snapshot',
      'browser_click',
      'browser_type',
      'browser_scroll',
      'browser_fill',
      'browser_tabs',
      'browser_back',
      'browser_forward',
      'browser_wait_for_selector',
      'browser_wait_for_url',
      'browser_wait_for_text',
      'browser_hover',
      'browser_handle_dialog',
      'browser_press_key',
      'browser_select_option'
    ]) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('treats mcp_list_tools as parallel-safe but not approval-exempt', () => {
    expect(isParallelSafeTool('mcp_list_tools')).toBe(true)
    expect(isApprovalExemptTool('mcp_list_tools')).toBe(false)
    expect(isToolGated('mcp_list_tools', 'mutating', new Set(), [])).toBe(true)
  })

  it('treats request_mcp_tools and release_mcp_tools as serial and gated', () => {
    for (const name of ['request_mcp_tools', 'release_mcp_tools']) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('treats MCP resource/prompt built-ins as serial and gated', () => {
    for (const name of [
      'mcp_list_resources',
      'mcp_read_resource',
      'mcp_list_prompts',
      'mcp_get_prompt'
    ]) {
      expect(isParallelSafeTool(name)).toBe(false)
      expect(isApprovalExemptTool(name)).toBe(false)
      expect(isToolGated(name, 'mutating', new Set(), [])).toBe(true)
    }
  })

  it('never treats MCP readOnlyHint as parallel-safe', () => {
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(isApprovalExemptTool('mcp__fs__read_file')).toBe(false)
    expect(isParallelSafeTool('mcp__gh__create_issue')).toBe(false)
    setMcpReadOnlyHintsForTests({ 'mcp__fs__read_file': true })
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(isApprovalExemptTool('mcp__fs__read_file')).toBe(false)
    expect(isToolGated('mcp__fs__read_file', 'mutating', new Set(), [])).toBe(true)
  })

  it('treats spawn and await as batchable but not read-safe', () => {
    expect(isParallelSafeTool('spawn_agent_instance')).toBe(false)
    expect(isParallelSpawnTool('spawn_agent_instance')).toBe(true)
    expect(isParallelAwaitTool('spawn_agent_instance')).toBe(false)
    expect(stepToolBatchClass('spawn_agent_instance')).toBe('spawn')
    expect(isParallelBatchClass('spawn')).toBe(true)

    expect(isParallelSafeTool('await_agent_instance')).toBe(false)
    expect(isParallelAwaitTool('await_agent_instance')).toBe(true)
    expect(isParallelSpawnTool('await_agent_instance')).toBe(false)
    expect(stepToolBatchClass('await_agent_instance')).toBe('await')
    expect(isParallelBatchClass('await')).toBe(true)
  })

  it('treats edit and str_replace as mutation-parallel', () => {
    expect(isParallelMutationTool('edit')).toBe(true)
    expect(isParallelMutationTool('str_replace')).toBe(true)
    expect(isParallelSafeTool('edit')).toBe(false)
    expect(isParallelSafeTool('str_replace')).toBe(false)
    expect(stepToolBatchClass('edit')).toBe('mutation')
    expect(stepToolBatchClass('str_replace')).toBe('mutation')
    expect(isParallelBatchClass('mutation')).toBe(true)
    expect(isParallelMutationTool('delete')).toBe(false)
    expect(stepToolBatchClass('delete')).toBe('serial')
  })

  it('treats edit_notebook and memory_write as mutation-parallel and gated', () => {
    expect(isParallelMutationTool('edit_notebook')).toBe(true)
    expect(isParallelMutationTool('memory_write')).toBe(true)
    expect(isParallelSafeTool('edit_notebook')).toBe(false)
    expect(isParallelSafeTool('memory_write')).toBe(false)
    expect(stepToolBatchClass('edit_notebook')).toBe('mutation')
    expect(stepToolBatchClass('memory_write')).toBe('mutation')
    expect(isParallelMutationTool('delete')).toBe(false)
    expect(isApprovalExemptTool('edit_notebook')).toBe(false)
    expect(isApprovalExemptTool('memory_write')).toBe(false)
    expect(isToolGated('edit_notebook', 'mutating', new Set(), [])).toBe(true)
    expect(isToolGated('memory_write', 'mutating', new Set(), [])).toBe(true)
  })

  it('keys notebook mutations on target_notebook', () => {
    expect(parallelMutationPathKey({ target_notebook: './Nb/A.ipynb' }, 'edit_notebook')).toBe(
      process.platform === 'win32' ? 'nb/a.ipynb' : 'Nb/A.ipynb'
    )
    expect(parallelMutationPathKey({ target_notebook: 'nb\\a.ipynb' }, 'edit_notebook')).toBe(
      process.platform === 'win32' ? 'nb/a.ipynb' : 'nb/a.ipynb'
    )
    expect(parallelMutationPathKey({ target_notebook: '' }, 'edit_notebook')).toBeUndefined()
    expect(parallelMutationPathKey({ target_notebook: '.' }, 'edit_notebook')).toBeUndefined()
    expect(parallelMutationPathKey({ target_notebook: 'a.ipynb' })).toBeUndefined()
    expect(parallelMutationPathKey({ path: 'notes/foo.md' })).toBe('notes/foo.md')
  })

  it('splits same notebook path and batches disjoint notebooks', () => {
    const same = groupStepToolCalls([
      { id: 'n1', name: 'edit_notebook', arguments: '{"target_notebook":"a.ipynb"}' },
      { id: 'n2', name: 'edit_notebook', arguments: '{"target_notebook":"a.ipynb"}' }
    ])
    expect(same.map((g) => g.map((c) => c.id))).toEqual([['n1'], ['n2']])

    const disjoint = groupStepToolCalls([
      { id: 'n1', name: 'edit_notebook', arguments: '{"target_notebook":"./a.ipynb"}' },
      { id: 'n2', name: 'edit_notebook', arguments: '{"target_notebook":"b.ipynb"}' }
    ])
    expect(disjoint.map((g) => g.map((c) => c.id))).toEqual([['n1', 'n2']])
  })

  it('never puts MCP tools in a parallel batch class', () => {
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(isParallelMutationTool('mcp__fs__read_file')).toBe(false)
    expect(isParallelSpawnTool('mcp__fs__read_file')).toBe(false)
    expect(stepToolBatchClass('mcp__fs__read_file')).toBe('serial')
    expect(isParallelBatchClass(stepToolBatchClass('mcp__fs__read_file'))).toBe(false)
    setMcpReadOnlyHintsForTests({ 'mcp__fs__read_file': true })
    expect(isParallelSafeTool('mcp__fs__read_file')).toBe(false)
    expect(stepToolBatchClass('mcp__fs__read_file')).toBe('serial')
  })

  it('caps parallel read and mutation batches at the configured limits', () => {
    expect(parallelLimitForBatchClass('read')).toBe(MAX_PARALLEL_READ_TOOLS)
    expect(parallelLimitForBatchClass('mutation')).toBe(MAX_PARALLEL_MUTATION_TOOLS)
    expect(parallelLimitForBatchClass('spawn')).toBe(Number.POSITIVE_INFINITY)
    expect(parallelLimitForBatchClass('await')).toBe(Number.POSITIVE_INFINITY)
    expect(parallelLimitForBatchClass('serial')).toBe(1)
  })

  it('normalizes mutation path keys and rejects missing paths', () => {
    expect(parallelMutationPathKey({})).toBeUndefined()
    expect(parallelMutationPathKey({ path: '' })).toBeUndefined()
    expect(parallelMutationPathKey({ path: '.' })).toBeUndefined()
    const key = parallelMutationPathKey({ path: './Src/A.ts' })
    expect(key).toBe(process.platform === 'win32' ? 'src/a.ts' : 'Src/A.ts')
    expect(parallelMutationPathKey({ path: 'src\\a.ts' })).toBe(
      process.platform === 'win32' ? 'src/a.ts' : 'src/a.ts'
    )
  })
})
