import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const tmpRoot = mkdtempSync(join(tmpdir(), 'vyotiq-teammate-tools-'))

vi.mock('electron', () => ({
  app: { getPath: () => tmpRoot },
  BrowserWindow: class {}
}))

const pushes: string[] = []
vi.mock('@main/app/window', () => ({
  getMainWindow: () => ({
    isDestroyed: () => false,
    webContents: {
      isDestroyed: () => false,
      send: (channel: string) => {
        pushes.push(channel)
      }
    }
  })
}))

vi.mock('@main/workspace/workspaces', () => ({
  getWorkspaces: () => ({
    openPaths: [workspace],
    recentPaths: [],
    uiStateByPath: {},
    activePath: workspace
  })
}))

import { executeTool } from '@main/agent/tools'
import {
  clearAgentProfilesCacheForTests,
  listAgentProfiles,
  getAgentProfile
} from '@main/settings/agentProfiles'
import {
  listTasks,
  resetTaskSchedulerForTests,
  resumeTasksForWorkspaces
} from '@main/agent/taskScheduler'
import { isApprovalExemptTool } from '@main/agent/tools/classify'
import { isBuiltinAllowedInMode } from '@main/agent/tools/modePolicy'
import { AGENT_TOOLS, BUILTIN_TOOL_NAMES } from '@main/agent/schemas/tools'
import { resolveRunDir } from '@main/storage/paths'

/**
 * The agent managing its own teammates.
 *
 * Instances are the hands and teammates are the who — the agent could always
 * create the former and never the latter, so "keep this for next time" had no
 * home it could reach. These tools close that, with full control over every
 * profile field and no quota on the roster, by product decision.
 */

const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-teammate-ws-'))

const TOOLS = [
  'teammate_list',
  'teammate_create',
  'teammate_update',
  'teammate_delete',
  'teammate_assign_task',
  'teammate_task'
] as const

/**
 * Write a terminal task straight into a workspace's `tasks.json`.
 *
 * The scheduler has no way to fabricate a finished task in-process without
 * running one, and the file IS its durable contract — seeding it exercises the
 * same parse the app does at boot.
 */
function seedFinishedTask(
  root: string,
  task: {
    id: string
    profileId: string
    status: 'done' | 'failed' | 'cancelled'
    finishedAt: string
    error?: string
    runId?: string
  }
): void {
  const dir = join(root, '.vyotiq')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'tasks.json')
  const existing = existsSync(path)
    ? (JSON.parse(readFileSync(path, 'utf8')) as { tasks: unknown[] }).tasks
    : []
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      tasks: [
        ...existing,
        {
          ...task,
          workspacePath: root,
          prompt: `brief for ${task.id}`,
          createdAt: task.finishedAt
        }
      ]
    }),
    'utf8'
  )
}

/**
 * A run directory a finished task can be read back through.
 *
 * `teammate_task result` goes to the durable transcript rather than any live
 * registry, which is the whole point: the run is long gone by the time the
 * agent asks.
 */
function seedRunTranscript(
  root: string,
  runId: string,
  opts: { status: 'done' | 'error' | 'cancelled'; error?: string; assistant?: string }
): void {
  const dir = resolveRunDir(root, runId)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'status.json'),
    // `updatedAt` is required by RunStatusSchema; without it loadStatus parses
    // the file as corrupt and answers null, which reads as "no outcome".
    JSON.stringify({
      status: opts.status,
      step: 1,
      updatedAt: '2026-09-20T10:00:00.000Z',
      ...(opts.error ? { error: opts.error } : {})
    }),
    'utf8'
  )
  const body = opts.assistant
    ? `${JSON.stringify({ role: 'assistant', content: opts.assistant })}\n`
    : ''
  writeFileSync(join(dir, 'messages.jsonl'), body, 'utf8')
}

function run(name: string, args: Record<string, unknown> = {}) {
  return executeTool(name, JSON.stringify(args), workspace, new AbortController().signal, {
    runDir: workspace
  })
}

beforeEach(() => {
  clearAgentProfilesCacheForTests()
  resetTaskSchedulerForTests()
  rmSync(join(tmpRoot, 'agents.json'), { force: true })
  rmSync(join(workspace, '.vyotiq'), { recursive: true, force: true })
  pushes.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('teammate tools are registered and reachable', () => {
  it('exposes all five in the builtin catalog', () => {
    for (const name of TOOLS) {
      expect(BUILTIN_TOOL_NAMES).toContain(name)
    }
  })

  it('runs without an approval prompt, like spawn_agent_instance', () => {
    // Full control by default: the agent already spawns workers without
    // asking, and a teammate is the durable form of the same act.
    for (const name of TOOLS) {
      expect(isApprovalExemptTool(name)).toBe(true)
    }
    expect(isApprovalExemptTool('spawn_agent_instance')).toBe(true)
  })

  it('is Agent-mode only — Ask and Plan cannot create identities', () => {
    for (const name of TOOLS) {
      expect(isBuiltinAllowedInMode('agent', name)).toBe(true)
      expect(isBuiltinAllowedInMode('ask', name)).toBe(false)
      expect(isBuiltinAllowedInMode('plan', name)).toBe(false)
    }
  })
})

describe('teammate_create', () => {
  it('creates a teammate that reaches the real roster', async () => {
    const result = await run('teammate_create', {
      name: 'Scout',
      persona: 'A terse frontend engineer.',
      identity: 'Owns the design system.',
      tone: 'Direct.'
    })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('id: scout')
    const stored = getAgentProfile('scout')
    expect(stored?.name).toBe('Scout')
    expect(stored?.persona).toBe('A terse frontend engineer.')
    // The same push the pane fires, so the roster updates without a reload.
    expect(pushes).toContain('agent-profiles:changed')
  })

  it('grants full autonomy when asked, with no refusal', async () => {
    // The product decision under test: the agent may widen the autonomy of
    // identities it creates. High-risk tools stay gated for every teammate
    // regardless — that limit lives in isAutonomousHighRiskTool, not here.
    const result = await run('teammate_create', {
      name: 'Ops',
      autonomous_mode: 'on',
      auto_resume_on_launch: true
    })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('ops')?.autonomousMode).toBe('on')
    expect(getAgentProfile('ops')?.autoResumeOnLaunch).toBe(true)
  })

  it('accepts a model pin and rejects half of one', async () => {
    const ok = await run('teammate_create', {
      name: 'Pinned',
      model_provider: 'anthropic',
      model_id: 'claude-opus-5'
    })
    expect(ok.ok).toBe(true)
    expect(getAgentProfile('pinned')?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-opus-5'
    })

    // A provider with no model id fails AgentProfileModelSchema at the store
    // boundary, so it is caught here with a message the model can act on.
    const half = await run('teammate_create', { name: 'Half', model_provider: 'anthropic' })
    expect(half.ok).toBe(false)
    expect(half.content).toContain('together')

    const bogus = await run('teammate_create', {
      name: 'Bogus',
      model_provider: 'not-a-provider',
      model_id: 'x'
    })
    expect(bogus.ok).toBe(false)
    expect(bogus.content).toContain('Unknown provider')
  })

  it("seeds the new teammate's memory, so it knows something on its first run", async () => {
    // memory_write always targets the CALLING run's namespace and writeGuard
    // refuses to reach into another teammate's, so without this a teammate the
    // agent creates starts every first run blank.
    const result = await run('teammate_create', {
      name: 'Scout',
      persona: 'Frontend.',
      memory: '# What Scout knows\n\n- Styling lives in src/renderer/src/lib/ui.'
    })

    expect(result.ok).toBe(true)
    const index = join(workspace, '.vyotiq', 'agents', 'scout', 'memory', 'index.md')
    expect(readFileSync(index, 'utf8')).toContain('Styling lives in src/renderer/src/lib/ui.')
    expect(result.content).toContain('Seeded its index.md')
  })

  it('creates the teammate anyway when there is no project to seed into', async () => {
    const result = await executeTool(
      'teammate_create',
      JSON.stringify({ name: 'Scout', memory: 'Something.' }),
      '',
      new AbortController().signal,
      {}
    )

    // Losing the teammate to a seeding problem would be the worse outcome.
    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')).toBeTruthy()
    expect(result.content).toContain('memory is per project')
  })

  it('imposes no cap on how many teammates exist', async () => {
    for (let i = 0; i < 40; i += 1) {
      const result = await run('teammate_create', { name: `Bulk ${i}` })
      expect(result.ok).toBe(true)
    }
    expect(listAgentProfiles()).toHaveLength(40)
  })

  it('cannot pin a teammate to a runtime that would refuse every run', async () => {
    // AgentProfileRuntimeSchema still accepts 'cloud' and nothing registers it,
    // so resolveAvailableRuntime refuses such a run outright. Offering it to the
    // agent could only ever brick the identity it had just created.
    const result = await run('teammate_create', { name: 'Scout', runtime: 'cloud' })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')?.runtime).toBeUndefined()
  })

  it('names the real avatar keys so a chosen icon is not silently dropped', () => {
    const avatar = AGENT_TOOLS.find((t) => t.name === 'teammate_create')?.parameters as {
      properties?: { avatar?: { description?: string } }
    }
    expect(avatar?.properties?.avatar?.description).toContain('sparkles')
    expect(avatar?.properties?.avatar?.description).toContain('scanSearch')
  })

  it('refuses a workspace-scoped teammate with no workspace, which is not a cap', async () => {
    const result = await executeTool(
      'teammate_create',
      JSON.stringify({ name: 'Scoped', scope: 'workspace' }),
      '',
      new AbortController().signal,
      {}
    )
    expect(result.ok).toBe(false)
    expect(result.content).toContain('needs an open workspace')
  })
})

describe('teammate_list', () => {
  it('reports the roster with enough detail to act on', async () => {
    await run('teammate_create', { name: 'Scout', persona: 'Frontend.' })
    const result = await run('teammate_list')

    expect(result.ok).toBe(true)
    expect(result.content).toContain('id: scout')
    expect(result.content).toContain('persona: Frontend.')
  })

  it('reports finished work, so a delegated run can be followed up', async () => {
    // Terminal tasks used to be filtered out entirely, which left the agent
    // told to "check on it with teammate_list" by a tool that could never
    // report an outcome.
    seedFinishedTask(workspace, {
      id: 'task-old-1',
      profileId: 'scout',
      status: 'failed',
      finishedAt: '2026-09-20T10:00:00.000Z',
      error: 'Interrupted by app restart — retry to run it again'
    })
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Next job.' })

    const result = await run('teammate_list')

    expect(result.ok).toBe(true)
    expect(result.content).toContain('finished: failed task-old-1')
    expect(result.content).toContain('Interrupted by app restart')
    // The live one still reads as live, on its own line.
    expect(result.content).toMatch(/work: (queued|running) task-/)
  })

  it('caps the finished list at the most recent three', async () => {
    for (const [index, day] of ['17', '18', '19', '20'].entries()) {
      seedFinishedTask(workspace, {
        id: `task-history-${index}`,
        profileId: 'scout',
        status: 'done',
        finishedAt: `2026-09-${day}T10:00:00.000Z`
      })
    }
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Next job.' })

    const result = await run('teammate_list')

    expect(result.content).toContain('task-history-3')
    expect(result.content).toContain('task-history-2')
    expect(result.content).toContain('task-history-1')
    expect(result.content).not.toContain('task-history-0')
  })

  it('names the project when a teammate is busy in another workspace', async () => {
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-teammate-other-'))
    seedFinishedTask(other, {
      id: 'task-elsewhere',
      profileId: 'scout',
      status: 'done',
      finishedAt: '2026-09-20T10:00:00.000Z'
    })
    await run('teammate_create', { name: 'Scout' })
    // listTasks() flattens every loaded workspace, so without the note a row
    // from another project reads as work in this one.
    await resumeTasksForWorkspaces([other])

    const result = await run('teammate_list')

    expect(result.content).toContain(`task-elsewhere in ${other}`)
    rmSync(other, { recursive: true, force: true })
  })

  it('says so plainly when there are none', async () => {
    const result = await run('teammate_list')
    expect(result.ok).toBe(true)
    expect(result.content).toContain('No teammates exist yet')
  })
})

describe('teammate_update', () => {
  it('changes only the fields it is given', async () => {
    await run('teammate_create', { name: 'Scout', persona: 'Original.', tone: 'Terse.' })

    const result = await run('teammate_update', { id: 'scout', persona: 'Rewritten.' })

    expect(result.ok).toBe(true)
    const stored = getAgentProfile('scout')
    expect(stored?.persona).toBe('Rewritten.')
    // Untouched fields survive — an update is a patch, not a replace.
    expect(stored?.tone).toBe('Terse.')
    expect(stored?.name).toBe('Scout')
  })

  it('keeps the id when the name changes, so memory follows the teammate', async () => {
    await run('teammate_create', { name: 'Scout' })
    const result = await run('teammate_update', { id: 'scout', name: 'Pathfinder' })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')?.name).toBe('Pathfinder')
  })

  it('refuses an unknown id with a recoverable message', async () => {
    const result = await run('teammate_update', { id: 'ghost', persona: 'x' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('teammate_list')
  })

  it('narrows scope to the current workspace instead of a raw schema error', async () => {
    // The store rejects a workspace-scoped profile with no workspacePath, and
    // that rejection is not something the model can act on.
    await run('teammate_create', { name: 'Scout' })
    const result = await run('teammate_update', { id: 'scout', scope: 'workspace' })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')?.scope).toBe('workspace')
    expect(getAgentProfile('scout')?.workspacePath).toBe(workspace)
  })

  it('clears the workspace binding when widening back to global', async () => {
    await run('teammate_create', { name: 'Scout', scope: 'workspace' })
    expect(getAgentProfile('scout')?.workspacePath).toBe(workspace)

    const result = await run('teammate_update', { id: 'scout', scope: 'global' })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')?.scope).toBe('global')
    expect(getAgentProfile('scout')?.workspacePath).toBeUndefined()
  })

  it('refuses an empty patch rather than reporting a no-op as success', async () => {
    await run('teammate_create', { name: 'Scout' })
    const result = await run('teammate_update', { id: 'scout' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('at least one field')
  })
})

describe('teammate_assign_task', () => {
  it('enqueues work the scheduler can see', async () => {
    await run('teammate_create', { name: 'Scout' })

    const result = await run('teammate_assign_task', {
      id: 'scout',
      prompt: 'Audit the pricing pages.'
    })

    expect(result.ok).toBe(true)
    const tasks = listTasks()
    expect(tasks).toHaveLength(1)
    expect(tasks[0]!.profileId).toBe('scout')
    expect(tasks[0]!.prompt).toBe('Audit the pricing pages.')
  })

  it('schedules for later when given a future time', async () => {
    await run('teammate_create', { name: 'Scout' })
    const when = new Date(Date.now() + 3_600_000).toISOString()

    const result = await run('teammate_assign_task', {
      id: 'scout',
      prompt: 'Nightly sweep.',
      scheduled_at: when
    })

    expect(result.ok).toBe(true)
    expect(listTasks()[0]!.status).toBe('scheduled')
    expect(listTasks()[0]!.scheduledAt).toBe(when)
  })

  it('rejects an unparseable schedule instead of silently running now', async () => {
    await run('teammate_create', { name: 'Scout' })
    const result = await run('teammate_assign_task', {
      id: 'scout',
      prompt: 'x',
      scheduled_at: 'next tuesday'
    })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('not a parseable datetime')
    expect(listTasks()).toHaveLength(0)
  })

  it('refuses an unknown teammate', async () => {
    const result = await run('teammate_assign_task', { id: 'ghost', prompt: 'x' })
    expect(result.ok).toBe(false)
    expect(listTasks()).toHaveLength(0)
  })

  it('binds work to the session workspace when a worktree remaps the cwd', async () => {
    // A worktree instance's tool cwd is a sparse checkout with no `.vyotiq`,
    // and a worktree path is never in openPaths — binding to it would fail as
    // "Workspace is not open". Task state belongs to the session tree, the
    // same place memory_* binds.
    await run('teammate_create', { name: 'Scout' })
    const worktree = mkdtempSync(join(tmpdir(), 'vyotiq-teammate-wt-'))
    try {
      const result = await executeTool(
        'teammate_assign_task',
        JSON.stringify({
          id: 'scout',
          prompt: 'from a worktree',
          scheduled_at: new Date(Date.now() + 3_600_000).toISOString()
        }),
        worktree,
        new AbortController().signal,
        { sessionWorkspace: workspace }
      )

      expect(result.ok).toBe(true)
      expect(listTasks()[0]!.workspacePath).toBe(workspace)
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})

describe('teammate_task', () => {
  it('reads back what the teammate produced, which is how delegated work returns', async () => {
    // Before this the agent could hand over work and never learn anything
    // about it — teammate_list filtered every terminal task out.
    seedRunTranscript(workspace, 'run-scout-1', {
      status: 'done',
      assistant: 'Rewrote the pricing copy and fixed two broken links.'
    })
    seedFinishedTask(workspace, {
      id: 'task-done-1',
      profileId: 'scout',
      status: 'done',
      finishedAt: '2026-09-20T10:00:00.000Z',
      runId: 'run-scout-1'
    })
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Later.' })

    const result = await run('teammate_task', { action: 'result', task_id: 'task-done-1' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('status: done')
    expect(result.content).toContain('teammate: Scout')
    expect(result.content).toContain('Rewrote the pricing copy and fixed two broken links.')
  })

  it('reports a failure with its reason rather than an empty result', async () => {
    seedRunTranscript(workspace, 'run-scout-2', {
      status: 'error',
      error: 'Provider refused the request'
    })
    seedFinishedTask(workspace, {
      id: 'task-failed-1',
      profileId: 'scout',
      status: 'failed',
      finishedAt: '2026-09-20T10:00:00.000Z',
      error: 'Run failed',
      runId: 'run-scout-2'
    })
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Later.' })

    const result = await run('teammate_task', { action: 'result', task_id: 'task-failed-1' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('status: failed')
    expect(result.content).toContain('Provider refused the request')
  })

  it('says a task is still working instead of inventing a result', async () => {
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Long job.' })
    const live = listTasks()[0]!

    const result = await run('teammate_task', { action: 'result', task_id: live.id })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('nothing to read yet')
  })

  it('cancels work the agent handed over', async () => {
    await run('teammate_create', { name: 'Scout' })
    // Scheduled rather than immediate: an immediate task races the pump, and
    // whether cancel stops a queued row or unwinds a live run is exactly the
    // difference this assertion would flip on.
    await run('teammate_assign_task', {
      id: 'scout',
      prompt: 'Long job.',
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString()
    })
    const live = listTasks()[0]!
    expect(live.status).toBe('scheduled')

    const result = await run('teammate_task', { action: 'cancel', task_id: live.id })

    expect(result.ok).toBe(true)
    expect(listTasks().find((t) => t.id === live.id)?.status).toBe('cancelled')
  })

  it('refuses to cancel finished work instead of reporting a no-op as success', async () => {
    seedFinishedTask(workspace, {
      id: 'task-done-2',
      profileId: 'scout',
      status: 'done',
      finishedAt: '2026-09-20T10:00:00.000Z'
    })
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Later.' })

    const result = await run('teammate_task', { action: 'cancel', task_id: 'task-done-2' })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('nothing to stop')
  })

  it('retries as a NEW task and leaves the failed attempt in history', async () => {
    seedFinishedTask(workspace, {
      id: 'task-failed-2',
      profileId: 'scout',
      status: 'failed',
      finishedAt: '2026-09-20T10:00:00.000Z',
      error: 'Interrupted by app restart'
    })
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Unrelated.' })

    const result = await run('teammate_task', { action: 'retry', task_id: 'task-failed-2' })

    expect(result.ok).toBe(true)
    const clone = listTasks().find((t) => t.retryOf === 'task-failed-2')
    expect(clone).toBeTruthy()
    // The audited original must survive its own retry.
    expect(listTasks().find((t) => t.id === 'task-failed-2')?.status).toBe('failed')
  })

  it('refuses to retry work that is still running', async () => {
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_assign_task', { id: 'scout', prompt: 'Long job.' })
    const live = listTasks()[0]!

    const result = await run('teammate_task', { action: 'retry', task_id: live.id })

    expect(result.ok).toBe(false)
    expect(result.content).toContain('Only a finished task can be retried')
  })

  it("withholds a transcript from another project, but still reports how it ended", async () => {
    const other = mkdtempSync(join(tmpdir(), 'vyotiq-teammate-other-run-'))
    seedRunTranscript(other, 'run-elsewhere', {
      status: 'done',
      assistant: 'Secrets from an unrelated repository.'
    })
    seedFinishedTask(other, {
      id: 'task-elsewhere-1',
      profileId: 'scout',
      status: 'done',
      finishedAt: '2026-09-20T10:00:00.000Z',
      runId: 'run-elsewhere'
    })
    await run('teammate_create', { name: 'Scout' })
    await resumeTasksForWorkspaces([other])

    const result = await run('teammate_task', { action: 'result', task_id: 'task-elsewhere-1' })

    expect(result.ok).toBe(true)
    expect(result.content).toContain('status: done')
    expect(result.content).not.toContain('Secrets from an unrelated repository.')
    expect(result.content).toContain('not the project open here')
    rmSync(other, { recursive: true, force: true })
  })

  it('refuses an unknown task and points at where ids come from', async () => {
    const result = await run('teammate_task', { action: 'result', task_id: 'task-nope' })
    expect(result.ok).toBe(false)
    expect(result.content).toContain('teammate_list')
  })
})

describe('teammate_delete', () => {
  it('removes the teammate and stops its outstanding work', async () => {
    await run('teammate_create', { name: 'Scout' })
    // Scheduled, not immediate: an unscheduled task starts a real run the
    // moment it is enqueued, and this is a test about the delete cascade
    // rather than about launching.
    await run('teammate_assign_task', {
      id: 'scout',
      prompt: 'nightly sweep',
      scheduled_at: new Date(Date.now() + 3_600_000).toISOString()
    })
    expect(listTasks()).toHaveLength(1)

    const result = await run('teammate_delete', { id: 'scout' })

    expect(result.ok).toBe(true)
    expect(getAgentProfile('scout')).toBeNull()
    // Cancelled with its teammate, rather than left pointing at a profile that
    // no longer resolves and failing later as "profile no longer exists".
    expect(listTasks()[0]!.status).toBe('cancelled')
    expect(listTasks()[0]!.error).toBe('Teammate deleted')
    expect(result.content).toContain('retired')
  })

  it('retires the id so a later teammate cannot inherit its memory', async () => {
    await run('teammate_create', { name: 'Scout' })
    await run('teammate_delete', { id: 'scout' })

    await run('teammate_create', { name: 'Scout' })
    expect(getAgentProfile('scout')).toBeNull()
    expect(getAgentProfile('scout-2')).not.toBeNull()
  })

  it('refuses an unknown id', async () => {
    const result = await run('teammate_delete', { id: 'ghost' })
    expect(result.ok).toBe(false)
  })
})
