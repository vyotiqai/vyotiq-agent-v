import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'
import { executeCreatePlan } from '@main/agent/tools/createPlan'
import { canonicalizeAgentToolName, validateParsedToolArgs } from '@main/agent/schemas/tools'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'

const SIMPLE_PLAN = [
  '## Goal',
  '',
  'Publish a clear run plan through create_plan.',
  '',
  '## Steps',
  '',
  '1. Explore the workspace, then write plan.md.',
  '',
  '## Done when',
  '',
  'plan.md has a goal, steps, and a check for finished work.'
].join('\n')

const COMPLETE_PLAN = [
  '# Ship the planner',
  '',
  '## Goal',
  '',
  'Make create_plan return structured quality feedback so shallow plans get refined.',
  '',
  '## Scope',
  '',
  'In: plan scoring and tool feedback. Out: plan panel rendering changes.',
  '',
  '## Steps',
  '',
  '1. Add `scorePlanQuality` to `src/shared/planQuality.ts` with unit tests.',
  '2. Surface the report in `src/main/agent/tools/createPlan.ts` and run `pnpm exec vitest run tests/shared` to verify.',
  '',
  '## Done when',
  '',
  '- [ ] `scorePlanQuality` returns no issues for a complete plan.',
  '- [ ] `pnpm typecheck` and the targeted vitest run are green.',
  '',
  '## Risks',
  '',
  'Over-strict gating could block quick plans — feedback stays advisory.'
].join('\n')

describe('create_plan', () => {
  let workspace: string
  let runDir: string

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-create-plan-'))
    runDir = join(workspace, '.run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'contract.md'),
      '## Goal\n\noriginal\n\n## Done when\n\n- done\n',
      'utf8'
    )
  }

  it('canonicalizes write_plan and CreatePlan', () => {
    expect(canonicalizeAgentToolName('write_plan')).toBe('create_plan')
    expect(canonicalizeAgentToolName('CreatePlan')).toBe('create_plan')
  })

  it('writes plan.md and copies Done when into contract', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({
        title: 'Ship the planner',
        plan: SIMPLE_PLAN,
        todos: [{ id: 'p1', content: 'Publish the plan tool', status: 'pending' }]
      }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    const plan = readFileSync(join(runDir, 'plan.md'), 'utf8')
    expect(plan).toMatch(/^# Ship the planner/m)
    expect(plan).toContain('## Steps')
    const contract = readFileSync(join(runDir, 'contract.md'), 'utf8')
    expect(contract).toMatch(/## Done when/)
    expect(contract).toContain('check for finished work')
    expect(readFileSync(join(runDir, 'todos.json'), 'utf8')).toContain('Publish the plan tool')
  })

  it('rejects the empty stub', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({ title: 'Ship the planner', plan: DEFAULT_PLAN_STUB }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/real plan|empty stub/i)
  })

  it('returns no quality feedback for a complete plan', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({ title: 'Ship the planner', plan: COMPLETE_PLAN }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).not.toMatch(/Quality feedback/)
  })

  it('returns advisory quality feedback but still publishes a shallow plan', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({ title: 'Quick fix', plan: SIMPLE_PLAN }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/Quality feedback \(advisory/)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  })

  it('accepts the write_plan alias', async () => {
    setup()
    const result = await executeTool(
      'write_plan',
      JSON.stringify({
        title: 'Ship the planner',
        plan: SIMPLE_PLAN
      }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  })

  it('derives the title from a leading H1 in plan when title is omitted', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({ plan: `# My Title\n\n${SIMPLE_PLAN}` }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(true)
    expect(result.summary).toBe('My Title')
    const plan = readFileSync(join(runDir, 'plan.md'), 'utf8')
    expect(plan.startsWith('# My Title\n\n## Goal')).toBe(true)
    expect(plan.match(/# My Title/g)).toHaveLength(1)
  })

  it('rejects a title-less plan without a leading H1', async () => {
    setup()
    const result = await executeTool(
      'create_plan',
      JSON.stringify({ plan: SIMPLE_PLAN }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('requires title')
  })

  it('rejects an empty title and empty plan', () => {
    setup()
    const result = executeCreatePlan(workspace, { title: '', plan: '' }, { runDir })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('requires title')
  })
})

describe('create_plan title-derivation validation and hints', () => {
  it('accepts a title as an H1 first line in plan without a title argument', () => {
    const result = validateParsedToolArgs('create_plan', {
      plan: `# My Title\n\n${SIMPLE_PLAN}`
    })
    expect(result.ok).toBe(true)
  })

  it('leaves title-less plans to the tool (schema no longer requires title)', () => {
    const result = validateParsedToolArgs('create_plan', { plan: SIMPLE_PLAN })
    expect(result.ok).toBe(true)
  })
})
