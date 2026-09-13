import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'
import { canonicalizeAgentToolName } from '@main/agent/schemas/tools'

describe('Task alias to spawn_agent_instance', () => {
  const signal = new AbortController().signal

  it('maps prompt onto goal and does not fail as unknown or missing goal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-task-'))
    expect(canonicalizeAgentToolName('Task')).toBe('spawn_agent_instance')
    const result = await executeTool(
      'Task',
      JSON.stringify({ prompt: 'Investigate the parser' }),
      dir,
      signal,
      { agentMode: 'agent' }
    )
    expect(result.content).not.toMatch(/Unknown tool/)
    expect(result.content).not.toMatch(/goal is required/)
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/requires an active run|No active UI window/)
  })

  it('maps subagent description onto goal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-sub-'))
    const result = await executeTool(
      'subagent',
      JSON.stringify({ description: 'List failing tests' }),
      dir,
      signal,
      { runId: 'run-parent', agentMode: 'agent' }
    )
    expect(result.content).not.toMatch(/Unknown tool/)
    expect(result.content).not.toMatch(/goal is required/)
  })
})
