import { afterEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

import { executeStepToolCalls } from '@main/agent/executeStepTools'
import { executeTool } from '@main/agent/tools'
import { hasInProgressTodo, toolTodoWrite } from '@main/agent/tools/todo'
import { resetTerminalSessionsForTests } from '@main/agent/tools/terminalSessions'

describe('Agent todo_write planning (no mutation gate)', () => {
  let workspace: string
  let runDir: string

  function setup(): void {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-plan-gate-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-plan-gate-run-'))
    mkdirSync(join(workspace, 'src'), { recursive: true })
    writeFileSync(join(workspace, 'src', 'replace.ts'), 'const a = 1\n', 'utf8')
    writeFileSync(join(workspace, 'src', 'gone.ts'), 'to delete\n', 'utf8')
  }

  afterEach(async () => {
    resetTerminalSessionsForTests()
    for (const dir of [workspace, runDir]) {
      if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    }
  })

  function agentCtx() {
    return { runDir, agentMode: 'agent' as const }
  }

  async function expectMutationsSucceed(): Promise<void> {
    const signal = new AbortController().signal
    const edited = await executeTool(
      'edit',
      JSON.stringify({ path: 'src/gate.ts', contents: 'export const gated = true\n' }),
      workspace,
      signal,
      agentCtx()
    )
    expect(edited.ok).toBe(true)
    expect(edited.content).not.toMatch(/Agent mode requires todo_write/)
    expect(readFileSync(join(workspace, 'src', 'gate.ts'), 'utf8')).toBe(
      'export const gated = true\n'
    )

    const replaced = await executeTool(
      'str_replace',
      JSON.stringify({
        path: 'src/replace.ts',
        old_string: 'const a = 1',
        new_string: 'const a = 2'
      }),
      workspace,
      signal,
      agentCtx()
    )
    expect(replaced.ok).toBe(true)

    const deleted = await executeTool(
      'delete',
      JSON.stringify({ path: 'src/gone.ts' }),
      workspace,
      signal,
      agentCtx()
    )
    expect(deleted.ok).toBe(true)
    expect(existsSync(join(workspace, 'src', 'gone.ts'))).toBe(false)

    const terminal = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo vyotiq-plan-gate-ok' }),
      workspace,
      signal,
      agentCtx()
    )
    expect(terminal.ok).toBe(true)
    expect(terminal.content).toContain('vyotiq-plan-gate-ok')
    expect(terminal.content).not.toMatch(/Agent mode requires todo_write/)
  }

  it('allows mutate and terminal when todos.json is missing', async () => {
    setup()
    expect(hasInProgressTodo(runDir)).toBe(false)
    await expectMutationsSucceed()
  })

  it('allows mutate and terminal when every todo is pending', async () => {
    setup()
    toolTodoWrite(runDir, [
      { id: '1', content: 'Write the planning gate', status: 'pending' },
      { id: '2', content: 'Run the focused tests', status: 'pending' }
    ])
    expect(hasInProgressTodo(runDir)).toBe(false)
    await expectMutationsSucceed()
  })

  it('still allows mutate and terminal once one todo is in_progress', async () => {
    setup()
    toolTodoWrite(runDir, [
      { id: '1', content: 'Write src/gate.ts', status: 'in_progress' },
      { id: '2', content: 'Echo a marker', status: 'pending' }
    ])
    expect(hasInProgressTodo(runDir)).toBe(true)
    await expectMutationsSucceed()
  })

  it('does not apply a todo gate to Ask edit — mode policy fails first', async () => {
    setup()
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Ask must not write this\n' }),
      workspace,
      new AbortController().signal,
      { runDir, agentMode: 'ask' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Ask mode does not allow tool "edit"/)
    expect(result.content).not.toMatch(/Agent mode requires todo_write/)
    expect(existsSync(join(runDir, 'plan.md'))).toBe(false)
  })

  it('does not block Plan edit of plan.md and contract.md without in_progress', async () => {
    setup()
    expect(hasInProgressTodo(runDir)).toBe(false)
    const signal = new AbortController().signal
    const plan = await executeTool(
      'edit',
      JSON.stringify({ path: 'plan.md', contents: '# Runtime planning gate\n' }),
      workspace,
      signal,
      { runDir, agentMode: 'plan' }
    )
    expect(plan.ok).toBe(true)
    expect(plan.content).not.toMatch(/Agent mode requires todo_write/)
    expect(readFileSync(join(runDir, 'plan.md'), 'utf8')).toContain('# Runtime planning gate')

    const contract = await executeTool(
      'edit',
      JSON.stringify({
        path: 'contract.md',
        contents: '## Goal\n\nLand the planning gate\n\n## Done when\n\n- tests pass\n'
      }),
      workspace,
      signal,
      { runDir, agentMode: 'plan' }
    )
    expect(contract.ok).toBe(true)
    expect(readFileSync(join(runDir, 'contract.md'), 'utf8')).toContain('Land the planning gate')
  })

  it('same-step [edit, todo_write] still hoists todo_write first', async () => {
    setup()
    const outcome = await executeStepToolCalls(
      [
        {
          id: 'e1',
          name: 'edit',
          arguments: JSON.stringify({
            path: 'src/gate.ts',
            contents: 'export const hoisted = true\n'
          })
        },
        {
          id: 't1',
          name: 'todo_write',
          arguments: JSON.stringify({
            todos: [{ id: '1', content: 'Write src/gate.ts', status: 'in_progress' }]
          })
        }
      ],
      {
        runId: 'run-hoist',
        runDir,
        workspace,
        signal: new AbortController().signal,
        agentMode: 'agent',
        appendMessage: async () => {},
        appendEvent: () => {}
      }
    )

    expect(outcome.stepToolsOk).toBe(true)
    expect(outcome.messages.map((m) => m.toolName)).toEqual(['todo_write', 'edit'])
    expect(outcome.messages.every((m) => m.ok !== false)).toBe(true)
    expect(hasInProgressTodo(runDir)).toBe(true)
    expect(readFileSync(join(workspace, 'src', 'gate.ts'), 'utf8')).toBe(
      'export const hoisted = true\n'
    )
  })
})
