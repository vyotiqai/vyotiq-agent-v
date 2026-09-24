import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-notices-ud-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => join(tmpdir(), 'vyotiq-notices-app'),
    isPackaged: false
  },
  dialog: {},
  BrowserWindow: { getAllWindows: () => [] }
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import { writeChecks } from '@main/agent/doneWhenChecks'
import { resetPendingReviewCacheForTests } from '@main/agent/reviewSummary'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import {
  approvalNoticeFor,
  finishedNoticeFor,
  needsYouApprovalNotice,
  needsYouQuestionNotice,
  noticeTaskTitle,
  questionNoticeFor,
  runFinishedNotice
} from '@main/notifications/runNotices'
import { resolveRunDir } from '@main/storage/paths'

/**
 * What a notification says about a task: named the way the navigator names
 * it, with what happened read from the run itself — never a stock line.
 */
describe('noticeTaskTitle', () => {
  it('names a task by its goal’s first line, without markdown', () => {
    expect(noticeTaskTitle({ goal: '**Fix** the flaky `updater` test\n\nSteps: …' }, 'run-12345678')).toBe(
      'Fix the flaky updater test'
    )
  })

  it('leads with the teammate, as the navigator does', () => {
    expect(noticeTaskTitle({ goal: 'Audit the pricing pages', agentProfileName: 'Scout' }, 'r')).toBe(
      'Scout · Audit the pricing pages'
    )
    // A delegated run sets no goal; the teammate still names it.
    expect(noticeTaskTitle({ agentProfileName: 'Scout' }, 'r')).toBe('Scout')
  })

  it('falls back to the run id when there is nothing else, as the navigator does', () => {
    expect(noticeTaskTitle({ goal: '   ', agentProfileName: '  ' }, 'abcdef1234567')).toBe('abcdef12')
    expect(noticeTaskTitle(null, 'abcdef1234567')).toBe('abcdef12')
  })
})

describe('needs-you notices', () => {
  it('says what an approval would let the agent do', () => {
    expect(
      needsYouApprovalNotice('Add backpressure', {
        name: 'terminal',
        summary: 'Run tests',
        argsPreview: JSON.stringify({ command: 'pnpm vitest run  chatStreamController' })
      })
    ).toEqual({ title: 'Add backpressure', body: 'Wants to run pnpm vitest run chatStreamController' })
  })

  it('names an MCP server as Extensions does, and only looks names up for MCP tools', () => {
    const names = vi.fn(() => new Map([['linear', 'Linear']]))
    expect(
      needsYouApprovalNotice('Triage', { name: 'mcp__linear__create_issue', summary: '', argsPreview: '{}' }, names).body
    ).toBe('Wants to use Linear · create_issue')
    needsYouApprovalNotice('Triage', { name: 'edit', summary: 'src/a.ts', argsPreview: '{"path":"src/a.ts"}' }, names)
    expect(names).toHaveBeenCalledTimes(1)
  })

  it('quotes the question asked', () => {
    expect(
      needsYouQuestionNotice('Release', { questions: [{ id: 'q', prompt: 'Which  branch?' }] } as never)
    ).toEqual({ title: 'Release', body: 'Asks: Which branch?' })
  })
})

describe('runFinishedNotice', () => {
  it('says a finished run is ready for review, with its files and checks', () => {
    expect(
      runFinishedNotice({ task: 'Regroup Settings', failed: false, reviewFiles: 14, checks: { met: 3, total: 3 } })
    ).toEqual({ title: 'Regroup Settings', body: 'Ready for review · 14 files · 3/3 checks met', reviewFiles: 14 })
    expect(runFinishedNotice({ task: 'T', failed: false, reviewFiles: 1 }).body).toBe('Ready for review · 1 file')
  })

  it('says Finished when nothing waits on Keep or Undo', () => {
    expect(runFinishedNotice({ task: 'T', failed: false })).toEqual({ title: 'T', body: 'Finished' })
    expect(runFinishedNotice({ task: 'T', failed: false, checks: { met: 1, total: 2 } }).body).toBe(
      'Finished · 1/2 checks met'
    )
  })

  it('says what a run failed on, first line only, and the edits it left', () => {
    expect(
      runFinishedNotice({ task: 'Audit', failed: true, error: 'Provider rate limit (429)\n{"raw":"json"}' })
    ).toEqual({ title: 'Audit', body: 'Failed: Provider rate limit (429)' })
    expect(runFinishedNotice({ task: 'Audit', failed: true, reviewFiles: 2 })).toEqual({
      title: 'Audit',
      body: 'Failed · 2 files to review',
      reviewFiles: 2
    })
  })
})

describe('finishedNoticeFor', () => {
  let workspace: string
  let runDir: string

  beforeEach(() => {
    resetWriteCheckpointsForTests()
    resetPendingReviewCacheForTests()
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-notices-ws-'))
    runDir = mkdtempSync(join(tmpdir(), 'vyotiq-notices-run-'))
    writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\n', 'utf8')
    toolTodoWrite(runDir, [{ id: '1', content: 'Edit', status: 'in_progress' }])
  })

  afterEach(() => {
    resetWriteCheckpointsForTests()
    rmSync(workspace, { recursive: true, force: true })
    rmSync(runDir, { recursive: true, force: true })
  })

  async function edit(tool: string, args: Record<string, unknown>): Promise<void> {
    const result = await executeTool(tool, JSON.stringify(args), workspace, new AbortController().signal, { runDir })
    expect(result.ok).toBe(true)
  }

  it('counts the edits the run left and the checks it marked, from disk', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await edit('str_replace', { path: 'a.txt', old_string: 'two', new_string: '2' })
    await edit('edit', { path: 'b.txt', contents: 'new\n' })
    finalizeWriteCheckpoint(runDir)
    writeChecks(runDir, [
      { id: 'c1', text: 'Tests pass', source: 'brief', verdict: 'met', createdAt: '2026-09-24T00:00:00Z' },
      { id: 'c2', text: 'Lint is clean', source: 'plan', verdict: null, createdAt: '2026-09-24T00:00:00Z' }
    ])

    expect(
      finishedNoticeFor({ workspacePath: workspace, runId: 'run-1', runDir, failed: false, status: { goal: 'Tidy a.txt' } as never })
    ).toEqual({ title: 'Tidy a.txt', body: 'Ready for review · 2 files · 1/2 checks met', reviewFiles: 2 })
  })

  it('says Finished once the edits are kept', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await edit('str_replace', { path: 'a.txt', old_string: 'two', new_string: '2' })
    const meta = finalizeWriteCheckpoint(runDir)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'keep' })

    expect(
      finishedNoticeFor({ workspacePath: workspace, runId: 'run-1', runDir, failed: false, status: { goal: 'Tidy' } as never })
    ).toEqual({ title: 'Tidy', body: 'Finished' })
  })

  it('reports the status error of a failed run', () => {
    expect(
      finishedNoticeFor({
        workspacePath: workspace,
        runId: 'run-1',
        runDir,
        failed: true,
        status: { goal: 'Tidy', error: 'Connection reset' } as never
      })
    ).toEqual({ title: 'Tidy', body: 'Failed: Connection reset' })
  })
})

describe('approvalNoticeFor / questionNoticeFor', () => {
  const workspacePath = join(tmpdir(), 'vyotiq-notices-project')

  it('name the task from its status on disk', () => {
    const dir = resolveRunDir(workspacePath, 'run-abc')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ status: 'running', step: 1, updatedAt: '2026-09-24T00:00:00Z', goal: 'Add backpressure\nto the stream' })
    )
    expect(
      approvalNoticeFor(workspacePath, 'run-abc', { name: 'delete', summary: '', argsPreview: '{"path":"old.ts"}' })
    ).toEqual({ title: 'Add backpressure', body: 'Wants to delete old.ts' })
    expect(questionNoticeFor(workspacePath, 'run-abc', { questions: [] } as never)).toEqual({
      title: 'Add backpressure',
      body: 'Has a question for you'
    })
  })

  it('fall back to the run id when the run has no status yet', () => {
    expect(approvalNoticeFor(workspacePath, 'run-missing-status', { name: 'terminal', summary: 'ls', argsPreview: '' }).title).toBe(
      'run-miss'
    )
  })
})
