import type { AgentToolName } from '../schemas/tools'
import { AWAIT_AGENT_INSTANCE_MAX_MS } from '../schemas/tools'
import {
  spawnAgentInstance,
  waitForChildTerminal,
  cancelChildInstance,
  formatAgentInstanceLabel,
  mergeAgentInstanceBranch,
  pullChildRun,
  type PullAgentInstanceView
} from '../agentInstances'
import { loadStatus } from '../state'
import { canonicalTodoId } from '../../../shared/utils/todoContent'
import { readTodos } from './todo'
import { resolveRunDir } from '@main/storage/paths'
import { recordMergedInstanceChanges } from './mergeCheckpoint'
import { readString } from './argAccess'
import { ASK_SAFE_BUILTIN } from './modePolicy'
import {
  findAgentType,
  loadAgentTypes,
  resolveAgentType,
  unknownAgentTypeError,
  type ResolvedAgentType
} from '../agentTypes'
import { invalidateAfterWorkspaceMutation, throwIfAborted, toolOk, toolFail } from './index'
import type { ToolHandler } from './index'

export const instanceHandlers = {
  spawn_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('spawn_agent_instance', 'spawn', 'spawn_agent_instance requires an active run')
    }
    const goal = readString(args, 'goal')
    if (!goal) return toolFail('spawn_agent_instance', 'spawn', 'goal is required')
    const outcome = readString(args, 'outcome')
    if (!outcome) return toolFail('spawn_agent_instance', 'spawn', 'outcome is required')
    const doneWhen = readString(args, 'done_when')
    if (!doneWhen) return toolFail('spawn_agent_instance', 'spawn', 'done_when is required')
    const subTasks = Array.isArray(args.sub_tasks)
      ? args.sub_tasks.filter((t): t is string => typeof t === 'string')
      : []
    if (subTasks.length === 0) {
      return toolFail(
        'spawn_agent_instance',
        'spawn',
        'sub_tasks must be a non-empty array of strings'
      )
    }
    // A user-defined helper type (.vyotiq/agent-types, .claude/agents, user's).
    const agentTypeName = readString(args, 'agent_type')
    let agentType: ResolvedAgentType | undefined
    let typeOnlyReads = false
    if (agentTypeName) {
      const catalog = loadAgentTypes(context.sessionWorkspace ?? workspace)
      const def = findAgentType(catalog, agentTypeName)
      if (!def) return toolFail('spawn_agent_instance', 'spawn', unknownAgentTypeError(catalog, agentTypeName))
      agentType = resolveAgentType(def)
      // A type whose every declared tool only reads needs no worktree: it runs
      // as a read-and-report child, the same as read_only: true.
      typeOnlyReads = def.tools != null && def.tools.every((t) => ASK_SAFE_BUILTIN.has(t))
    }
    const result = await spawnAgentInstance({
      parentRunId: context.runId,
      workspacePath: workspace,
      goal,
      outcome,
      subTasks,
      doneWhen,
      pathScope: Array.isArray(args.path_scope)
        ? args.path_scope.filter((p): p is string => typeof p === 'string')
        : undefined,
      isolation: args.isolation === 'shared' ? 'shared' : undefined,
      stepId: readString(args, 'step_id') || undefined,
      readOnly: args.read_only === true || typeOnlyReads,
      ...(agentType ? { agentType } : {}),
      emitParentEvent: context.emitAgentEvent
    })
    if (!result.ok) return toolFail('spawn_agent_instance', 'spawn', result.error)
    const branchLine = result.worktreeBranch
      ? `\nworktree_branch: ${result.worktreeBranch}\nWhen done, merge one branch at a time with merge_agent_instance (refused only if your uncommitted or untracked changes overlap the branch's changed files).`
      : ''
    const notes: string[] = []
    if (result.modelNote) notes.push(`agent_type "${agentType?.name}": ${result.modelNote}`)
    if (result.sharedBecause) {
      notes.push(
        `No worktree (${result.sharedBecause}): the child runs in this workspace inside path_scope, where terminal is refused. For a child that only reads, pass read_only: true.`
      )
    }
    // A step_id the list does not hold files the child nowhere: run 528a737f
    // passed s1/s2 to a plan published without todos.
    const stepId = readString(args, 'step_id')
    if (stepId && context.runDir) {
      const ids = readTodos(context.runDir).map((todo) => todo.id)
      if (!ids.includes(canonicalTodoId(stepId))) {
        notes.push(
          `step_id "${stepId}" names no todo in this run's list (${ids.length > 0 ? ids.join(', ') : 'the list is empty'}), so the task record cannot show this child under a step. Publish the steps as todos (create_plan todos, or todo_write) and spawn with their ids.`
        )
      }
    }
    return toolOk(
      'spawn_agent_instance',
      result.label,
      `${result.label}\nrun_id: ${result.runId}${agentType ? `\nagent_type: ${agentType.name}` : ''}${branchLine}${notes.map((note) => `\n\nNote: ${note}`).join('')}`
    )
  },
  await_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('await_agent_instance', 'await', 'await_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('await_agent_instance', 'await', 'run_id is required')
    const childDir = resolveRunDir(workspace, childRunId)
    const childStatus = loadStatus(childDir)
    if (!childStatus?.inlineInstance || childStatus.parentRunId !== context.runId) {
      return toolFail(
        'await_agent_instance',
        formatAgentInstanceLabel(childRunId),
        'run_id is not an inline instance spawned by this parent run'
      )
    }
    // This is the only bound on the wait (await_agent_instance is exempt from the
    // generic tool soft deadline), so clamp both ends: an unbounded timeout_ms
    // would park the run indefinitely on a wedged child.
    const timeoutMs =
      typeof args.timeout_ms === 'number' && Number.isFinite(args.timeout_ms)
        ? Math.min(AWAIT_AGENT_INSTANCE_MAX_MS, Math.max(1_000, Math.floor(args.timeout_ms)))
        : AWAIT_AGENT_INSTANCE_MAX_MS
    try {
      const terminal = await waitForChildTerminal(childRunId, workspace, timeoutMs, signal)
      const label = formatAgentInstanceLabel(childRunId)
      const branch = loadStatus(childDir)?.worktreeBranch
      const branchLine = branch ? `\nworktree_branch: ${branch}` : ''
      const content = `${label}\nphase: ${terminal.phase}${branchLine}\n\n${terminal.summary}`
      // A child that ended in error/cancelled is not a successful await: returning
      // ok:true here rendered the "Instance finished" chip over a failed child
      // (screenshot audit 2026-09-08: instance cards "Failed <id>" beside await
      // chips "Instance finished <id>" for the same run). ok:false routes the chip
      // and step failure accounting to the failed state while the content still
      // carries the terminal phase and the child's summary.
      if (terminal.phase !== 'done') {
        return toolFail('await_agent_instance', label, content)
      }
      return toolOk('await_agent_instance', label, content)
    } catch (err) {
      throwIfAborted(signal)
      const msg = err instanceof Error ? err.message : String(err)
      return toolFail('await_agent_instance', formatAgentInstanceLabel(childRunId), msg)
    }
  },
  pull_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('pull_agent_instance', 'pull', 'pull_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('pull_agent_instance', 'pull', 'run_id is required')
    const childDir = resolveRunDir(workspace, childRunId)
    const childStatus = loadStatus(childDir)
    if (!childStatus?.inlineInstance || childStatus.parentRunId !== context.runId) {
      return toolFail(
        'pull_agent_instance',
        formatAgentInstanceLabel(childRunId),
        'run_id is not an inline instance spawned by this parent run'
      )
    }
    const viewRaw = readString(args, 'view')
    const view: PullAgentInstanceView =
      viewRaw === 'outline' || viewRaw === 'tail' ? viewRaw : 'summary'
    const content = await pullChildRun(workspace, childRunId, view)
    return toolOk('pull_agent_instance', formatAgentInstanceLabel(childRunId), content)
  },
  merge_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('merge_agent_instance', 'merge', 'merge_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('merge_agent_instance', 'merge', 'run_id is required')
    const result = await mergeAgentInstanceBranch(workspace, context.runId, childRunId)
    if (!result.ok) {
      return toolFail('merge_agent_instance', formatAgentInstanceLabel(childRunId), result.error)
    }
    // The merge touched the parent workspace outside any edit tool — record its
    // file changes onto this turn's checkpoint so chatRewind can revert them.
    await recordMergedInstanceChanges(workspace, context, result)
    invalidateAfterWorkspaceMutation(workspace)
    return toolOk('merge_agent_instance', formatAgentInstanceLabel(childRunId), result.detail)
  },
  cancel_agent_instance: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    if (!context.runId) {
      return toolFail('cancel_agent_instance', 'cancel', 'cancel_agent_instance requires an active run')
    }
    const childRunId = readString(args, 'run_id')
    if (!childRunId) return toolFail('cancel_agent_instance', 'cancel', 'run_id is required')
    const result = cancelChildInstance(workspace, context.runId, childRunId)
    const label = formatAgentInstanceLabel(childRunId)
    if (!result.ok) return toolFail('cancel_agent_instance', label, result.error)
    if (result.phase === 'already-terminal') {
      const status = loadStatus(resolveRunDir(workspace, childRunId))?.status ?? 'unknown'
      return toolOk('cancel_agent_instance', label, `${label}\nphase: already-terminal (${status})`)
    }
    return toolOk(
      'cancel_agent_instance',
      label,
      `${label}\nphase: cancelling\n\nInstance cancelled. Its partial output is available via pull_agent_instance.`
    )
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
