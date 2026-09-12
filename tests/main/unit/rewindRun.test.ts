import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { execFileSync } from 'child_process'
import { join } from 'path'
import { tmpdir } from 'os'
import { canGit } from '../../helpers/canGit'

const userData = join(tmpdir(), `vyotiq-rewind-ud-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    },
    getAppPath: () => '/tmp/vyotiq-app',
    isPackaged: false
  }
}))

import {
  beginWriteCheckpoint,
  finalizeWriteCheckpoint,
  getWriteCheckpointMeta,
  resetWriteCheckpointsForTests
} from '@main/agent/checkpoints'
import {
  planRewindToUserMessage,
  prepareRewindAndReplaceUserMessage,
  prepareRewindToUserMessage
} from '@main/agent/rewindRun'
import { recordMergedInstanceChanges } from '@main/agent/tools/mergeCheckpoint'
import { mergeInstanceBranch } from '@main/git/instanceWorktree'
import {
  appendEvent,
  createRun,
  flushEventAppends,
  loadCompaction,
  loadEventsAsync,
  loadMessages,
  saveCompaction,
  syncMessagesAsync
} from '@main/agent/state'

let workspace: string
let runId: string
let runDir: string

beforeEach(() => {
  resetWriteCheckpointsForTests()
  workspace = join(tmpdir(), `vyotiq-rewind-ws-${process.pid}-${Date.now()}-${Math.random()}`)
  mkdirSync(workspace, { recursive: true })
  mkdirSync(join(userData, 'sessions'), { recursive: true })
  runId = `run-${Date.now()}`
  runDir = createRun(workspace, runId, 'test')
  writeFileSync(join(workspace, 'a.txt'), 'hello\n', 'utf8')
})

afterEach(() => {
  resetWriteCheckpointsForTests()
  rmSync(workspace, { recursive: true, force: true })
})

describe('prepareRewindAndReplaceUserMessage', () => {
  it('truncates messages/events and restores files for the edited turn', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      {
        role: 'assistant' as const,
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user' as const, content: 'second' },
      {
        role: 'assistant' as const,
        content: 'ok2',
        toolCalls: [{ id: 't2', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't2', toolName: 'edit', content: 'done2', ok: true }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await cp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-first\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta1!.id,
      files: meta1!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't1',
      name: 'edit',
      summary: 'a.txt'
    })

    const cp2 = beginWriteCheckpoint(runDir, workspace, 3)
    await cp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta2!.id,
      files: meta2!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't2',
      name: 'edit',
      summary: 'a.txt'
    })
    await flushEventAppends(runDir)

    saveCompaction(runDir, {
      summary: 'old',
      createdAt: new Date().toISOString(),
      tokenEstimate: 10,
      foldedMessages: 5
    })

    const prepared = await prepareRewindAndReplaceUserMessage({
      workspacePath: workspace,
      runId,
      editMessageIndex: 3,
      editedUserMessage: { role: 'user', content: 'second-edited' }
    })

    expect(prepared.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user', content: 'second-edited' }
    ])
    expect(loadMessages(workspace, runId)).toEqual(prepared.messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after-first\n')
    expect(loadCompaction(runDir)).toBeNull()

    const events = await loadEventsAsync(runDir, runId)
    expect(
      events.some(
        (e) =>
          e.event.type === 'tool_start' &&
          (e.event as { toolCallId?: string }).toolCallId === 't2'
      )
    ).toBe(false)
    expect(
      events.some(
        (e) =>
          e.event.type === 'writes_checkpoint' &&
          (e.event as { checkpointId?: string }).checkpointId === meta2!.id
      )
    ).toBe(false)

    expect(existsSync(join(runDir, 'receipt.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8')) as {
      status: string
    }
    expect(receipt.status).toBe('done')
    expect(existsSync(join(runDir, 'trajectory.jsonl'))).toBe(true)
  })
})

describe('prepareRewindToUserMessage', () => {
  it('keeps original user text, truncates later turns, and restores files', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      {
        role: 'assistant' as const,
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user' as const, content: 'second' },
      {
        role: 'assistant' as const,
        content: 'ok2',
        toolCalls: [{ id: 't2', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool' as const, toolCallId: 't2', toolName: 'edit', content: 'done2', ok: true }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await cp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-first\n', 'utf8')
    const meta1 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta1!.id,
      files: meta1!.files
    })

    const cp2 = beginWriteCheckpoint(runDir, workspace, 3)
    await cp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    const meta2 = finalizeWriteCheckpoint(runDir)
    appendEvent(runDir, {
      type: 'writes_checkpoint',
      runId,
      checkpointId: meta2!.id,
      files: meta2!.files
    })
    appendEvent(runDir, {
      type: 'tool_start',
      runId,
      toolCallId: 't2',
      name: 'edit',
      summary: 'a.txt'
    })
    await flushEventAppends(runDir)

    const prepared = await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(prepared.messages).toEqual([
      { role: 'user', content: 'first' },
      {
        role: 'assistant',
        content: 'ok',
        toolCalls: [{ id: 't1', name: 'edit', arguments: '{}' }]
      },
      { role: 'tool', toolCallId: 't1', toolName: 'edit', content: 'done', ok: true },
      { role: 'user', content: 'second' }
    ])
    expect(loadMessages(workspace, runId)).toEqual(prepared.messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after-first\n')

    const events = await loadEventsAsync(runDir, runId)
    expect(
      events.some(
        (e) =>
          e.event.type === 'tool_start' &&
          (e.event as { toolCallId?: string }).toolCallId === 't2'
      )
    ).toBe(false)
    expect(
      events.some(
        (e) =>
          e.event.type === 'writes_checkpoint' &&
          (e.event as { checkpointId?: string }).checkpointId === meta2!.id
      )
    ).toBe(false)

    expect(existsSync(join(runDir, 'receipt.json'))).toBe(true)
    const receipt = JSON.parse(readFileSync(join(runDir, 'receipt.json'), 'utf8')) as {
      status: string
    }
    expect(receipt.status).toBe('done')
    expect(existsSync(join(runDir, 'trajectory.jsonl'))).toBe(true)
  })

  it('clears orphaned todos.json when rewind drops every todo_write', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user' as const, content: 'plan work' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/1 complete',
        ok: true
      },
      { role: 'user' as const, content: 'follow-up' }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'pending' }])
    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(false)
    expect(loadMessages(workspace, runId)).toEqual([{ role: 'user', content: 'plan work' }])
  })

  it('keeps todos.json when rewind still retains a todo_write', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user' as const, content: 'plan work' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: '0/1 complete\n[ ] (1) Ship',
        ok: true
      },
      { role: 'user' as const, content: 'follow-up' },
      {
        role: 'assistant' as const,
        content: '',
        toolCalls: [{ id: 'todo2', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool' as const,
        toolCallId: 'todo2',
        toolName: 'todo_write',
        content: '0/1 complete\n[ ] (1) Later task',
        ok: true
      }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Later task', status: 'pending' }])

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)
    expect(loadMessages(workspace, runId).some((m) => m.toolName === 'todo_write')).toBe(true)
    const todos = JSON.parse(readFileSync(join(runDir, 'todos.json'), 'utf8')) as {
      todos: Array<{ content: string }>
    }
    expect(todos.todos[0]?.content).toBe('Ship')
  })

  it('does not truncate history when an undoable checkpoint restore fails', async () => {
    const messages = [
      { role: 'user' as const, content: 'first' },
      { role: 'assistant' as const, content: 'ok' },
      { role: 'user' as const, content: 'second' }
    ]
    await syncMessagesAsync(runDir, messages)

    const cp = beginWriteCheckpoint(runDir, workspace, 2)
    await cp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    writeFileSync(join(workspace, 'a.txt'), 'user-edit\n', 'utf8')

    await expect(
      prepareRewindToUserMessage({
        workspacePath: workspace,
        runId,
        userMessageIndex: 2
      })
    ).rejects.toThrow(/history was not truncated/)

    expect(loadMessages(workspace, runId)).toEqual(messages)
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('user-edit\n')
  })

  it('drops todos.json when the kept todo_write snapshot is unparseable', async () => {
    const { toolTodoWrite } = await import('@main/agent/tools/todo')
    const messages = [
      { role: 'user', content: 'plan work' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'todo1', name: 'todo_write', arguments: '{}' }]
      },
      {
        role: 'tool',
        toolCallId: 'todo1',
        toolName: 'todo_write',
        content: 'garbled snapshot',
        ok: true
      },
      { role: 'user', content: 'follow-up' }
    ]
    await syncMessagesAsync(runDir, messages)
    toolTodoWrite(runDir, [{ id: '1', content: 'Ship', status: 'pending' }])
    expect(existsSync(join(runDir, 'todos.json'))).toBe(true)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 3
    })

    expect(existsSync(join(runDir, 'todos.json'))).toBe(false)
    expect(loadMessages(workspace, runId).some((m) => m.toolName === 'todo_write')).toBe(true)
  })

})

describe('instance rewind', () => {
  const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3))

  function createInstanceRun(
    childRunId: string,
    opts?: { worktreePath?: string; worktreeBranch?: string }
  ): string {
    return createRun(workspace, childRunId, 'instance goal', {
      parentRunId: runId,
      inlineInstance: true,
      ...(opts?.worktreePath ? { worktreePath: opts.worktreePath } : {}),
      ...(opts?.worktreeBranch ? { worktreeBranch: opts.worktreeBranch } : {})
    })
  }

  it('restores shared-workspace instance writes spawned in the rewound region', async () => {
    const childRunId = `child-${Date.now()}-a`
    const childDir = createInstanceRun(childRunId)
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'spawn_agent_instance',
        content: `Instance a\nrun_id: ${childRunId}`,
        ok: true
      }
    ])

    const parentCp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await parentCp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-first\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    await tick()

    const childCp = beginWriteCheckpoint(childDir, workspace, 0)
    await childCp.recordPrior('inst-created.txt', 'write')
    await childCp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'inst-created.txt'), 'from-instance\n', 'utf8')
    writeFileSync(join(workspace, 'a.txt'), 'instance-edit\n', 'utf8')
    const childMeta = finalizeWriteCheckpoint(childDir)
    await tick()

    const parentCp2 = beginWriteCheckpoint(runDir, workspace, 1)
    await parentCp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    finalizeWriteCheckpoint(runDir)

    const prepared = await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 1
    })

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('after-first\n')
    expect(existsSync(join(workspace, 'inst-created.txt'))).toBe(false)
    expect(prepared.writes.restored).toContain('inst-created.txt')
    expect(getWriteCheckpointMeta(childDir, childMeta!.id)?.resolved).toBe(true)
    expect(getWriteCheckpointMeta(childDir, childMeta!.id)?.undone).toBe(true)
  })

  it('keeps instance writes spawned before the revert point', async () => {
    const childRunId = `child-${Date.now()}-b`
    const childDir = createInstanceRun(childRunId)
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'spawn_agent_instance',
        content: `Instance b\nrun_id: ${childRunId}`,
        ok: true
      },
      { role: 'user', content: 'second' }
    ])

    const childCp = beginWriteCheckpoint(childDir, workspace, 0)
    await childCp.recordPrior('inst-kept.txt', 'write')
    writeFileSync(join(workspace, 'inst-kept.txt'), 'from-instance\n', 'utf8')
    finalizeWriteCheckpoint(childDir)
    await tick()

    const parentCp = beginWriteCheckpoint(runDir, workspace, 2)
    await parentCp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    finalizeWriteCheckpoint(runDir)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 2
    })

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(readFileSync(join(workspace, 'inst-kept.txt'), 'utf8')).toBe('from-instance\n')
  })

  it('restores the oldest prior content when parent and instances interleave on one file', async () => {
    const child1 = `child-${Date.now()}-c`
    const child2 = `child-${Date.now()}-d`
    const child1Dir = createInstanceRun(child1)
    const child2Dir = createInstanceRun(child2)
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'spawn_agent_instance',
        content: `Instance c\nrun_id: ${child1}`,
        ok: true
      },
      { role: 'user', content: 'second' },
      {
        role: 'tool',
        toolCallId: 's2',
        toolName: 'spawn_agent_instance',
        content: `Instance d\nrun_id: ${child2}`,
        ok: true
      }
    ])

    const cp1 = beginWriteCheckpoint(runDir, workspace, 0)
    await cp1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'p1\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    await tick()

    const cpChild1 = beginWriteCheckpoint(child1Dir, workspace, 0)
    await cpChild1.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'i1\n', 'utf8')
    finalizeWriteCheckpoint(child1Dir)
    await tick()

    const cp2 = beginWriteCheckpoint(runDir, workspace, 2)
    await cp2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'p2\n', 'utf8')
    finalizeWriteCheckpoint(runDir)
    await tick()

    const cpChild2 = beginWriteCheckpoint(child2Dir, workspace, 0)
    await cpChild2.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'i2\n', 'utf8')
    const child2Meta = finalizeWriteCheckpoint(child2Dir)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('hello\n')
    expect(getWriteCheckpointMeta(child2Dir, child2Meta!.id)?.resolved).toBe(true)
  })

  it('does not rewind worktree instances — their edits never touch this workspace', async () => {
    const childRunId = `child-${Date.now()}-e`
    const childDir = createInstanceRun(childRunId, {
      worktreePath: join(workspace, '.vyotiq-worktrees', childRunId),
      worktreeBranch: `instance/${childRunId}`
    })
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'spawn_agent_instance',
        content: `Instance e\nrun_id: ${childRunId}`,
        ok: true
      }
    ])

    const childCp = beginWriteCheckpoint(childDir, workspace, 0)
    await childCp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'worktree-edit\n', 'utf8')
    finalizeWriteCheckpoint(childDir)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('worktree-edit\n')
  })

  it('previews instance files together with parent files', async () => {
    const childRunId = `child-${Date.now()}-f`
    const childDir = createInstanceRun(childRunId)
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' },
      {
        role: 'tool',
        toolCallId: 's1',
        toolName: 'spawn_agent_instance',
        content: `Instance f\nrun_id: ${childRunId}`,
        ok: true
      }
    ])

    const childCp = beginWriteCheckpoint(childDir, workspace, 0)
    await childCp.recordPrior('inst-created.txt', 'write')
    writeFileSync(join(workspace, 'inst-created.txt'), 'from-instance\n', 'utf8')
    finalizeWriteCheckpoint(childDir)
    await tick()

    const parentCp = beginWriteCheckpoint(runDir, workspace, 1)
    await parentCp.recordPrior('a.txt', 'write')
    writeFileSync(join(workspace, 'a.txt'), 'after-second\n', 'utf8')
    finalizeWriteCheckpoint(runDir)

    const plan = await planRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 1
    })

    const paths = plan.files.map((f) => f.path)
    expect(paths).toContain('a.txt')
    expect(paths).toContain('inst-created.txt')
  })

  it('only rewinds instances with an unlocatable spawn turn at the very start', async () => {
    const childRunId = `child-${Date.now()}-g`
    const childDir = createInstanceRun(childRunId)
    await syncMessagesAsync(runDir, [
      { role: 'user', content: 'first' },
      { role: 'user', content: 'second' }
    ])

    const childCp = beginWriteCheckpoint(childDir, workspace, 0)
    await childCp.recordPrior('orphan.txt', 'write')
    writeFileSync(join(workspace, 'orphan.txt'), 'from-instance\n', 'utf8')
    finalizeWriteCheckpoint(childDir)

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 1
    })
    expect(readFileSync(join(workspace, 'orphan.txt'), 'utf8')).toBe('from-instance\n')

    await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })
    expect(existsSync(join(workspace, 'orphan.txt'))).toBe(false)
  })

})

describe.skipIf(!canGit)('merged instance-branch rewind', () => {
  function git(...args: string[]): void {
    execFileSync('git', args, {
      cwd: workspace,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
  }

  function commitAll(message: string): void {
    git('add', '-A')
    git('-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', message)
  }

  it('reverts changes a merged instance branch applied to the workspace', async () => {
    // Turn the test workspace into the repo the parent run writes against.
    git('init', '--initial-branch=main')
    // Byte-faithful checkouts on Windows (autocrlf would rewrite LF to CRLF).
    git('config', 'core.autocrlf', 'false')
    writeFileSync(join(workspace, 'a.txt'), 'base\n', 'utf8')
    writeFileSync(join(workspace, 'removed-by-merge.txt'), 'gone\n', 'utf8')
    commitAll('base')

    // Simulate the instance branch: create, modify, and delete files.
    const branch = `vyotiq/instance/test-${process.pid}`
    git('checkout', '-b', branch)
    writeFileSync(join(workspace, 'a.txt'), 'instance edit\n', 'utf8')
    writeFileSync(join(workspace, 'merged-created.txt'), 'from-instance\n', 'utf8')
    rmSync(join(workspace, 'removed-by-merge.txt'))
    commitAll('instance work')
    git('checkout', 'main')

    await syncMessagesAsync(runDir, [{ role: 'user', content: 'first' }])

    const cp = beginWriteCheckpoint(runDir, workspace, 0)
    const merge = await mergeInstanceBranch(workspace, branch)
    expect(merge.ok).toBe(true)
    if (!merge.ok) return
    await recordMergedInstanceChanges(workspace, { runDir }, merge)
    const meta = finalizeWriteCheckpoint(runDir)
    expect(meta).not.toBeNull()

    // Merge applied: instance edit live, created file exists, file deleted.
    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('instance edit\n')
    expect(readFileSync(join(workspace, 'merged-created.txt'), 'utf8')).toBe('from-instance\n')
    expect(existsSync(join(workspace, 'removed-by-merge.txt'))).toBe(false)

    // Preview already lists the merged changes before anything is restored.
    const plan = await planRewindToUserMessage({ workspacePath: workspace, runId, userMessageIndex: 0 })
    const planPaths = plan.files.map((f) => f.path)
    expect(planPaths).toContain('a.txt')
    expect(planPaths).toContain('merged-created.txt')
    expect(planPaths).toContain('removed-by-merge.txt')

    const prepared = await prepareRewindToUserMessage({
      workspacePath: workspace,
      runId,
      userMessageIndex: 0
    })

    expect(readFileSync(join(workspace, 'a.txt'), 'utf8')).toBe('base\n')
    expect(existsSync(join(workspace, 'merged-created.txt'))).toBe(false)
    expect(readFileSync(join(workspace, 'removed-by-merge.txt'), 'utf8')).toBe('gone\n')
    expect(prepared.writes.restored).toEqual(
      expect.arrayContaining(['a.txt', 'merged-created.txt', 'removed-by-merge.txt'])
    )
    expect(getWriteCheckpointMeta(runDir, meta!.id)?.resolved).toBe(true)
  }, 30_000)
})
