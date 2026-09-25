import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

let runDir = ''
vi.mock('@main/storage/paths', () => ({
  resolveRunDir: () => runDir
}))

import { listActiveRunsView } from '@main/agent/activeRunView'
import {
  askQuestionThroughRenderer,
  registerQuestionSender,
  resetAgentQuestionForTests,
  resolveAgentQuestion
} from '@main/agent/agentQuestion'
import { resetActiveRunsForTests, tryRegisterRunAbort } from '@main/agent/runRegistry'
import { toolTodoWrite } from '@main/agent/tools/todo'

beforeEach(() => {
  resetActiveRunsForTests()
  resetAgentQuestionForTests()
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-active-view-'))
  expect(tryRegisterRunAbort('run-1', 'C:/ws').ok).toBe(true)
})

afterEach(() => {
  resetActiveRunsForTests()
  resetAgentQuestionForTests()
  rmSync(runDir, { recursive: true, force: true })
})

describe('listActiveRunsView', () => {
  it('reports a plain running task with neither waiting nor steps', () => {
    const [view] = listActiveRunsView()
    expect(view).toMatchObject({ runId: 'run-1', workspacePath: 'C:/ws' })
    expect(view!.waiting).toBeUndefined()
    expect(view!.steps).toBeUndefined()
  })

  it('counts todo progress, leaving cancelled items out of the total', () => {
    toolTodoWrite(runDir, [
      { id: 'a', content: 'Read the updater', status: 'completed' },
      { id: 'b', content: 'Fix the swap', status: 'in_progress' },
      { id: 'c', content: 'Retry loop', status: 'cancelled' },
      { id: 'd', content: 'Run the suite', status: 'pending' }
    ])
    expect(listActiveRunsView()[0]!.steps).toEqual({ completed: 1, total: 3 })
  })

  it('says the task is waiting on you while a question is pending, and stops once answered', async () => {
    registerQuestionSender('run-1', () => {})
    const before = Date.now()
    const answer = askQuestionThroughRenderer(
      {
        requestId: 'req-1',
        runId: 'run-1',
        toolCallId: 'tool-1',
        questions: [{ id: 'q1', prompt: 'Which approach?', type: 'text' }]
      },
      new AbortController().signal
    )
    await Promise.resolve()

    const waiting = listActiveRunsView()[0]!.waiting
    expect(waiting?.kind).toBe('question')
    expect(Date.parse(waiting!.since)).toBeGreaterThanOrEqual(before - 1)

    resolveAgentQuestion({ requestId: 'req-1', runId: 'run-1', answers: [{ questionId: 'q1', values: ['A'] }] })
    await answer
    expect(listActiveRunsView()[0]!.waiting).toBeUndefined()
  })
})
