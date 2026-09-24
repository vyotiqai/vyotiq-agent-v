import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  resetWriteCheckpointsForTests,
  resolveWrites
} from '@main/agent/checkpoints'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { pendingReviewSummary, resetPendingReviewCacheForTests } from '@main/agent/reviewSummary'
import { resetTaskFileStatsCacheForTests, taskFileDiff, taskFileStats } from '@main/agent/taskFileDiff'

let workspace: string
let runDir: string

async function run(tool: string, args: Record<string, unknown>): Promise<void> {
  const result = await executeTool(tool, JSON.stringify(args), workspace, new AbortController().signal, {
    runDir
  })
  expect(result.ok).toBe(true)
}

async function turn(body: () => Promise<void>): Promise<string> {
  beginWriteCheckpoint(runDir, workspace)
  await body()
  return finalizeWriteCheckpoint(runDir)!.id
}

beforeEach(() => {
  resetWriteCheckpointsForTests()
  resetPendingReviewCacheForTests()
  resetTaskFileStatsCacheForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-taskdiff-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-taskdiff-run-'))
  writeFileSync(
    join(workspace, 'swap.ts'),
    ['export async function swapStaged() {', '  await prepare()', '  await rename(staged, target)', '}', ''].join('\n'),
    'utf8'
  )
  toolTodoWrite(runDir, [{ id: '1', content: 'Edit the files', status: 'in_progress' }])
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('taskFileStats', () => {
  it('counts a replacement by the lines it really changed, not its old and new text wholesale', async () => {
    await turn(() =>
      run('str_replace', {
        path: 'swap.ts',
        old_string: '  await rename(staged, target)',
        new_string: '  await closeStagingWatcher()\n  await rename(staged, target)'
      })
    )
    expect(taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified', add: 1, del: 0 }])
  })

  it('nets every turn against the first before-image, and agrees with the navigator', async () => {
    await turn(() => run('str_replace', { path: 'swap.ts', old_string: 'prepare()', new_string: 'prepareStaging()' }))
    await turn(async () => {
      await run('str_replace', { path: 'swap.ts', old_string: 'prepareStaging()', new_string: 'prepare()' })
      await run('edit', { path: 'notes.md', contents: 'one\ntwo\n' })
    })
    const stats = taskFileStats(runDir, workspace)
    // swap.ts went there and back: nothing left to review in it.
    expect(stats).toEqual([
      { path: 'notes.md', action: 'created', add: 2, del: 0 },
      { path: 'swap.ts', action: 'modified', add: 0, del: 0 }
    ])
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 2, add: 2, del: 0 })
  })

  it('keeps kept files, and nets out what was undone', async () => {
    // Keeping every file stamps the checkpoint `undone` too; it must still count.
    const kept = await turn(() => run('str_replace', { path: 'swap.ts', old_string: 'prepare()', new_string: 'ready()' }))
    resolveWrites(runDir, workspace, { checkpointId: kept, action: 'keep' })
    const created = await turn(() => run('edit', { path: 'gone.ts', contents: 'x\n' }))
    resolveWrites(runDir, workspace, { checkpointId: created, action: 'discard' })
    const again = await turn(() => run('str_replace', { path: 'swap.ts', old_string: 'ready()', new_string: 'set()' }))
    resolveWrites(runDir, workspace, { checkpointId: again, action: 'discard' })
    // gone.ts was created and undone: nothing left. swap.ts is back to the kept edit.
    expect(taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified', add: 1, del: 1 }])
  })

  it('has no numbers for a file it cannot read as text', async () => {
    await turn(() => run('edit', { path: 'blob.txt', contents: 'text for now\n' }))
    writeFileSync(join(workspace, 'blob.txt'), Buffer.from([0x61, 0x00, 0x62]))
    expect(taskFileStats(runDir, workspace)).toEqual([{ path: 'blob.txt', action: 'created' }])
  })
})

describe('taskFileDiff', () => {
  it('prints the change with real line numbers and the function it sits in', async () => {
    await turn(() =>
      run('str_replace', {
        path: 'swap.ts',
        old_string: '  await rename(staged, target)',
        new_string: '  await closeStagingWatcher()\n  await rename(staged, target)'
      })
    )
    expect(taskFileDiff(runDir, workspace, 'swap.ts')).toEqual({
      path: 'swap.ts',
      action: 'modified',
      add: 1,
      del: 0,
      diff: [
        '--- a/swap.ts',
        '+++ b/swap.ts',
        '@@ -1,4 +1,5 @@',
        ' export async function swapStaged() {',
        '   await prepare()',
        '+  await closeStagingWatcher()',
        '   await rename(staged, target)',
        ' }',
        ''
      ].join('\n')
    })
  })

  it('shows a created file from /dev/null', async () => {
    await turn(() => run('edit', { path: 'src/new.ts', contents: 'export const a = 1\n' }))
    const diff = taskFileDiff(runDir, workspace, './src/new.ts')
    expect(diff.action).toBe('created')
    expect(diff.diff).toBe('--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1 @@\n+export const a = 1\n')
  })

  it('says when a path is not one the task wrote', () => {
    expect(taskFileDiff(runDir, workspace, 'swap.ts')).toEqual({
      path: 'swap.ts',
      action: null,
      diff: null,
      reason: 'not_in_task'
    })
  })
})
