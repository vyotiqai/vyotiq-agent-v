import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool, usesSessionWorkspaceIndex } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { ensurePlanStub } from '@main/agent/planArtifacts'

describe('executeTool run-artifact remap', () => {
  let workspace: string
  let runDir: string

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-remap-ws-'))
    runDir = join(workspace, '.run')
    mkdirSync(runDir, { recursive: true })
    writeFileSync(
      join(runDir, 'contract.md'),
      '## Goal\n\noriginal\n\n## Done when\n\n- done\n',
      'utf8'
    )
    toolTodoWrite(runDir, [{ id: '1', content: 'Update run artifacts', status: 'in_progress' }])
  }

  it('Agent mode edit remaps contract.md into the run directory', async () => {
    setup()
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({
        path: 'contract.md',
        contents: '## Goal\n\nupdated by agent\n\n## Done when\n\n- done\n'
      }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('updated by agent')
    expect(existsSync(join(workspace, 'contract.md'))).toBe(false)
  })

  it('Agent mode does not remap plan.md when no run plan exists', async () => {
    setup()
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Workspace plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(existsSync(join(workspace, 'plan.md'))).toBe(true)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(false)
  })

  it('Agent mode remaps plan.md when a run plan artifact exists', async () => {
    setup()
    writeFileSync(join(runDir, 'plan.md'), '# Existing plan\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Updated plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Updated plan')
    expect(existsSync(join(workspace, 'plan.md'))).toBe(false)
  })

  it('Agent mode blocks delete of the run contract (run artifacts are protected)', async () => {
    setup()
    writeFileSync(join(workspace, 'contract.md'), 'workspace contract\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'delete',
      JSON.stringify({ path: 'contract.md' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/cannot be deleted/)
    expect(existsSync(join(runDir, 'contract.md'))).toBe(true)
    expect(readFileSync(join(workspace, 'contract.md'), 'utf8')).toBe('workspace contract\n')
  })

  it('Agent mode does not remap nested src/contract.md into the run directory', async () => {
    setup()
    mkdirSync(join(workspace, 'src'))
    writeFileSync(join(workspace, 'src', 'contract.md'), 'product contract\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'src/contract.md', contents: 'updated product contract\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'src', 'contract.md'), 'utf8')).toBe(
      'updated product contract\n'
    )
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('original')
  })

  it('Agent mode does not remap nested docs/plan.md when a run plan exists', async () => {
    setup()
    writeFileSync(join(runDir, 'plan.md'), '# Existing plan\n', 'utf8')
    mkdirSync(join(workspace, 'docs'))
    writeFileSync(join(workspace, 'docs', 'plan.md'), '# Docs plan\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'docs/plan.md', contents: '# Updated docs plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(result.ok).toBe(true)
    expect(readFileSync(join(workspace, 'docs', 'plan.md'), 'utf8')).toBe('# Updated docs plan\n')
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toBe('# Existing plan\n')
  })

  it('the run-start plan stub is what keeps edit plan.md inside the run directory', async () => {
    // Plan mode used to remap plan.md unconditionally. Merged into Agent, the
    // remap is gated on the artifact existing — so the run loop seeds the stub
    // at start (seedPlanStubIfMissing). Without it `edit` would CREATE a stray
    // plan.md in the workspace root, as the test above shows. This pins the two
    // halves together: seeding is load-bearing, not decoration.
    setup()
    ensurePlanStub(runDir)
    const signal = new AbortController().signal
    const plan = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Plan\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'agent' }
    )
    expect(plan.ok).toBe(true)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Plan')
    expect(existsSync(join(workspace, 'plan.md'))).toBe(false)
  })
})

describe('worktree vs session index split', () => {
  it('binds memory to the session workspace; codebase_search follows the worktree', () => {
    expect(usesSessionWorkspaceIndex('codebase_search')).toBe(false)
    expect(usesSessionWorkspaceIndex('memory_read')).toBe(true)
    expect(usesSessionWorkspaceIndex('memory_write')).toBe(true)
    expect(usesSessionWorkspaceIndex('memory_list')).toBe(true)
    expect(usesSessionWorkspaceIndex('search')).toBe(false)
    expect(usesSessionWorkspaceIndex('grep')).toBe(false)
    expect(usesSessionWorkspaceIndex('glob')).toBe(false)
    expect(usesSessionWorkspaceIndex('read')).toBe(false)
  })
})
