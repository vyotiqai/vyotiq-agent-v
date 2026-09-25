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

let workspace: string
let runDir: string

async function run(tool: string, args: Record<string, unknown>): Promise<void> {
  const result = await executeTool(tool, JSON.stringify(args), workspace, new AbortController().signal, {
    runDir
  })
  expect(result.ok).toBe(true)
}

beforeEach(() => {
  resetWriteCheckpointsForTests()
  resetPendingReviewCacheForTests()
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-review-ws-'))
  runDir = mkdtempSync(join(tmpdir(), 'vyotiq-review-run-'))
  writeFileSync(join(workspace, 'a.txt'), 'one\ntwo\nthree\n', 'utf8')
  toolTodoWrite(runDir, [{ id: '1', content: 'Edit the files', status: 'in_progress' }])
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
  rmSync(runDir, { recursive: true, force: true })
})

describe('pendingReviewSummary', () => {
  it('is absent for a task that wrote nothing', () => {
    expect(pendingReviewSummary(runDir, workspace)).toBeUndefined()
  })

  it('counts unresolved edits exactly, as git would', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await run('str_replace', { path: 'a.txt', old_string: 'two', new_string: 'TWO\nand a half' })
    await run('edit', { path: 'b.txt', contents: 'new\nfile\n' })
    finalizeWriteCheckpoint(runDir)

    // a.txt: −two +TWO +and a half; b.txt: +new +file
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 2, add: 4, del: 1 })
  })

  it('drops a task from review once its edits are kept', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await run('str_replace', { path: 'a.txt', old_string: 'two', new_string: '2' })
    const meta = finalizeWriteCheckpoint(runDir)
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 1, add: 1, del: 1 })

    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'keep' })
    expect(pendingReviewSummary(runDir, workspace)).toBeUndefined()
  })

  it('drops a task from review once its edits are undone', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await run('str_replace', { path: 'a.txt', old_string: 'two', new_string: '2' })
    const meta = finalizeWriteCheckpoint(runDir)
    resolveWrites(runDir, workspace, { checkpointId: meta!.id, action: 'discard' })
    expect(pendingReviewSummary(runDir, workspace)).toBeUndefined()
  })

  it('reads the file as it is now, so a later edit by you is counted', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await run('str_replace', { path: 'a.txt', old_string: 'two', new_string: '2' })
    finalizeWriteCheckpoint(runDir)
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 1, add: 1, del: 1 })

    writeFileSync(join(workspace, 'a.txt'), 'one\n2\nthree\nfour\n', 'utf8')
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 1, add: 2, del: 1 })
  })

  it('keeps the file count but drops numbers it cannot count exactly', async () => {
    beginWriteCheckpoint(runDir, workspace)
    await run('edit', { path: 'data.txt', contents: 'text for now' })
    finalizeWriteCheckpoint(runDir)
    // Something since turned it binary: a NUL byte, as git would detect it.
    writeFileSync(join(workspace, 'data.txt'), Buffer.from([0x50, 0x00, 0x4b]))
    expect(pendingReviewSummary(runDir, workspace)).toEqual({ files: 1 })
  })
})
