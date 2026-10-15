import type { UiAgentQuestion, UiAttachment, UiItem, UiToolApproval } from '@shared/transcript'
import {
  duplicatesReasoning,
  isSerializedPayloadText,
  stripToolShapedAssistantText,
  stripToolShapedAssistantTextForStream
} from '@shared/transcript'
import { parseMcpToolInvocation, parseSkillInvocation } from '@shared/slashCommands'
import { parseArgsRecord } from '@shared/toolSummary'
import {
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs,
  type AgentInstanceUiState
} from '@shared/utils/agentInstance'
import { canonicalTodoId } from '@shared/utils/todoContent'
import type { TaskState } from '@renderer/lib/ui'
import { isInterruptedToolContent, isProminentPresentation } from '@renderer/features/chat/toolUi'
import { parseTodoData, type TodoItem } from '@renderer/features/chat/toolUi/parsers/todo'
import { editStatOf, sumEditStats, type EditStat } from './editStat'

/**
 * The task record, built from the same items the transcript was: one entry per
 * run (the brief, then each follow-up), each run's work grouped under the plan
 * step it served, and the closing answer as the result.
 *
 * Nothing here is inferred beyond what the items say:
 * - a step is a todo; its state is the todo's status in the latest snapshot
 *   the run wrote (a `todo_write` result, or `create_plan`'s own todos);
 * - a tool belongs to the step that was `in_progress` when it started, i.e.
 *   the latest snapshot before it — by start time where the loop ran a
 *   `todo_write` ahead of calls the model listed before it;
 * - work done while no step was in progress stays between the steps, after
 *   the one that last was — unless the next snapshot marks exactly one step
 *   done that was never marked started, which is then the step it served;
 * - a child instance belongs to the step it was spawned for (`step_id`, or
 *   main's reading of it on the child's start when the args preview is cut),
 *   and its awaits, pulls and merges follow it there. A spawn naming no step,
 *   made while the model had set several steps in progress together, takes
 *   the next of those steps that has no child yet — `create_plan` tells the
 *   model each such step is one child. Children spawned before the run listed
 *   any step are filed by the same rules once its first list arrives;
 * - a step running a child is running while the child is, and its time is
 *   the child's and its own calls', not when the model got round to ticking it;
 * - durations come from the `at` stamps the items carry, never estimates.
 *
 * Work is never dropped: a step a later plan replaced keeps its row (marked
 * superseded) for as long as it holds work.
 */

type ToolItem = Extract<UiItem, { kind: 'tool' }>
type MessageItem = Extract<UiItem, { kind: 'message' }>

export type WorkItem =
  /** Consecutive lookups — reads, searches, listings — shown as one line. */
  | { kind: 'explore'; id: string; tools: ToolItem[] }
  /** Any other call that is not a card — a delete, an MCP call, a question: its own line. */
  | { kind: 'tool'; id: string; tool: ToolItem }
  /** A command or an edit: its output is the point, so it gets its own card. */
  | { kind: 'card'; id: string; tool: ToolItem }
  /** Sub-agent instances: spawn, await, pull, merge. */
  | { kind: 'instance'; id: string; tool: ToolItem }
  | { kind: 'plan'; id: string; tool: ToolItem; title: string | null }
  /** A view the agent drew while it worked (show_view): drawn, not listed. */
  | { kind: 'view'; id: string; tool: ToolItem }
  /** What the agent said between steps of work. */
  | { kind: 'note'; id: string; item: MessageItem; text: string }
  | { kind: 'thought'; id: string; item: MessageItem; text: string; streaming: boolean }
  | { kind: 'error'; id: string; message: string; code?: string }
  /** What you said into the run while it worked (Send now): it carried on with it. */
  | { kind: 'said'; id: string; item: MessageItem; text: string }
  | { kind: 'compaction'; id: string; item: Extract<UiItem, { kind: 'compaction' }> }
  /** A one-line note from the run itself: the step moved to a fallback model. */
  | { kind: 'notice'; id: string; item: Extract<UiItem, { kind: 'notice' }> }

export type RecordStep = {
  /** The todo's canonical id when it has one, else its text. */
  key: string
  /** 1-based position in the latest plan; 0 for a step that plan no longer holds. */
  n: number
  title: string
  state: TaskState
  work: WorkItem[]
  /**
   * Work done after this step settled while no other step was in progress —
   * shown after it, never inside it.
   */
  between: WorkItem[]
  /** When it went in progress and when it finished, from the snapshot stamps. */
  startedAt: number | null
  endedAt: number | null
  /** Edits made while this step was in progress; lines only when every one was countable. */
  edits: { files: number; add?: number; del?: number } | null
  /** A later plan dropped or renamed it; it stays because work was done under it. */
  superseded?: true
}

/**
 * `place` is where the gated call would have gone: its card is shown there, in
 * the work, standing in for the call until you answer. `why` is what the agent
 * said right before it — already above the card there, so only a card shown
 * away from its place quotes it.
 */
export type NeedsYou =
  | {
      kind: 'approval'
      approval: UiToolApproval
      tool: ToolItem
      stepKey: string | null
      place: RecordTail
      at: number | null
      why?: string
    }
  | { kind: 'question'; question: UiAgentQuestion; stepKey: string | null; place: RecordTail; at: number | null }

/** Where the run's latest work went: the live activity line belongs there. */
export type RecordTail =
  | { kind: 'setup' }
  | { kind: 'after' }
  | { kind: 'step'; key: string }
  | { kind: 'between'; key: string }

export type RecordRun = {
  n: number
  id: string
  /**
   * The instruction as the user wrote it. Empty for a run with no user turn (a
   * resumed goal), or a slash command sent with nothing after it.
   */
  text: string
  /** The slash command the instruction invoked — a skill, or an MCP tool as server-tool. */
  command?: string
  /** The instruction is a brief Structure wrote: what the person typed before it. */
  structuredFrom?: string
  images: string[]
  attachments: UiAttachment[]
  at: number | null
  /** Work before the first step started: reading around, writing the plan. */
  setup: WorkItem[]
  steps: RecordStep[]
  /** Work after every step settled, or all work when the run made no plan. */
  after: WorkItem[]
  /** The closing answer. */
  result: { item: MessageItem; text: string; streaming: boolean } | null
  needs: NeedsYou[]
  /** First and last stamp seen in the run. */
  startedAt: number | null
  endedAt: number | null
  /**
   * Time inside that span spent waiting on you: approvals, and questions the
   * agent asked. "Worked for" leaves it out.
   */
  waitedMs: number
  /** Where the latest work of the run went. */
  tail: RecordTail
  /** The run's last event was an error: that turn failed, whatever its steps say. */
  endedInError?: true
  /**
   * The run was stopped before it finished — its last call settled as stopped
   * with it, or the latest turn ended cancelled — whether or not it had a plan.
   */
  endedStopped?: true
  /**
   * The user turns the run spans, for its usage: the turn its instruction
   * opened (0-based) and how many — one, plus each message said into it while
   * it worked.
   */
  turn: number
  turns: number
}

export type RecordModel = { runs: RecordRun[] }

/**
 * Calls that only look — reads, searches, listings, catalog queries — fold
 * into one Explored line. A read-only terminal command is one of them (the
 * card is kept for commands that change things). Loading a skill is not a
 * lookup: it changes what the agent does next, so it keeps a line of its own.
 */
const LOOKUP_TOOLS = new Set([
  'read',
  'search',
  'glob',
  'grep',
  'codebase_search',
  'concept_search',
  'list_dir',
  'memory_list',
  'memory_read',
  'git_status',
  'git_diff',
  'github_pr_checks',
  'github_pr_comments',
  'lsp',
  'web_fetch',
  'web_search',
  'browser_search',
  'browser_navigate',
  'browser_snapshot',
  'browser_scroll',
  'browser_tabs',
  'browser_back',
  'browser_forward',
  'browser_wait_for_selector',
  'browser_wait_for_url',
  'browser_wait_for_text',
  'mcp_list_tools',
  'mcp_list_resources',
  'mcp_list_prompts',
  'request_mcp_tools',
  'release_mcp_tools',
  'terminal'
])

const INSTANCE_TOOLS = new Set([
  'spawn_agent_instance',
  'await_agent_instance',
  'pull_agent_instance',
  'merge_agent_instance',
  'cancel_agent_instance',
  'message_agent_instance'
])

function stamp(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

/** The key a todo is tracked by: its id as todos.json stores it, else its text. */
export function todoKey(todo: TodoItem): string {
  const id = todo.id ? canonicalTodoId(todo.id) : ''
  return id || todo.content
}

function isSettled(status: TodoItem['status']): boolean {
  return status === 'completed' || status === 'cancelled'
}

/** A todo snapshot a tool left behind, or null when it wrote none. */
export function todoSnapshotOf(tool: ToolItem['tool']): TodoItem[] | null {
  if (tool.name === 'todo_write' && tool.status === 'done') {
    const parsed = parseTodoData(tool)
    return parsed.items.length > 0 ? parsed.items : null
  }
  if (tool.name === 'create_plan' && tool.status === 'done') {
    // The list as main left it, echoed under the result — whole, or not used.
    const echoed = parseTodoData(tool)
    if (echoed.total > 0 && echoed.items.length === echoed.total) return echoed.items
    // Older results did not echo it: its arguments, kept as main keeps them.
    const items = argTodos(tool)
    return items ? oneInProgress(items) : null
  }
  return null
}

/** The todos a call's arguments name, as todos.json would key them. */
function argTodos(tool: ToolItem['tool']): TodoItem[] | null {
  const args = parseArgsRecord(tool.argsPreview)
  const todos = Array.isArray(args?.todos) ? args.todos : null
  if (!todos) return null
  const items: TodoItem[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { id?: unknown; content?: unknown; status?: unknown }
    const content = typeof row.content === 'string' ? row.content.replace(/\s+/g, ' ').trim() : ''
    if (!content) continue
    const status =
      row.status === 'in_progress' || row.status === 'completed' || row.status === 'cancelled'
        ? row.status
        : 'pending'
    // Keyed as todos.json keys it: main canonicalizes ids when it writes.
    const id = typeof row.id === 'string' ? canonicalTodoId(row.id) : ''
    items.push({ ...(id ? { id } : {}), content, status })
  }
  return items.length > 0 ? items : null
}

/**
 * Main keeps one todo in progress — the last one listed — and demotes the
 * rest (`toolTodoWrite`); a list read from arguments follows the same rule.
 */
function oneInProgress(items: TodoItem[]): TodoItem[] {
  let last = -1
  items.forEach((item, i) => {
    if (item.status === 'in_progress') last = i
  })
  return items.map((item, i) => (item.status === 'in_progress' && i !== last ? { ...item, status: 'pending' as const } : item))
}

/**
 * The steps a call set in progress together, in the order it listed them.
 * Main keeps one of them in progress; for a fan-out each of these is a child's
 * step, so they are where spawns that name no step go.
 */
function parallelSteps(tool: ToolItem['tool']): string[] {
  if (tool.name !== 'create_plan' && tool.name !== 'todo_write') return []
  const args = parseArgsRecord(tool.argsPreview)
  const todos = Array.isArray(args?.todos) ? args.todos : []
  const keys: string[] = []
  for (const raw of todos) {
    if (!raw || typeof raw !== 'object') continue
    const row = raw as { id?: unknown; content?: unknown; status?: unknown }
    if (row.status !== 'in_progress') continue
    const id = typeof row.id === 'string' ? canonicalTodoId(row.id) : ''
    const content = typeof row.content === 'string' ? row.content.replace(/\s+/g, ' ').trim() : ''
    const key = id || content
    if (key) keys.push(key)
  }
  return keys.length > 1 ? keys : []
}

/**
 * A shorter list naming only steps already in it is a status update, not a
 * new plan: main merges it (`toolTodoWrite`), and so does the record, for
 * runs written before it did — run dd5aafe0's closing `[s5]` otherwise left
 * a finished record without the four steps before it.
 */
function isStatusPatch(prior: readonly TodoItem[] | null, next: readonly TodoItem[]): boolean {
  if (!prior || next.length >= prior.length) return false
  const known = new Set(prior.map(todoKey))
  return next.every((todo) => known.has(todoKey(todo)))
}

/**
 * `create_plan` merges its todos into the list by id (as main does, see
 * `toolTodoWrite(…, merge = true)`): known ids update in place, new ones append.
 */
function mergeTodos(prior: readonly TodoItem[] | null, incoming: readonly TodoItem[]): TodoItem[] {
  if (!prior || prior.length === 0) return [...incoming]
  const next = [...prior]
  const index = new Map(next.map((todo, i) => [todoKey(todo), i]))
  for (const todo of incoming) {
    const at = index.get(todoKey(todo))
    if (at == null) {
      index.set(todoKey(todo), next.length)
      next.push(todo)
    } else {
      next[at] = { ...next[at]!, ...todo }
    }
  }
  return next
}

function planTitle(tool: ToolItem['tool']): string | null {
  const args = parseArgsRecord(tool.argsPreview)
  const title = typeof args?.title === 'string' ? args.title.trim() : ''
  if (title) return title
  const plan = typeof args?.plan === 'string' ? args.plan : ''
  const heading = /^#\s+(.+)$/m.exec(plan)
  return heading ? heading[1]!.trim() : null
}

function stepState(status: TodoItem['status']): TaskState {
  if (status === 'in_progress') return 'running'
  if (status === 'completed') return 'done'
  if (status === 'cancelled') return 'stopped'
  return 'queued'
}

/** The tool items a list of work holds, in order. */
function toolsOf(work: readonly WorkItem[]): ToolItem[] {
  const out: ToolItem[] = []
  for (const w of work) {
    if (w.kind === 'explore') out.push(...w.tools)
    else if (w.kind === 'card' || w.kind === 'tool' || w.kind === 'instance' || w.kind === 'plan' || w.kind === 'view') out.push(w.tool)
  }
  return out
}

/** Latest stamp in a list of work: a call's end, else its start, else a message's. */
function lastStampOf(work: readonly WorkItem[]): number | null {
  let last: number | null = null
  const see = (t: number | null): void => {
    if (t != null && (last == null || t > last)) last = t
  }
  for (const w of work) {
    if (w.kind === 'note' || w.kind === 'thought' || w.kind === 'said') see(stamp(w.item.at))
    else if (w.kind === 'compaction' || w.kind === 'notice') see(stamp(w.item.at))
  }
  for (const tool of toolsOf(work)) {
    see(stamp(tool.at))
    see(stamp(tool.endedAt))
  }
  return last
}

/** What the record knows of a child instance: its phase, and when it ran. */
export type InstanceFacts = Pick<AgentInstanceUiState, 'phase' | 'startedAt' | 'endedAt' | 'stepId'>

type ChildFacts = { phase: InstanceFacts['phase'] | null; start: number | null; end: number | null }

const SETTLED_PHASE_RE = /^phase:\s*(done|error|cancelled)\s*$/m

/** The run ids of the children a list of calls spawned, in order. */
function spawnedChildren(tools: readonly ToolItem[]): string[] {
  const ids: string[] = []
  for (const item of tools) {
    if (item.tool.name !== 'spawn_agent_instance' || item.tool.status !== 'done') continue
    const runId = parseAgentInstanceRunId(item.tool.content)
    if (runId && !ids.includes(runId)) ids.push(runId)
  }
  return ids
}

/**
 * A child's phase and times: from the parent's live instance updates when it
 * has them, else from the calls — its spawn, and the await that settled.
 */
function childFacts(runId: string, tools: readonly ToolItem[], instances: BuildOptions['instances']): ChildFacts {
  let phase: ChildFacts['phase'] = null
  let start: number | null = null
  let end: number | null = null
  for (const item of tools) {
    const name = item.tool.name
    if (name === 'spawn_agent_instance') {
      if (parseAgentInstanceRunId(item.tool.content) !== runId) continue
      start = stamp(item.endedAt) ?? stamp(item.at)
      continue
    }
    if (name !== 'await_agent_instance' && name !== 'cancel_agent_instance') continue
    if (parseAgentInstanceRunIdFromArgs(item.tool.argsPreview) !== runId || item.tool.status === 'running') continue
    const settled = SETTLED_PHASE_RE.exec(item.tool.content ?? '')?.[1] as ChildFacts['phase'] | undefined
    if (name === 'cancel_agent_instance' && item.tool.status === 'done') phase = 'cancelled'
    else if (settled) phase = settled
    else if (item.tool.status === 'done') phase = 'done'
    if (phase && phase !== 'started') end = stamp(item.endedAt) ?? end
  }
  const known = instances?.[runId]
  if (known) {
    phase = known.phase
    start = stamp(known.startedAt) ?? start
    if (known.phase !== 'started') end = stamp(known.endedAt) ?? end
  }
  return { phase, start, end }
}

/**
 * A step whose own sub-agent work failed did not finish, whatever its todo
 * says. A failed non-instance tool (a command, a read) does not fail the step,
 * and neither does an await that timed out on a child that went on to finish
 * or is still running: the child's own phase says how its work went.
 */
/** main's reply when an await's wait ran out before the child finished. */
const AWAIT_TIMED_OUT = /^\s*Timed out waiting for\b/

function stepWorkFailed(items: ToolItem[], instances: BuildOptions['instances'], runStopped: boolean): boolean {
  return items.some((item) => {
    if (!INSTANCE_TOOLS.has(item.tool.name) || item.tool.status !== 'fail') return false
    // Cut off by your Stop: the run stopped, nothing in the step broke. In a
    // run that carried on, a child cancelled under it is the step's failure.
    if (runStopped && isInterruptedToolContent(item.tool.content)) return false
    // A spawn refused before any child ran (its args, a cap): its own row
    // says so, and the step goes the way of the child that did run.
    if (item.tool.name === 'spawn_agent_instance' && !parseAgentInstanceRunId(item.tool.content)) return false
    if (item.tool.name === 'await_agent_instance') {
      // A wait that ran out left the child running: nothing failed then, and
      // a Stop that cancels the child later does not make it a failure.
      if (AWAIT_TIMED_OUT.test(item.tool.content ?? '')) return false
      const runId = parseAgentInstanceRunIdFromArgs(item.tool.argsPreview)
      const phase = runId ? childFacts(runId, items, instances).phase : null
      if (phase === 'done' || phase === 'started') return false
    }
    return true
  })
}

/** A row's view key: its first id, so a provider id replacing a placeholder does not remount it. */
function rowKey(item: ToolItem): string {
  return item.key ?? item.id
}

/**
 * A command still streaming its arguments: until the command is known the
 * record cannot tell a card (it changes things) from a lookup line (it only
 * reads), and guessing drew one and then swapped it for the other.
 */
function isUndecidedCommand(item: ToolItem): boolean {
  if (item.tool.name !== 'terminal' || item.tool.status !== 'running') return false
  const args = parseArgsRecord(item.tool.argsPreview)
  const command = args?.command ?? args?.cmd
  if (typeof command === 'string' && command.trim()) return false
  return !item.tool.summary?.trim()
}

type Bucket = { work: WorkItem[]; pending: ToolItem[] }

/** What the agent said last in this bucket, when nothing but its reasoning came after. */
function saidJustBefore(bucket: Bucket): string | undefined {
  if (bucket.pending.length > 0) return undefined
  for (let i = bucket.work.length - 1; i >= 0; i--) {
    const w = bucket.work[i]!
    if (w.kind === 'note') return w.text
    if (w.kind !== 'thought') return undefined
  }
  return undefined
}

function newBucket(): Bucket {
  return { work: [], pending: [] }
}

/** Close a run of lookups into one explore line; cards and instances stand alone. */
function flush(bucket: Bucket): void {
  let group: ToolItem[] = []
  const closeGroup = (): void => {
    if (group.length === 0) return
    bucket.work.push({ kind: 'explore', id: `explore:${rowKey(group[0]!)}`, tools: group })
    group = []
  }
  for (const item of bucket.pending) {
    if (item.tool.name === 'create_plan') {
      closeGroup()
      bucket.work.push({ kind: 'plan', id: rowKey(item), tool: item, title: planTitle(item.tool) })
      continue
    }
    if (INSTANCE_TOOLS.has(item.tool.name)) {
      closeGroup()
      bucket.work.push({ kind: 'instance', id: rowKey(item), tool: item })
      continue
    }
    if (item.tool.name === 'show_view') {
      closeGroup()
      bucket.work.push({ kind: 'view', id: rowKey(item), tool: item })
      continue
    }
    if (isProminentPresentation(item.tool)) {
      closeGroup()
      bucket.work.push({ kind: 'card', id: rowKey(item), tool: item })
      continue
    }
    if (LOOKUP_TOOLS.has(item.tool.name)) {
      group.push(item)
      continue
    }
    closeGroup()
    bucket.work.push({ kind: 'tool', id: rowKey(item), tool: item })
  }
  closeGroup()
  bucket.pending = []
}

/** Bucket keys: 'setup', 'after', a step's own (`s:`) and after-it (`b:`). */
const stepBucket = (key: string): string => `s:${key}`
const betweenBucket = (key: string): string => `b:${key}`

function tailOf(target: string): RecordTail {
  if (target.startsWith('s:')) return { kind: 'step', key: target.slice(2) }
  if (target.startsWith('b:')) return { kind: 'between', key: target.slice(2) }
  return target === 'after' ? { kind: 'after' } : { kind: 'setup' }
}

type RunBuilder = {
  run: RecordRun
  buckets: Map<string, Bucket>
  /** Latest snapshot, in order. */
  todos: TodoItem[] | null
  /** Every step the run's snapshots named, first-seen order, latest content and status. */
  seen: Map<string, { todo: TodoItem; order: number }>
  /** Where work goes right now: a bucket key. */
  target: string
  /** The step that was in progress last, if any. */
  lastActive: string | null
  firstStarted: Map<string, number>
  lastCompleted: Map<string, number>
  /** Stamp of the latest snapshot applied. */
  lastSnapshotAt: number | null
  /** How much work the current target held when the latest snapshot applied. */
  markAtSnapshot: number
  lastAssistant: MessageItem | null
  /** The last item seen in this run was a run_error. */
  endedInError: boolean
  /** The last item seen in this run was a call stopped with the run. */
  endedStopped: boolean
  /** Each child's step, by its run id: where its awaits, pulls and merges go. */
  childStep: Map<string, string>
  /** Steps the latest snapshot's call set in progress together (a fan-out). */
  parallel: string[]
  /** Steps a child has been filed under. */
  claimed: Set<string>
  /** Children spawned before the run had a list to name their step from: filed once it has one. */
  early: EarlySpawn[]
}

type EarlySpawn = { item: ToolItem; runId: string | null; stepId: string; bucket: Bucket }

function bucketFor(b: RunBuilder, key: string): Bucket {
  let bucket = b.buckets.get(key)
  if (!bucket) {
    bucket = newBucket()
    b.buckets.set(key, bucket)
  }
  return bucket
}

function current(b: RunBuilder): Bucket {
  return bucketFor(b, b.target)
}

function applySnapshot(b: RunBuilder, todos: TodoItem[], at: number | null, parallel?: string[]): void {
  if (parallel) b.parallel = parallel
  const here = current(b)
  flush(here)
  const before = new Map((b.todos ?? []).map((todo) => [todoKey(todo), todo.status]))

  // Out of any step, a snapshot that marks exactly one never-started step done
  // names what the work since the last snapshot served (a model that skips
  // `in_progress`, or a transcript whose in-progress marks were rewritten).
  if (b.todos && !b.target.startsWith('s:')) {
    const newlyDone = todos.filter((todo) => {
      const key = todoKey(todo)
      return todo.status === 'completed' && before.get(key) !== 'completed' && !b.firstStarted.has(key)
    })
    if (newlyDone.length === 1) {
      const key = todoKey(newlyDone[0]!)
      const moved = here.work.splice(b.markAtSnapshot)
      if (moved.length > 0) {
        bucketFor(b, stepBucket(key)).work.push(...moved)
        if (b.lastSnapshotAt != null) b.firstStarted.set(key, b.lastSnapshotAt)
      }
    }
  }

  b.todos = todos
  for (const todo of todos) {
    const key = todoKey(todo)
    b.seen.set(key, { todo, order: b.seen.get(key)?.order ?? b.seen.size })
    if (todo.status === 'in_progress' && at != null && !b.firstStarted.has(key)) b.firstStarted.set(key, at)
    // The moment it became completed — a later snapshot repeating it is not
    // when it finished. Reopened and completed again, the new moment counts.
    if (todo.status === 'completed' && at != null && before.get(key) !== 'completed') {
      b.lastCompleted.set(key, at)
    }
  }
  fileEarlySpawns(b)
  // Steps this snapshot finished: what comes next follows the last of them.
  // A model that never marks a step in progress left no step "last active",
  // so every later row went to "setup", above all the steps it had just ticked
  // off, until its next update moved it down into a step.
  const finished = todos.filter((todo) => todo.status === 'completed' && before.get(todoKey(todo)) !== 'completed')
  if (finished.length > 0) b.lastActive = todoKey(finished[finished.length - 1]!)
  const active = todos.find((todo) => todo.status === 'in_progress')
  if (active) {
    b.lastActive = todoKey(active)
    b.target = stepBucket(b.lastActive)
  } else if (todos.every((todo) => isSettled(todo.status))) {
    b.target = 'after'
  } else {
    // Nothing in progress, something still to do: after the step that last
    // was, or — before any has started — still setting up.
    b.target = b.lastActive ? betweenBucket(b.lastActive) : 'setup'
  }
  b.markAtSnapshot = current(b).work.length
  if (at != null) b.lastSnapshotAt = at
}

/**
 * Calls the loop started at or after a `todo_write` it ran first (it runs a
 * step's todo_write ahead of the calls listed with it) — or have not started
 * yet — ran under the list that write set, whatever the order they were listed in.
 */
function takeLateStarters(bucket: Bucket, todo: ToolItem): ToolItem[] {
  const todoAt = stamp(todo.at)
  if (todoAt == null || bucket.pending.length === 0) return []
  const late: ToolItem[] = []
  const kept: ToolItem[] = []
  for (const item of bucket.pending) {
    const at = stamp(item.at)
    const endedAt = stamp(item.endedAt)
    // A call of an earlier step had finished before this write began.
    const endedBefore = endedAt != null && endedAt <= todoAt
    const startedAfter = at != null ? at >= todoAt : item.tool.status === 'running'
    ;(startedAfter && !endedBefore ? late : kept).push(item)
  }
  if (late.length === 0) return []
  bucket.pending = kept
  return late
}

/**
 * A slash command reaches the model as an injected prompt (the skill body, or
 * a tool hint); the record shows the command and what was asked with it.
 */
function briefOf(content: string): { text: string; command?: string } {
  const skill = parseSkillInvocation(content)
  if (skill) return { text: skill.userRequest, command: skill.skillName }
  const mcp = parseMcpToolInvocation(content)
  if (mcp) return { text: mcp.userRequest, command: `${mcp.serverId}-${mcp.toolName}` }
  return { text: content }
}

function startRun(n: number, user: MessageItem | null, id: string, notBefore: number | null, turn: number): RunBuilder {
  const at = stamp(user?.at)
  // A follow-up queued while the last run worked is stamped when it was typed;
  // its run starts when it was taken up, which is no earlier than that run's end.
  const startedAt = at != null && notBefore != null ? Math.max(at, notBefore) : (at ?? notBefore)
  const brief = briefOf(user?.content ?? '')
  return {
    run: {
      n,
      id,
      text: brief.text,
      ...(brief.command ? { command: brief.command } : {}),
      ...(user?.structuredFrom ? { structuredFrom: user.structuredFrom } : {}),
      images: user?.images ?? [],
      attachments: user?.attachments ?? [],
      at,
      setup: [],
      steps: [],
      after: [],
      result: null,
      needs: [],
      startedAt: user ? startedAt : null,
      endedAt: user ? startedAt : null,
      waitedMs: 0,
      tail: { kind: 'setup' },
      turn,
      // Work from before any instruction (a transcript window that opens
      // mid-run) has no turn of its own: its usage is binned with the next run's.
      turns: user ? 1 : 0
    },
    buckets: new Map(),
    todos: null,
    seen: new Map(),
    target: 'setup',
    lastActive: null,
    firstStarted: new Map(),
    lastCompleted: new Map(),
    lastSnapshotAt: null,
    markAtSnapshot: 0,
    lastAssistant: null,
    endedInError: false,
    endedStopped: false,
    childStep: new Map(),
    parallel: [],
    claimed: new Set(),
    early: []
  }
}

/**
 * The bucket an instance call goes to: its child's step, when the record can
 * tell which that is; null leaves it with the rest of the current work.
 */
function instanceBucket(
  b: RunBuilder,
  item: ToolItem,
  instances: Readonly<Record<string, InstanceFacts>> | undefined
): Bucket | null {
  const name = item.tool.name
  if (!INSTANCE_TOOLS.has(name)) return null
  if (name !== 'spawn_agent_instance') {
    const runId = parseAgentInstanceRunIdFromArgs(item.tool.argsPreview)
    const key = runId ? b.childStep.get(runId) : undefined
    return key ? bucketFor(b, stepBucket(key)) : null
  }
  const runId = parseAgentInstanceRunId(item.tool.content)
  const stepId = spawnStepId(item, runId ? instances?.[runId] : undefined)
  const key = namedStep(b, stepId) ?? b.parallel.find((k) => !b.claimed.has(k)) ?? null
  if (!key) {
    // Spawned from the step in progress: its awaits follow it there, even
    // once another step has started.
    if (runId && b.target.startsWith('s:')) b.childStep.set(runId, b.target.slice(2))
    // Spawned before the run listed any step: the list that follows names it.
    else if (!b.todos || b.todos.length === 0) b.early.push({ item, runId, stepId, bucket: current(b) })
    return null
  }
  fileChild(b, key, runId, item)
  return bucketFor(b, stepBucket(key))
}

/** A child's step from here on: its awaits follow it, and the step starts no later than its spawn. */
function fileChild(b: RunBuilder, key: string, runId: string | null, item: ToolItem): void {
  b.claimed.add(key)
  if (runId) b.childStep.set(runId, key)
  const at = stamp(item.at)
  const first = b.firstStarted.get(key)
  if (at != null && (first == null || at < first)) b.firstStarted.set(key, at)
}

/**
 * The step a spawn names. The args preview is cut short on a long brief and a
 * model can send them malformed, so main's own reading of `step_id`, carried
 * on the child's start, is the fallback.
 */
function spawnStepId(item: ToolItem, child: InstanceFacts | undefined): string {
  const args = parseArgsRecord(item.tool.argsPreview)
  const raw = typeof args?.step_id === 'string' ? args.step_id.trim() : ''
  if (raw) return raw
  if (child?.stepId?.trim()) return child.stepId.trim()
  // Args that do not parse (cut, or sent malformed) can still say it in so many words.
  return STEP_ID_IN_ARGS.exec(item.tool.argsPreview ?? '')?.[1]?.trim() ?? ''
}

const STEP_ID_IN_ARGS = /"step_id"\s*:\s*"([^"\\]{1,80})"/

/** The step `stepId` names, when the run's list has it. */
function namedStep(b: RunBuilder, stepId: string): string | null {
  if (!stepId) return null
  const id = canonicalTodoId(stepId)
  if (b.seen.has(id)) return id
  return b.seen.has(stepId) ? stepId : null
}

/**
 * Children spawned before the run had a list, filed under the steps the first
 * list gives them: the one each names, then, in order, the steps that list set
 * in progress together that no child has yet. One it gives none stays where it
 * was spawned.
 */
function fileEarlySpawns(b: RunBuilder): void {
  if (b.early.length === 0 || !b.todos || b.todos.length === 0) return
  const early = b.early
  b.early = []
  const named = early.map((spawn) => namedStep(b, spawn.stepId))
  // Named first, so a child that named no step cannot take a named one's.
  // Two naming the same step (a retry) both go there, as they would later.
  early.forEach((spawn, i) => {
    const key = named[i]
    if (key) moveSpawn(b, spawn, key)
  })
  early.forEach((spawn, i) => {
    if (named[i]) return
    const key = b.parallel.find((k) => !b.claimed.has(k))
    if (key) moveSpawn(b, spawn, key)
  })
}

function moveSpawn(b: RunBuilder, spawn: EarlySpawn, key: string): void {
  const pending = spawn.bucket.pending.indexOf(spawn.item)
  if (pending >= 0) spawn.bucket.pending.splice(pending, 1)
  else {
    const at = spawn.bucket.work.findIndex((w) => w.kind === 'instance' && w.tool === spawn.item)
    if (at < 0) return
    spawn.bucket.work.splice(at, 1)
  }
  fileChild(b, key, spawn.runId, spawn.item)
  bucketFor(b, stepBucket(key)).pending.push(spawn.item)
}

/** How long a call waited on you: its approval, or the whole of a question the agent asked. */
function waitedOn(item: Extract<UiItem, { kind: 'tool' }>): number {
  if (item.tool.waitedMs) return item.tool.waitedMs
  if (item.tool.name !== 'ask_question' || item.tool.status === 'running') return 0
  const start = stamp(item.at)
  const end = stamp(item.endedAt)
  return start != null && end != null && end > start ? end - start : 0
}

function touch(b: RunBuilder, at: number | null): void {
  if (at == null) return
  if (b.run.startedAt == null || at < b.run.startedAt) b.run.startedAt = at
  if (b.run.endedAt == null || at > b.run.endedAt) b.run.endedAt = at
}

/** The order steps show in: the latest plan's, each superseded step just before what followed it. */
function stepOrder(b: RunBuilder, finalKeys: string[], superseded: string[]): string[] {
  const order = (key: string): number => b.seen.get(key)?.order ?? Number.MAX_SAFE_INTEGER
  const out = [...finalKeys]
  const finalSet = new Set(finalKeys)
  for (const key of [...superseded].sort((x, y) => order(x) - order(y))) {
    const at = out.findIndex((k) => finalSet.has(k) && order(k) > order(key))
    if (at < 0) out.push(key)
    else out.splice(at, 0, key)
  }
  return out
}

/** Markdown that structures a reply: a heading, a table or a fence. */
const ANSWER_BLOCK = /^(?:#{1,6}\s|\s*\||\s*(?:`{3}|~{3}))/m
/** A list item: an answer's, or narration's "I'll look at three places:". */
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/m

/**
 * Words that read as the closing answer while they are still being written:
 * structured, or several paragraphs long. A line of narration before the next
 * call ("Let me read the config.") is neither, so it never jumps out of the
 * work and back; nor is a short list of where it will look next, so a list
 * alone needs the length of a reply.
 */
export function answerShaped(text: string): boolean {
  const body = text.trim()
  if (body.length >= 120 && ANSWER_BLOCK.test(body)) return true
  if (body.length >= 400 && LIST_ITEM.test(body)) return true
  return body.length >= 200 && body.split(/\n\s*\n/).filter((p) => p.trim()).length >= 3
}

function finishRun(b: RunBuilder, options: BuildOptions, isLast: boolean): RecordRun {
  for (const bucket of b.buckets.values()) flush(bucket)
  const workOf = (key: string): WorkItem[] => b.buckets.get(key)?.work ?? []

  // The closing answer: the last thing the agent said, when no work came
  // after it (reasoning after it is not work, and neither is a compaction —
  // a /compact run once the task is idle folded the context, it did not
  // answer anything, and it used to take the run's Result away). It leaves the work list and
  // becomes the result once the run is over: mid-run narration is not an
  // answer yet. While the run is live, only words shaped like an answer are
  // read as it being written; a call after them puts them back in the work,
  // and reasoning after them does not (it may end in nothing more to do).
  const live = isLast && options.running
  const last = b.lastAssistant
  if (last) {
    for (const bucket of b.buckets.values()) {
      const at = bucket.work.findIndex((w) => w.kind === 'note' && w.item.id === last.id)
      if (at < 0) continue
      const after = bucket.work.slice(at + 1)
      if (!after.every((w) => w.kind === 'thought' || w.kind === 'compaction' || w.kind === 'notice')) break
      const note = bucket.work[at] as Extract<WorkItem, { kind: 'note' }>
      // A serialized payload is not an answer: it stays a visible note and
      // the run keeps no result, so the title falls back to the brief.
      if (isSerializedPayloadText(note.text)) break
      if (live && !answerShaped(note.text)) break
      bucket.work.splice(at, 1)
      b.run.result = { item: last, text: note.text, streaming: Boolean(last.streaming) }
      break
    }
  }

  const todos = b.todos ?? []
  const finalKeys = todos.map(todoKey)
  const finalSet = new Set(finalKeys)
  const superseded = [...b.seen.keys()].filter(
    (key) => !finalSet.has(key) && (workOf(stepBucket(key)).length > 0 || workOf(betweenBucket(key)).length > 0)
  )
  const position = new Map(finalKeys.map((key, i) => [key, i + 1]))
  const runEnd = b.run.endedAt
  // Every call of the run: a child's awaits may sit in another step than its spawn.
  const runTools = [...b.buckets.values()].flatMap((bucket) => toolsOf(bucket.work))
  b.run.steps = stepOrder(b, finalKeys, superseded).map((key) => {
    const todo = todos.find((t) => todoKey(t) === key) ?? b.seen.get(key)!.todo
    const isSuperseded = !finalSet.has(key)
    const work = workOf(stepBucket(key))
    const stepTools = toolsOf(work)
    const started = b.firstStarted.has(key)
    let state = stepState(todo.status)
    if (isSuperseded) {
      // Replaced before it finished: it did not run to the end.
      if (state === 'running' || state === 'queued') state = 'stopped'
    } else if (!live && (state === 'running' || (state === 'queued' && started))) {
      // A step left in progress (or started, then set back) by a run that is
      // over did not finish.
      state = isLast && options.failed ? 'failed' : 'stopped'
    }
    // A step that runs a child goes the way its child does: running while it
    // runs — main keeps one todo in progress, and a fan-out's other steps
    // would read as not started — and done once it is, if the model has not
    // ticked it yet. Its time is the child's and its own calls'.
    const kids = spawnedChildren(stepTools).map((id) => childFacts(id, runTools, options.instances))
    if (!isSuperseded && kids.length > 0) {
      if (kids.some((k) => k.phase === 'error')) state = 'failed'
      else if (live && kids.some((k) => k.phase === 'started')) state = 'running'
      else if (kids.some((k) => k.phase === 'cancelled') && state !== 'done') state = 'stopped'
      else if (kids.every((k) => k.phase === 'done') && (state === 'queued' || state === 'stopped')) state = 'done'
    }
    // The todo can claim a step finished while its own sub-agent work did not.
    if (stepWorkFailed(stepTools, options.instances, !live && (b.endedStopped || (isLast && options.stopped === true)))) state = 'failed'
    let startedAt = b.firstStarted.get(key) ?? null
    let endedAt =
      todo.status === 'completed'
        ? (b.lastCompleted.get(key) ?? null)
        : state === 'stopped' || state === 'failed'
          ? started
            ? (lastStampOf(work) ?? runEnd)
            : null
          : null
    if (kids.length > 0) {
      for (const k of kids) if (k.start != null && (startedAt == null || k.start < startedAt)) startedAt = k.start
      if (state === 'running' || state === 'needs') endedAt = null
      else {
        let last = lastStampOf(work)
        for (const k of kids) if (k.end != null && (last == null || k.end > last)) last = k.end
        endedAt = last ?? endedAt
      }
    }
    return {
      key,
      n: position.get(key) ?? 0,
      title: todo.content,
      state,
      work,
      between: workOf(betweenBucket(key)),
      startedAt,
      endedAt,
      edits: editSummary(stepTools),
      ...(isSuperseded ? { superseded: true as const } : {})
    }
  })
  // With no plan there is no "before the steps": the work is the run's work.
  if (b.run.steps.length === 0) {
    b.run.setup = []
    b.run.after = [...workOf('setup'), ...workOf('after')]
    b.run.tail = { kind: 'after' }
  } else {
    b.run.setup = workOf('setup')
    b.run.after = workOf('after')
    b.run.tail = tailOf(b.target)
  }

  // A step waiting on you shows it, and holds the card; with no plan, the card
  // goes where the work went.
  if (live) {
    for (const need of b.run.needs) {
      const step = b.run.steps.find((s) => s.key === need.stepKey)
      if (step && step.state === 'running') step.state = 'needs'
      if (b.run.steps.length === 0) need.place = { kind: 'after' }
    }
  } else {
    b.run.needs = []
  }
  if (b.endedInError) b.run.endedInError = true
  else if (!live && (b.endedStopped || (isLast && options.stopped))) b.run.endedStopped = true
  return b.run
}

function editSummary(tools: ToolItem[]): RecordStep['edits'] {
  const stats = tools
    .filter((item) => item.tool.status === 'done')
    .map((item) => editStatOf(item.tool))
    .filter((stat): stat is EditStat => stat !== null)
  return sumEditStats(stats)
}

export type BuildOptions = {
  /** The task is live (a run is in flight). */
  running: boolean
  /**
   * Runs that start above the loaded transcript window, so run numbers count
   * from the task's first run. A window that opens partway through a run
   * continues the last of them and takes its number.
   */
  runsBefore?: number
  /** The latest run ended in an error. */
  failed?: boolean
  /** The latest run was stopped (cancelled or interrupted) rather than finishing. */
  stopped?: boolean
  /** Show reasoning as thought lines (the "Show thinking" setting). */
  showThinking?: boolean
  /**
   * The run's current todos from `todos.json`. Only applied to the latest run,
   * only once that run has written todos of its own, only to steps it named,
   * and only when `liveTodosUpdatedAt` shows the file was written after the
   * latest snapshot in the items — a poll that lags a `todo_write` result must
   * never roll a step back.
   */
  liveTodos?: TodoItem[] | null
  /** todos.json's `updatedAt`. */
  liveTodosUpdatedAt?: string | null
  /** The run's child instances by run id, from its instance updates. */
  instances?: Readonly<Record<string, InstanceFacts>>
}

export function buildRecordModel(items: readonly UiItem[], options: BuildOptions): RecordModel {
  const runs: RecordRun[] = []
  let b: RunBuilder | null = null
  const questionGated = new Set<string>()
  for (const item of items) {
    if (item.kind === 'question' && item.question.toolCallId) questionGated.add(item.question.toolCallId)
  }

  let base: number | null = null
  const numberOf = (continues: boolean): number => {
    const before = options.runsBefore ?? 0
    base ??= continues ? Math.max(0, before - 1) : before
    return runs.length + 1 + base
  }

  const ensure = (id: string): RunBuilder => {
    if (!b) b = startRun(numberOf(true), null, id, null, 0)
    return b
  }

  // Each user message is a turn its usage is counted under, whichever run shows it.
  let turn = -1
  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') {
      turn += 1
      const prior: RunBuilder | null = b
      if (prior && item.midTurn === true) {
        // Said while the run worked (Send now): the run carries on with it, so
        // it is a line in the work where it landed, not a run of its own.
        touch(prior, stamp(item.at))
        prior.lastAssistant = null
        flush(current(prior))
        current(prior).work.push({ kind: 'said', id: item.id, item, text: item.content })
        prior.run.turns += 1
      } else if (prior) {
        const finished = finishRun(prior, options, false)
        runs.push(finished)
        b = startRun(numberOf(false), item, item.id, finished.endedAt, turn)
      } else {
        b = startRun(numberOf(item.midTurn === true), item, item.id, null, Math.max(turn, 0))
      }
      continue
    }
    const run = ensure(item.id)
    touch(run, stamp(item.at))
    if (item.kind === 'tool') touch(run, stamp(item.endedAt))
    if (item.kind === 'tool') run.run.waitedMs += waitedOn(item)
    // Anything after an error (a retry carrying on) means the run did not end there.
    run.endedInError = item.kind === 'run_error'
    run.endedStopped =
      item.kind === 'tool' && item.tool.status !== 'running' && isInterruptedToolContent(item.tool.content)

    if (item.kind === 'tool') {
      let snapshot = todoSnapshotOf(item.tool)
      if (item.tool.name === 'todo_write') {
        if (snapshot) {
          if (isStatusPatch(run.todos, snapshot)) snapshot = mergeTodos(run.todos, snapshot)
          const late = takeLateStarters(current(run), item)
          // A child spawned with this write ran under the list it set: it
          // waits for no list, and files by the step it names like any other.
          const spawnedWith = new Set(run.early.filter((s) => late.includes(s.item)).map((s) => s.item))
          run.early = run.early.filter((s) => !spawnedWith.has(s.item))
          applySnapshot(run, snapshot, stamp(item.at), parallelSteps(item.tool))
          for (const call of late) {
            const bucket = spawnedWith.has(call) ? instanceBucket(run, call, options.instances) : null
            ;(bucket ?? current(run)).pending.push(call)
          }
        }
        continue
      }
      // Verdicts on done-when checks show with the checks, not as work.
      if (item.tool.name === 'check_done_when') continue
      if (item.approval) {
        const why = saidJustBefore(current(run))
        run.run.needs.push({
          kind: 'approval',
          approval: item.approval,
          tool: item,
          stepKey: run.target.startsWith('s:') ? run.target.slice(2) : null,
          place: tailOf(run.target),
          at: stamp(item.approval.requestedAt) ?? stamp(item.at),
          ...(why ? { why } : {})
        })
      }
      // Work after the agent spoke means that was not its closing answer.
      run.lastAssistant = null
      // A call waiting on your answer is its card until then: one place, not two.
      if (item.approval || questionGated.has(item.id) || isUndecidedCommand(item)) continue
      ;(instanceBucket(run, item, options.instances) ?? current(run)).pending.push(item)
      if (snapshot) {
        if (item.tool.name === 'create_plan') snapshot = mergeTodos(run.todos, snapshot)
        applySnapshot(run, snapshot, stamp(item.at), parallelSteps(item.tool))
      }
      continue
    }

    if (item.kind === 'question') {
      run.run.needs.push({
        kind: 'question',
        question: item.question,
        stepKey: run.target.startsWith('s:') ? run.target.slice(2) : null,
        place: tailOf(run.target),
        at: stamp(item.at)
      })
      continue
    }
    if (item.kind === 'run_error') {
      run.lastAssistant = null
      flush(current(run))
      current(run).work.push({ kind: 'error', id: item.id, message: item.message, ...(item.code ? { code: item.code } : {}) })
      continue
    }
    if (item.kind === 'compaction') {
      // Not work: the last thing said before a fold is still the closing answer.
      flush(current(run))
      current(run).work.push({ kind: 'compaction', id: item.id, item })
      continue
    }
    if (item.kind === 'notice') {
      // Not work either: the step carried on, on another model.
      flush(current(run))
      current(run).work.push({ kind: 'notice', id: item.id, item })
      continue
    }

    // Assistant message: reasoning, then any words it said.
    const message = item as MessageItem
    const text = message.streaming
      ? stripToolShapedAssistantTextForStream(message.content)
      : stripToolShapedAssistantText(message.content)
    const hasText = Boolean(text?.trim()) && !duplicatesReasoning({ ...message, content: text })
    const thinking = message.thinking?.trim() ?? ''
    if (!hasText && !(options.showThinking !== false && thinking)) continue
    flush(current(run))
    if (options.showThinking !== false && thinking) {
      current(run).work.push({
        kind: 'thought',
        id: `${message.id}:thought`,
        item: message,
        text: thinking,
        streaming: Boolean(message.thinkingStreaming)
      })
    }
    // Reasoning alone is not work: it leaves the last thing said the closing answer.
    if (hasText) {
      current(run).work.push({ kind: 'note', id: message.id, item: message, text: text! })
      run.lastAssistant = message
    }
  }

  if (b) {
    const last = b as RunBuilder
    applyLiveTodos(last, options)
    runs.push(finishRun(last, options, true))
  }
  return { runs }
}

/**
 * todos.json outlives the run that wrote it: a follow-up that made no plan of
 * its own must not wear the last run's steps, and a list merged with an older
 * run's must not add them. It only freshens the status and text of steps this
 * run named, and only when it was written after the latest snapshot here.
 */
function applyLiveTodos(b: RunBuilder, options: BuildOptions): void {
  const live = options.liveTodos
  if (!options.running || !live || live.length === 0 || !b.todos) return
  const writtenAt = stamp(options.liveTodosUpdatedAt ?? undefined)
  if (writtenAt == null || b.lastSnapshotAt == null || writtenAt <= b.lastSnapshotAt) return
  const byKey = new Map(live.map((todo) => [todoKey(todo), todo]))
  let changed = false
  const next = b.todos.map((todo) => {
    const fresh = byKey.get(todoKey(todo))
    if (!fresh || (fresh.status === todo.status && fresh.content === todo.content)) return todo
    changed = true
    return { ...todo, status: fresh.status, content: fresh.content }
  })
  if (changed) applySnapshot(b, next, writtenAt)
}

/** The run's state for the header and history lines. */
export function runStateOf(run: RecordRun, isLast: boolean, options: BuildOptions): TaskState {
  if (isLast && options.running) return run.needs.length > 0 ? 'needs' : 'running'
  if (isLast && options.failed) return 'failed'
  if (run.endedInError) return 'failed'
  if (run.steps.some((s) => s.state === 'failed')) return 'failed'
  if (run.endedStopped && !run.result) return 'stopped'
  if (run.steps.some((s) => s.state === 'stopped' && !s.superseded) && !run.result) return 'stopped'
  return 'done'
}
