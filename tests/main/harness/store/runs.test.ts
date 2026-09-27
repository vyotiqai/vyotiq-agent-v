import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const userData = mkdtempSync(join(tmpdir(), 'vy-runs-userdata-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => userData,
    isPackaged: false
  }
}))

import type { ChatMessage, RunStatus } from '@shared/ipc'
import { DEFAULT_PLAN_STUB } from '@shared/planStub'
import { TOOL_STUB_RESTART_INTERRUPTED } from '@shared/toolStubs'
import { readEventRows } from '@main/harness/store/events'
import { resetJsonlForTests } from '@main/harness/store/jsonl'
import {
  closeOrphanToolCalls,
  createRun,
  ensurePlanStub,
  readContract,
  readPlan,
  readPlanRaw,
  runExists
} from '@main/harness/store/runs'
import { resetStatusForTests } from '@main/harness/store/status'
import { readTranscript } from '@main/harness/store/transcript'

const workspace = mkdtempSync(join(tmpdir(), 'vy-runs-ws-'))
let counter = 0

beforeEach(() => {
  resetJsonlForTests()
  resetStatusForTests()
})

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
  rmSync(workspace, { recursive: true, force: true })
})

function newRunId(): string {
  counter++
  return `run-${process.pid}-${counter}`
}

const line = (m: ChatMessage): string => `${JSON.stringify(m)}\n`

describe('createRun', () => {
  it('lays out the run directory the renderer and IPC read', () => {
    const runId = newRunId()
    const dir = createRun(workspace, runId, '  Fix the parser  ', { mode: 'ask' })
    expect(runExists(workspace, runId)).toBe(true)
    for (const file of ['contract.md', 'status.json', 'messages.jsonl', 'events.jsonl']) {
      expect(existsSync(join(dir, file))).toBe(true)
    }
    expect(existsSync(join(dir, 'checks.json'))).toBe(false)
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus
    expect(status).toMatchObject({ status: 'running', step: 0, goal: 'Fix the parser', mode: 'ask', workspacePath: workspace })
    expect(readFileSync(join(dir, 'contract.md'), 'utf8')).toMatch(/^## Goal\n\nFix the parser\n/)
  })

  it('numbers brief checks in order and folds repeats', () => {
    const dir = createRun(workspace, newRunId(), 'goal', { doneWhen: ['tests pass', ' Tests pass ', 'lint clean', ''] })
    const { checks } = JSON.parse(readFileSync(join(dir, 'checks.json'), 'utf8')) as {
      checks: Array<{ id: string; text: string; source: string; verdict: null }>
    }
    expect(checks.map((c) => [c.id, c.text, c.source, c.verdict])).toEqual([
      ['c1', 'tests pass', 'brief', null],
      ['c2', 'lint clean', 'brief', null]
    ])
  })

  it('records instance metadata', () => {
    const dir = createRun(workspace, newRunId(), 'child', {
      parentRunId: 'parent',
      inlineInstance: true,
      pathScope: ['src/a'],
      worktreePath: '/wt',
      worktreeBranch: 'b'
    })
    const status = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus
    expect(status).toMatchObject({
      parentRunId: 'parent',
      inlineInstance: true,
      pathScope: ['src/a'],
      worktreePath: '/wt',
      worktreeBranch: 'b'
    })
  })
})

describe('run artifacts', () => {
  it('caps the contract and hides the unfilled plan stub', async () => {
    const dir = createRun(workspace, newRunId(), 'g')
    writeFileSync(join(dir, 'contract.md'), 'c'.repeat(5000))
    expect(await readContract(dir)).toBe(`${'c'.repeat(4000)}\n…`)
    ensurePlanStub(dir)
    expect(await readPlanRaw(dir)).toBe(DEFAULT_PLAN_STUB.trim())
    expect(await readPlan(dir)).toBe('')
    const plan = '# Plan\n\n## Steps\n\n1. Read the parser and write a failing test for the bug.'
    writeFileSync(join(dir, 'plan.md'), plan)
    expect(await readPlan(dir)).toBe(plan)
    ensurePlanStub(dir)
    expect(await readPlan(dir)).toBe(plan)
  })
})

describe('closeOrphanToolCalls', () => {
  const assistant = (ids: string[]): ChatMessage => ({
    role: 'assistant',
    content: '',
    toolCalls: ids.map((id) => ({ id, name: 'terminal', arguments: '{}' }))
  })
  const result = (id: string): ChatMessage => ({ role: 'tool', toolCallId: id, toolName: 'terminal', content: 'done', ok: true })

  it('appends stubs for calls orphaned at the tail without rewriting history', async () => {
    const runId = newRunId()
    const dir = createRun(workspace, runId, 'g')
    const history = line({ role: 'user', content: 'go' }) + line(assistant(['a', 'b'])) + line(result('a'))
    writeFileSync(join(dir, 'messages.jsonl'), history)
    expect(await closeOrphanToolCalls(dir, runId)).toBe(1)
    const text = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
    expect(text.startsWith(history)).toBe(true)
    const last = (await readTranscript(dir)).at(-1)!
    expect(last).toMatchObject({ role: 'tool', toolCallId: 'b', ok: false, content: TOOL_STUB_RESTART_INTERRUPTED })
    const rows = await readEventRows(dir)
    expect(rows.map((r) => r.event)).toEqual([
      expect.objectContaining({ type: 'tool_result', toolCallId: 'b', ok: false, summary: 'interrupted' })
    ])
    expect(await closeOrphanToolCalls(dir, runId)).toBe(0)
  })

  it('inserts stubs right after an orphaning turn that is not the last', async () => {
    const runId = newRunId()
    const dir = createRun(workspace, runId, 'g')
    writeFileSync(
      join(dir, 'messages.jsonl'),
      line({ role: 'user', content: 'go' }) + line(assistant(['x'])) + line({ role: 'user', content: 'again' })
    )
    expect(await closeOrphanToolCalls(dir, runId)).toBe(1)
    const roles = (await readTranscript(dir)).map((m) => (m.role === 'tool' ? `tool:${m.toolCallId}` : m.role))
    expect(roles).toEqual(['user', 'assistant', 'tool:x', 'user'])
  })
})
