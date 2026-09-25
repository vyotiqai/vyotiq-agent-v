import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'
import {
  AGENT_TOOLS,
  canonicalizeAgentToolName,
  validateToolArgs
} from '@main/agent/schemas/tools'

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

/**
 * Run 874dad8f: six consecutive `spawn_agent_instance` calls were rejected with
 * `outcome: Required`. Every one carried goal, sub_tasks, done_when, path_scope
 * and isolation — the model folded the deliverable into the goal, because the
 * goal's own description said the goal *was* the brief. The fan-out never
 * happened, and the bare Zod complaint named no remedy, so the model re-sent the
 * identical payload twice and then four more times in one batch.
 */
describe('spawn_agent_instance brief backfill', () => {
  const signal = new AbortController().signal

  it('accepts a complete goal that omits outcome instead of rejecting the call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-spawn-brief-'))
    const result = await executeTool(
      'spawn_agent_instance',
      JSON.stringify({
        goal: 'Classify the uncommitted changeset in the aether repo. The diff is at docs-analysis/changeset-full.diff.',
        sub_tasks: ['read the diff', 'classify each file', 'write the table'],
        done_when: 'docs-analysis/changeset-classification.md written',
        path_scope: ['docs-analysis'],
        isolation: 'shared'
      }),
      dir,
      signal,
      { runId: 'run-parent', agentMode: 'agent' }
    )
    expect(result.content).not.toMatch(/outcome: Required/)
    expect(result.content).not.toMatch(/outcome is required/)
  })

  it('names the four brief arguments when a field really cannot be derived', () => {
    const invalid = validateToolArgs('spawn_agent_instance', JSON.stringify({ outcome: 'o' }))
    expect(invalid.ok).toBe(false)
    if (invalid.ok) return
    expect(invalid.error).toMatch(/goal/)
    const missingOutcome = validateToolArgs(
      'spawn_agent_instance',
      JSON.stringify({ goal: 'g', sub_tasks: ['a'], done_when: 'd' })
    )
    expect(missingOutcome.ok).toBe(false)
    if (missingOutcome.ok) return
    // A bare "outcome: Required" is what the model re-sent six times.
    expect(missingOutcome.error).toMatch(/four separate arguments/)
    expect(missingOutcome.error).toMatch(/sub_tasks \(ordered array of strings\)/)
  })

  it("keeps the goal's description from claiming the goal is the brief", () => {
    const spawn = AGENT_TOOLS.find((t) => t.name === 'spawn_agent_instance')
    const goal = (
      spawn!.parameters as { properties: Record<string, { description?: string }> }
    ).properties.goal
    expect(goal.description).toMatch(/separate arguments/)
    expect(goal.description).not.toMatch(/complete workstream/)
  })
})
