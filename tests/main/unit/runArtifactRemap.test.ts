import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

import { executeTool } from '@main/agent/tools'
import { resetTerminalSessionsForTests } from '@main/agent/tools/terminalSessions'

describe('run artifact path remap', () => {
  let workspace: string
  let runDir: string

  function setup(opts?: { withRunPlan?: boolean }): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-remap-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-remap-run-'))
    if (opts?.withRunPlan !== false) {
      writeFileSync(join(runDir, 'plan.md'), '# Run plan artifact\n', 'utf8')
    }
    writeFileSync(join(runDir, 'contract.md'), '## Goal\n\nremap-contract-marker\n', 'utf8')
    // Workspace lookalike that must never be touched by artifact remapping.
    writeFileSync(join(workspace, 'plan.md'), '# workspace lookalike\n', 'utf8')
  }

  afterEach(() => {
    resetTerminalSessionsForTests()
    for (const dir of [workspace, runDir]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('denies delete of run plan.md in Plan mode and keeps the artifact', async () => {
    setup()
    const res = await executeTool(
      'delete',
      JSON.stringify({ path: 'plan.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'plan' }
    )
    // Plan mode's tool gate denies delete outright; the artifact-delete block
    // covers modes where delete IS allowed (Agent).
    expect(res.ok).toBe(false)
    expect(res.content).toMatch(/Plan mode does not allow tool "delete"/)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  })

  it('blocks delete of the run contract in Agent mode', async () => {
    setup()
    const res = await executeTool(
      'delete',
      JSON.stringify({ path: 'contract.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    expect(res.ok).toBe(false)
    expect(res.content).toMatch(/cannot be deleted/)
    expect(existsSync(join(runDir, 'contract.md'))).toBe(true)
  })

  it('does not touch the workspace lookalike when blocking the artifact delete', async () => {
    setup()
    await executeTool(
      'delete',
      JSON.stringify({ path: 'plan.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    expect(existsSync(join(workspace, 'plan.md'))).toBe(true)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(true)
  })

  it('still deletes normal workspace files in Agent mode', async () => {
    setup()
    writeFileSync(join(workspace, 'gone.ts'), 'to delete\n', 'utf8')
    const res = await executeTool(
      'delete',
      JSON.stringify({ path: 'gone.ts' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'agent' }
    )
    expect(res.ok).toBe(true)
    expect(existsSync(join(workspace, 'gone.ts'))).toBe(false)
  })

  it('remaps Ask-mode read of the run contract', async () => {
    setup()
    const res = await executeTool(
      'read',
      JSON.stringify({ path: 'contract.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'ask' }
    )
    expect(res.ok).toBe(true)
    expect(res.content).toContain('remap-contract-marker')
  })

  it('remaps Ask-mode read of an existing run plan', async () => {
    setup()
    const res = await executeTool(
      'read',
      JSON.stringify({ path: 'plan.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'ask' }
    )
    expect(res.ok).toBe(true)
    expect(res.content).toContain('# Run plan artifact')
  })

  it('leaves a workspace plan.md lookalike alone when no run plan exists', async () => {
    setup({ withRunPlan: false })
    const res = await executeTool(
      'read',
      JSON.stringify({ path: 'plan.md' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'ask' }
    )
    expect(res.ok).toBe(true)
    expect(res.content).toContain('# workspace lookalike')
  })
})
