import {
  isTerminalDelegatedTaskStatus,
  ProviderIdSchema,
  type AgentProfile,
  type AgentProfileCreateRequest,
  type DelegatedTask
} from '../../../shared/ipc'
import { workspacePathsEqual } from '../../../shared/workspacePath'
import {
  createAgentProfile,
  emitAgentProfilesChanged,
  getAgentProfile,
  listAgentProfiles,
  mutateAgentProfiles,
  resolveAgentProfile,
  updateAgentProfile
} from '../../settings/agentProfiles'
import { summarizeChildRunAsync } from '../agentInstances'
import { writeMemoryFile } from '../context/memory'
import { deleteTeammateCascade } from '../teammateAdmin'
import { cancelTask, enqueueTask, listTasks, retryTask } from '../taskScheduler'
import { readString } from './argAccess'
import { throwIfAborted, toolFail, toolOk } from './index'
import type { ToolExecutionContext, ToolHandler } from './index'

/**
 * Teammate management from inside a run.
 *
 * Instances are the *hands* and teammates are the *who*: `spawn_agent_instance`
 * gets a second pair of hands for the next twenty minutes, while a teammate
 * outlives every conversation, keeps a private memory namespace per project and
 * accepts work while nobody is watching. Until now the agent could create the
 * former and not the latter, so "remember this for next time" had no home it
 * could reach.
 *
 * These call the same store functions the IPC handlers do and emit the same
 * change events, so a teammate the agent creates is indistinguishable from one
 * made in the pane — it appears in the roster immediately, with no reload.
 *
 * **Full control by design.** Every profile field is writable here, including
 * `autonomous_mode`. A teammate created with `on` skips approval prompts, which
 * means a run can widen the autonomy of identities it creates. That is the
 * product decision, not an oversight. The limit that still holds is
 * `isAutonomousHighRiskTool`: edit, terminal, delete, git_commit, the GitHub
 * tools and every MCP call stay approval-gated for *every* teammate whatever
 * this is set to.
 */

/**
 * The workspace teammate state belongs to.
 *
 * A worktree instance has its tool cwd remapped into a sparse checkout that has
 * no `.vyotiq`, so the roster scope check and `tasks.json` must bind to the
 * session (parent) tree — the same reason `memory_*` does. Without this an
 * instance's `teammate_assign_task` fails as "Workspace is not open", because a
 * worktree path is never in `openPaths`.
 */
function sessionWorkspaceOf(workspace: string, context: ToolExecutionContext): string {
  return context.sessionWorkspace ?? workspace
}

/** One roster line, dense enough to act on without a second call. */
function describeProfile(profile: AgentProfile, tasks: string): string {
  const bits = [
    `id: ${profile.id}`,
    `name: ${profile.name}`,
    profile.scope === 'workspace'
      ? `scope: workspace (${profile.workspacePath ?? 'unset'})`
      : 'scope: global',
    profile.model ? `model: ${profile.model.provider}/${profile.model.model}` : null,
    profile.autonomousMode && profile.autonomousMode !== 'inherit'
      ? `approvals: ${profile.autonomousMode === 'on' ? 'never asks' : 'always asks'}`
      : null,
    profile.autoResumeOnLaunch ? 'auto-resumes at launch' : null,
    profile.persona ? `persona: ${profile.persona}` : null,
    profile.identity ? `identity: ${profile.identity}` : null,
    profile.tone ? `tone: ${profile.tone}` : null
  ].filter(Boolean)
  return `- ${bits.join('\n  ')}${tasks ? `\n  ${tasks}` : ''}`
}

/**
 * Read the optional model pin. Both halves or neither — a provider with no
 * model id fails `AgentProfileModelSchema` at the boundary, and a bare model
 * with no provider has nowhere to run.
 */
function readModelPin(
  args: Record<string, unknown>
): AgentProfile['model'] | undefined | Error {
  const provider = readString(args, 'model_provider')
  const model = readString(args, 'model_id')
  if (!provider && !model) return undefined
  if (!provider || !model) {
    return new Error('model_provider and model_id must be given together, or neither')
  }
  // Validated against the schema rather than a copied list, so a provider added
  // later is accepted here without anyone remembering to update this file.
  const parsed = ProviderIdSchema.safeParse(provider)
  if (!parsed.success) {
    return new Error(
      `Unknown provider "${provider}". One of: ${ProviderIdSchema.options.join(', ')}`
    )
  }
  return { provider: parsed.data, model }
}

/** Shared field reader for create and update. */
function readIdentityFields(args: Record<string, unknown>): Partial<AgentProfile> | Error {
  const patch: Partial<AgentProfile> = {}
  const pin = readModelPin(args)
  if (pin instanceof Error) return pin
  if (pin !== undefined) patch.model = pin

  for (const key of ['persona', 'identity', 'tone', 'avatar'] as const) {
    const value = readString(args, key)
    if (value !== undefined) patch[key] = value
  }
  const autonomous = readString(args, 'autonomous_mode')
  if (autonomous !== undefined) {
    if (autonomous !== 'inherit' && autonomous !== 'on' && autonomous !== 'off') {
      return new Error('autonomous_mode must be inherit, on, or off')
    }
    patch.autonomousMode = autonomous
  }
  if (typeof args.auto_resume_on_launch === 'boolean') {
    patch.autoResumeOnLaunch = args.auto_resume_on_launch
  }
  // `runtime` is not read here on purpose — see the note on
  // `teammateIdentityFields`. No cloud runtime is registered, so the only
  // reachable effect of accepting it would be a teammate that refuses every run.
  return patch
}

/** Terminal tasks reported per teammate — the last attempt plus what preceded it. */
const RECENT_TERMINAL_TASKS = 3
/** Longest error fragment echoed into a roster line. */
const TASK_ERROR_PREVIEW_CHARS = 160

function previewError(error: string): string {
  const flat = error.replace(/\s+/g, ' ').trim()
  return flat.length > TASK_ERROR_PREVIEW_CHARS
    ? `${flat.slice(0, TASK_ERROR_PREVIEW_CHARS - 1)}…`
    : flat
}

/**
 * `listTasks()` flattens every workspace this process has loaded, so a task
 * belonging to another project would otherwise read as work in this one. Name
 * the project instead of hiding the row: the teammate really is busy there,
 * and that is why a new assignment here queues behind it.
 */
function taskWorkspaceNote(task: DelegatedTask, sessionWorkspace: string): string {
  if (sessionWorkspace && workspacePathsEqual(task.workspacePath, sessionWorkspace)) return ''
  return ` in ${task.workspacePath}`
}

/**
 * One teammate's work, as up to two lines: what is live, and what recently
 * finished.
 *
 * The finished line exists because filtering terminal tasks out left a run that
 * delegated work with no way to learn it had ended — while
 * `teammate_assign_task` told it to look exactly here. This says there is an
 * outcome and names the id; `teammate_task` reads what the teammate produced.
 */
function taskLines(profileId: string, sessionWorkspace: string): string {
  const own = listTasks().filter((t) => t.profileId === profileId)
  const active = own.filter((t) => !isTerminalDelegatedTaskStatus(t.status))
  const finished = own
    .filter((t) => isTerminalDelegatedTaskStatus(t.status))
    .sort((a, b) => (b.finishedAt ?? b.createdAt).localeCompare(a.finishedAt ?? a.createdAt))
    .slice(0, RECENT_TERMINAL_TASKS)

  const lines: string[] = []
  if (active.length > 0) {
    lines.push(
      `work: ${active
        .map((t) => `${t.status} ${t.id}${taskWorkspaceNote(t, sessionWorkspace)}`)
        .join(', ')}`
    )
  }
  if (finished.length > 0) {
    lines.push(
      `finished: ${finished
        .map((t) => {
          const why = t.error ? ` — ${previewError(t.error)}` : ''
          return `${t.status} ${t.id}${taskWorkspaceNote(t, sessionWorkspace)}${why}`
        })
        .join('; ')}`
    )
  }
  return lines.join('\n  ')
}

/**
 * Write a new teammate's starting `index.md`.
 *
 * A teammate created with only a persona knows nothing on its first run, and
 * the agent has no other way to give it any: `memory_write` always targets the
 * *calling* run's namespace, and `assertMemoryNamespaceAccess` refuses to reach
 * into another teammate's. This is create-time seeding of a namespace that did
 * not exist a moment ago, so it grants no ability to read or rewrite an
 * existing teammate's memory.
 *
 * Failure is reported, never thrown: the teammate itself was created
 * successfully, and losing that to a seeding error would be the worse outcome.
 */
function seedMemory(profileId: string, memory: string | undefined, workspace: string): string {
  const contents = memory?.trim()
  if (!contents) return ''
  if (!workspace) {
    return `\n\nNo project is open, so its memory was not seeded — memory is per project.`
  }
  try {
    writeMemoryFile(workspace, 'index.md', `${contents}\n`, profileId)
    return `\n\nSeeded its index.md, so it already knows that on its first run here.`
  } catch (err) {
    return `\n\nCould not seed its memory: ${err instanceof Error ? err.message : String(err)}`
  }
}

/** What a task was, how it ended, and what replaced it. */
function taskHeader(task: DelegatedTask, who: string): string {
  return [
    `task: ${task.id}`,
    `teammate: ${who}`,
    `status: ${task.status}`,
    task.error ? `error: ${task.error}` : null,
    task.startedAt ? `started: ${task.startedAt}` : null,
    task.finishedAt ? `finished: ${task.finishedAt}` : null,
    task.retryOf ? `retry of: ${task.retryOf}` : null
  ]
    .filter(Boolean)
    .join('\n')
}

export const teammateHandlers = {
  teammate_list: (async (workspace, args, _signal, context) => {
    const profiles = listAgentProfiles()
    if (profiles.length === 0) {
      return toolOk(
        'teammate_list',
        'no teammates',
        'No teammates exist yet. teammate_create makes one; it persists across every conversation and keeps its own memory in this project.'
      )
    }
    // Scope refusals are invisible from the roster alone, and every other
    // teammate_* call in this workspace will hit them.
    const scopeRoot = sessionWorkspaceOf(workspace, context)
    const withTasks = args.include_tasks !== false
    const lines = profiles.map((p) => describeProfile(p, withTasks ? taskLines(p.id, scopeRoot) : ''))
    const unusable = profiles.filter((p) => !resolveAgentProfile(scopeRoot, p.id))
    const note = unusable.length
      ? `\n\nNot usable in this project (workspace-scoped elsewhere): ${unusable.map((p) => p.id).join(', ')}`
      : ''
    return toolOk(
      'teammate_list',
      `${profiles.length} teammate${profiles.length === 1 ? '' : 's'}`,
      `${lines.join('\n')}${note}`
    )
  }) satisfies ToolHandler,

  teammate_create: (async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const name = readString(args, 'name')
    if (!name) return toolFail('teammate_create', 'create', 'name is required')
    const fields = readIdentityFields(args)
    if (fields instanceof Error) return toolFail('teammate_create', name, fields.message)

    const scopeRoot = sessionWorkspaceOf(workspace, context)
    const scope = readString(args, 'scope') === 'workspace' ? 'workspace' : 'global'
    if (scope === 'workspace' && !scopeRoot) {
      return toolFail('teammate_create', name, 'A workspace-scoped teammate needs an open workspace')
    }
    const request: AgentProfileCreateRequest = {
      ...fields,
      name,
      scope,
      ...(scope === 'workspace' ? { workspacePath: scopeRoot } : {})
    } as AgentProfileCreateRequest

    const created = await mutateAgentProfiles(() => createAgentProfile(request))
    // Same push the pane's create fires, so the roster updates live rather
    // than on the next reload.
    emitAgentProfilesChanged()
    const memoryNote = seedMemory(created.id, readString(args, 'memory'), scopeRoot)
    return toolOk(
      'teammate_create',
      `created ${created.name}`,
      `Created teammate "${created.name}".\nid: ${created.id}\n\n${describeProfile(created, '')}\n\nIts memory lives at .vyotiq/agents/${created.id}/memory/ in each project and is private to it. Assign work with teammate_assign_task.${memoryNote}`
    )
  }) satisfies ToolHandler,

  teammate_update: (async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const id = readString(args, 'id')
    if (!id) return toolFail('teammate_update', 'update', 'id is required')
    const existing = getAgentProfile(id)
    if (!existing) {
      return toolFail('teammate_update', id, `Unknown teammate "${id}". Call teammate_list first.`)
    }
    const fields = readIdentityFields(args)
    if (fields instanceof Error) return toolFail('teammate_update', id, fields.message)

    const patch: Partial<AgentProfile> = { ...fields }
    const name = readString(args, 'name')
    if (name) patch.name = name
    const scope = readString(args, 'scope')
    if (scope === 'global' || scope === 'workspace') {
      patch.scope = scope
      if (scope === 'workspace') {
        // Narrowing needs a project to narrow TO. The store rejects a
        // workspace-scoped profile with no workspacePath, and that rejection
        // would reach the model as a raw schema error it cannot act on.
        const target = existing.workspacePath ?? sessionWorkspaceOf(workspace, context)
        if (!target) {
          return toolFail(
            'teammate_update',
            id,
            'Narrowing scope to one workspace needs an open workspace'
          )
        }
        patch.workspacePath = target
      } else {
        // Widening back to global drops the binding; spreading `undefined`
        // clears it and JSON omits the key on write.
        patch.workspacePath = undefined
      }
    }
    if (Object.keys(patch).length === 0) {
      return toolFail('teammate_update', id, 'Nothing to change — pass at least one field.')
    }

    const updated = await mutateAgentProfiles(() => updateAgentProfile({ id, patch }))
    emitAgentProfilesChanged()
    return toolOk('teammate_update', `updated ${updated.name}`, describeProfile(updated, ''))
  }) satisfies ToolHandler,

  teammate_delete: (async (_workspace, args, signal) => {
    throwIfAborted(signal)
    const id = readString(args, 'id')
    if (!id) return toolFail('teammate_delete', 'delete', 'id is required')
    const existing = getAgentProfile(id)
    if (!existing) {
      return toolFail('teammate_delete', id, `Unknown teammate "${id}". Call teammate_list first.`)
    }
    const result = await deleteTeammateCascade(id)
    const stopped = [
      result.cancelledTasks ? `${result.cancelledTasks} task(s)` : null,
      result.cancelledRuns ? `${result.cancelledRuns} run(s)` : null
    ].filter(Boolean)
    // Warnings matter: a delete can half-succeed (a locked override file, a run
    // that refused to stop) while the roster row disappears regardless.
    const warnings = result.warnings.length ? `\nIncomplete cleanup:\n- ${result.warnings.join('\n- ')}` : ''
    return toolOk(
      'teammate_delete',
      `deleted ${existing.name}`,
      `Deleted "${existing.name}" (${id}).${stopped.length ? ` Stopped ${stopped.join(' and ')}.` : ''} Its run history and memory are kept; the id is retired and can never be reused.${warnings}`
    )
  }) satisfies ToolHandler,

  teammate_assign_task: (async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const id = readString(args, 'id')
    if (!id) return toolFail('teammate_assign_task', 'assign', 'id is required')
    const prompt = readString(args, 'prompt')
    if (!prompt) return toolFail('teammate_assign_task', id, 'prompt is required')
    const profile = getAgentProfile(id)
    if (!profile) {
      return toolFail('teammate_assign_task', id, `Unknown teammate "${id}". Call teammate_list first.`)
    }
    const scheduledAt = readString(args, 'scheduled_at')
    if (scheduledAt && Number.isNaN(Date.parse(scheduledAt))) {
      return toolFail('teammate_assign_task', id, `scheduled_at is not a parseable datetime: ${scheduledAt}`)
    }
    try {
      const task = enqueueTask({
        profileId: id,
        workspacePath: sessionWorkspaceOf(workspace, context),
        prompt,
        ...(scheduledAt ? { scheduledAt } : {})
      })
      const when =
        task.status === 'scheduled'
          ? `scheduled for ${task.scheduledAt}`
          : task.status === 'running'
            ? 'started now'
            : 'queued behind its current work'
      return toolOk(
        'teammate_assign_task',
        `assigned to ${profile.name}`,
        `Assigned to "${profile.name}" — ${when}.\ntask: ${task.id}\nstatus: ${task.status}\n\nIt runs in its own session and does not stream back here. Read what it produced with teammate_task once it finishes.`
      )
    } catch (err) {
      // enqueueTask refuses a closed workspace and an unresolvable profile —
      // both are states the model can correct, so say which.
      return toolFail('teammate_assign_task', id, err instanceof Error ? err.message : String(err))
    }
  }) satisfies ToolHandler,

  teammate_task: (async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const taskId = readString(args, 'task_id')
    if (!taskId) return toolFail('teammate_task', 'task', 'task_id is required')
    const action = readString(args, 'action')
    if (action !== 'result' && action !== 'cancel' && action !== 'retry') {
      return toolFail('teammate_task', taskId, 'action must be result, cancel, or retry')
    }
    const task = listTasks().find((t) => t.id === taskId)
    if (!task) {
      return toolFail(
        'teammate_task',
        taskId,
        `Unknown task "${taskId}". teammate_list names each teammate's work, live and recently finished.`
      )
    }
    const who = getAgentProfile(task.profileId)?.name ?? task.profileId
    const label = `${who}: ${task.status}`

    if (action === 'result') {
      if (!isTerminalDelegatedTaskStatus(task.status)) {
        return toolOk(
          'teammate_task',
          label,
          `${taskHeader(task, who)}\n\nStill ${task.status}, so there is nothing to read yet. It runs on its own — come back to it, or cancel it.`
        )
      }
      if (!task.runId) {
        return toolOk(
          'teammate_task',
          label,
          `${taskHeader(task, who)}\n\nThis task never started a run, so it left no transcript.`
        )
      }
      // Transcripts stay inside the project this run is working in. A teammate
      // is global and its work is not, so without this a run could read back
      // whatever that teammate did in an unrelated repository. The record's own
      // status and error still come back — only the contents are withheld.
      const sessionRoot = sessionWorkspaceOf(workspace, context)
      if (!sessionRoot || !workspacePathsEqual(task.workspacePath, sessionRoot)) {
        return toolOk(
          'teammate_task',
          label,
          `${taskHeader(task, who)}\n\nThis task ran in ${task.workspacePath}, not the project open here, so its transcript is not readable from this run.`
        )
      }
      // The same summary an instance pull returns — the run's last assistant
      // message plus the files it wrote — read from the teammate's own workspace.
      const produced = await summarizeChildRunAsync(task.workspacePath, task.runId, 'Task')
      return toolOk('teammate_task', label, `${taskHeader(task, who)}\n\n${produced}`)
    }

    if (action === 'cancel') {
      if (isTerminalDelegatedTaskStatus(task.status)) {
        return toolFail(
          'teammate_task',
          taskId,
          `Task ${task.id} already ${task.status} — there is nothing to stop. Use action "retry" to run it again.`
        )
      }
      // cancelTask honours the run registry's refusal, so a false here means the
      // work really did not stop. Reporting it as success would leave the model
      // acting on a teammate it believes is free.
      if (!cancelTask(task.id)) {
        return toolFail(
          'teammate_task',
          taskId,
          `Could not stop task ${task.id}: it had already finished, or a cancel was already in flight.`
        )
      }
      return toolOk(
        'teammate_task',
        `stopping ${who}'s task`,
        `Stopping task ${task.id}. A running one unwinds first and settles as cancelled; ${who} is free once it does.`
      )
    }

    if (!isTerminalDelegatedTaskStatus(task.status)) {
      return toolFail(
        'teammate_task',
        taskId,
        `Only a finished task can be retried; ${task.id} is ${task.status}. Cancel it first if it is stuck.`
      )
    }
    try {
      // A new record, never a mutation of the audited original.
      const next = retryTask(task.id)
      return toolOk(
        'teammate_task',
        `retrying for ${who}`,
        `Queued a new task from ${task.id}.\ntask: ${next.id}\nstatus: ${next.status}\n\nThe original stays in history as ${task.status}. Read the new one with teammate_task.`
      )
    } catch (err) {
      return toolFail('teammate_task', taskId, err instanceof Error ? err.message : String(err))
    }
  }) satisfies ToolHandler
}
