import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import {
  beginWriteCheckpoint,
  checkpointBeforeImagePath,
  finalizeWriteCheckpoint,
  listCheckpointMetas,
  resetWriteCheckpointsForTests,
  resolveWrites,
  setDirRestoreFileCapForTests
} from '@main/agent/checkpoints'
import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { pendingReviewSummary, resetPendingReviewCacheForTests } from '@main/agent/reviewSummary'
import { lineDiffStat } from '@shared/utils/lineDiffStat'
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
  setDirRestoreFileCapForTests(null)
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
    expect(await taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified', add: 1, del: 0 }])
  })

  it('nets every turn against the first before-image, and agrees with the navigator', async () => {
    await turn(() => run('str_replace', { path: 'swap.ts', old_string: 'prepare()', new_string: 'prepareStaging()' }))
    await turn(async () => {
      await run('str_replace', { path: 'swap.ts', old_string: 'prepareStaging()', new_string: 'prepare()' })
      await run('edit', { path: 'notes.md', contents: 'one\ntwo\n' })
    })
    const stats = await taskFileStats(runDir, workspace)
    // swap.ts went there and back: nothing left to review in it.
    expect(stats).toEqual([
      { path: 'notes.md', action: 'created', add: 2, del: 0 },
      { path: 'swap.ts', action: 'modified', add: 0, del: 0 }
    ])
    expect(await pendingReviewSummary(runDir, workspace)).toEqual({ files: 2, add: 2, del: 0 })
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
    expect(await taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified', add: 1, del: 1 }])
  })

  it('has no numbers for a file it cannot read as text', async () => {
    await turn(() => run('edit', { path: 'blob.txt', contents: 'text for now\n' }))
    writeFileSync(join(workspace, 'blob.txt'), Buffer.from([0x61, 0x00, 0x62]))
    expect(await taskFileStats(runDir, workspace)).toEqual([{ path: 'blob.txt', action: 'created' }])
  })

  // It ran in one synchronous piece: a task that wrote 20,000 files held the
  // main thread for over a minute, and the window showed "Not Responding".
  it('lets other work run while it counts', async () => {
    await turn(async () => {
      for (let i = 0; i < 40; i++) await run('edit', { path: `gen/f${i}.ts`, contents: `export const v${i} = ${i}\n` })
    })
    let otherWorkRan = false
    setImmediate(() => {
      otherWorkRan = true
    })
    const stats = await taskFileStats(runDir, workspace)
    expect(otherWorkRan).toBe(true)
    expect(stats).toHaveLength(40)
  })

  it('reads no copy for a write that cannot be undone, as its diff shows none', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    writeFileSync(join(workspace, 'swap.ts'), 'changed by a command\n', 'utf8')
    await cp.recordObservedMutation('swap.ts', 'modified')
    const id = finalizeWriteCheckpoint(runDir)!.id
    // A copy on disk all the same, as an oversized directory delete used to leave.
    const copy = checkpointBeforeImagePath(runDir, id, 'swap.ts')
    mkdirSync(dirname(copy), { recursive: true })
    writeFileSync(copy, 'a\nb\nc\n', 'utf8')
    expect(taskFileDiff(runDir, workspace, 'swap.ts').reason).toBe('unrestorable')
    expect(await taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified' }])
  })

  it('keeps no copies of a directory delete too large to undo', async () => {
    mkdirSync(join(workspace, 'deps'))
    for (let i = 0; i < 5; i++) writeFileSync(join(workspace, 'deps', `m${i}.js`), `module.exports = ${i}\n`, 'utf8')
    setDirRestoreFileCapForTests(3)
    const id = await turn(() => run('delete', { path: 'deps', recursive: true }))
    const files = listCheckpointMetas(runDir).find((meta) => meta.id === id)!.files
    expect(files.length).toBeGreaterThan(1)
    expect(files.every((file) => !file.undoable)).toBe(true)
    for (const file of files.filter((f) => f.path !== 'deps')) {
      expect(existsSync(checkpointBeforeImagePath(runDir, id, file.path))).toBe(false)
    }
    const stats = await taskFileStats(runDir, workspace)
    expect(stats.every((s) => s.action === 'deleted' && s.add === undefined)).toBe(true)
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

  it('a command’s change with no copy kept says what happened to the file, not a folder delete', async () => {
    const cp = beginWriteCheckpoint(runDir, workspace)
    writeFileSync(join(workspace, 'swap.ts'), 'changed by a command\n', 'utf8')
    await cp.recordObservedMutation('swap.ts', 'modified')
    finalizeWriteCheckpoint(runDir)
    expect(taskFileDiff(runDir, workspace, 'swap.ts')).toEqual({
      path: 'swap.ts',
      action: 'modified',
      diff: null,
      reason: 'unrestorable'
    })
    expect(await taskFileStats(runDir, workspace)).toEqual([{ path: 'swap.ts', action: 'modified' }])
  })

  it('a file the task created and then deleted is nothing to review — for the navigator too', async () => {
    await turn(() => run('edit', { path: 'tmp.ts', contents: 'scratch\n' }))
    await turn(() => run('delete_file', { path: 'tmp.ts' }))
    expect(await taskFileStats(runDir, workspace)).toEqual([])
    expect(await pendingReviewSummary(runDir, workspace)).toBeUndefined()
  })

  it('re-counts only the file that changed', async () => {
    await turn(() => run('edit', { path: 'one.ts', contents: 'a\n' }))
    await turn(() => run('edit', { path: 'two.ts', contents: 'b\n' }))
    expect((await taskFileStats(runDir, workspace)).map((s) => [s.path, s.add])).toEqual([
      ['one.ts', 1],
      ['two.ts', 1]
    ])
    writeFileSync(join(workspace, 'two.ts'), 'b\nc\nd\n', 'utf8')
    expect((await taskFileStats(runDir, workspace)).map((s) => [s.path, s.add])).toEqual([
      ['one.ts', 1],
      ['two.ts', 3]
    ])
  })

  // `lineDiff` gives up at 1500 edits and prints the whole file as a
  // replacement, whose counts are the file's, not the change's. The list
  // counted this same file exactly, so the detail view has to as well.
  it('counts a file too far apart to diff line by line, as the list does', async () => {
    const before = Array.from({ length: 1000 }, (_, i) => `old ${i}`).join('\n') + '\n'
    const after = Array.from({ length: 1000 }, (_, i) => `new ${i}`).join('\n') + '\n'
    writeFileSync(join(workspace, 'big.ts'), before, 'utf8')
    await turn(() => run('edit', { path: 'big.ts', contents: after }))

    // 2000 edits apart: past `lineDiff`'s 1500, inside `lineDiffStat`'s 4000.
    const exact = lineDiffStat(before, after)
    expect(exact).toEqual({ add: 1000, del: 1000 })
    const detail = taskFileDiff(runDir, workspace, 'big.ts')
    expect(detail.full).toBe(true)
    expect({ add: detail.add, del: detail.del }).toEqual(exact)
    const [listed] = await taskFileStats(runDir, workspace)
    expect({ add: listed.add, del: listed.del }).toEqual(exact)
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
