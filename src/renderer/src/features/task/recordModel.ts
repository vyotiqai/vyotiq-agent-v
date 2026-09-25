import type { UiAgentQuestion, UiAttachment, UiItem, UiToolApproval } from '@shared/transcript'
import {
  duplicatesReasoning,
  stripToolShapedAssistantText,
  stripToolShapedAssistantTextForStream
} from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import type { TaskState } from '@renderer/lib/ui'
import { isProminentPresentation } from '@renderer/features/chat/toolUi'
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
 *   the latest snapshot before it in item order;
 * - durations come from the `at` stamps the items carry, never estimates.
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
  /** What the agent said between steps of work. */
  | { kind: 'note'; id: string; item: MessageItem; text: string }
  | { kind: 'thought'; id: string; item: MessageItem; text: string; streaming: boolean }
  | { kind: 'error'; id: string; message: string; code?: string }
  | { kind: 'compaction'; id: string; item: Extract<UiItem, { kind: 'compaction' }> }

export type RecordStep = {
  /** The todo's id when it has one, else its text. */
  key: string
  n: number
  title: string
  state: TaskState
  work: WorkItem[]
  /** When it went in progress and when it finished, from the snapshot stamps. */
  startedAt: number | null
  endedAt: number | null
  /** Edits made while this step was in progress; lines only when every one was countable. */
  edits: { files: number; add?: number; del?: number } | null
}

export type NeedsYou =
  | { kind: 'approval'; approval: UiToolApproval; tool: ToolItem; stepKey: string | null; at: number | null }
  | { kind: 'question'; question: UiAgentQuestion; stepKey: string | null; at: number | null }

export type RecordRun = {
  n: number
  id: string
  /** The instruction as sent. Empty for a run with no user turn (a resumed goal). */
  text: string
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
  /** The run's last event was an error: that turn failed, whatever its steps say. */
  endedInError?: true
}

export type RecordModel = { runs: RecordRun[] }

/**
 * Calls that only look — reads, searches, listings, catalog queries — fold
 * into one Explored line. A read-only terminal command is one of them (the
 * card is kept for commands that change things).
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
  'lsp',
  'Skill',
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
  'cancel_agent_instance'
])

function stamp(iso: string | undefined): number | null {
  if (!iso) return null
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : null
}

function todoKey(todo: TodoItem): string {
  return todo.id ?? todo.content
}

/** A todo snapshot a tool left behind, or null when it wrote none. */
export function todoSnapshotOf(tool: ToolItem['tool']): TodoItem[] | null {
  if (tool.name === 'todo_write' && tool.status === 'done') {
    const parsed = parseTodoData(tool)
    return parsed.items.length > 0 ? parsed.items : null
  }
  // create_plan's result does not echo the todos it seeded; its arguments do.
  if (tool.name === 'create_plan' && tool.status === 'done') {
    const args = parseArgsRecord(tool.argsPreview)
    const todos = Array.isArray(args?.todos) ? args.todos : null
    if (!todos) return null
    const items: TodoItem[] = []
    for (const raw of todos) {
      if (!raw || typeof raw !== 'object') continue
      const row = raw as { id?: unknown; content?: unknown; status?: unknown }
      const content = typeof row.content === 'string' ? row.content.trim() : ''
      if (!content) continue
      const status =
        row.status === 'in_progress' || row.status === 'completed' || row.status === 'cancelled'
          ? row.status
          : 'pending'
      items.push({ ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}), content, status })
    }
    return items.length > 0 ? items : null
  }
  return null
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

type Bucket = { work: WorkItem[]; pending: ToolItem[] }

function newBucket(): Bucket {
  return { work: [], pending: [] }
}

/** Close a run of lookups into one explore line; cards and instances stand alone. */
function flush(bucket: Bucket): void {
  let group: ToolItem[] = []
  const closeGroup = (): void => {
    if (group.length === 0) return
    bucket.work.push({ kind: 'explore', id: `explore:${group[0]!.id}`, tools: group })
    group = []
  }
  for (const item of bucket.pending) {
    if (item.tool.name === 'create_plan') {
      closeGroup()
      bucket.work.push({ kind: 'plan', id: item.id, tool: item, title: planTitle(item.tool) })
      continue
    }
    if (INSTANCE_TOOLS.has(item.tool.name)) {
      closeGroup()
      bucket.work.push({ kind: 'instance', id: item.id, tool: item })
      continue
    }
    if (isProminentPresentation(item.tool)) {
      closeGroup()
      bucket.work.push({ kind: 'card', id: item.id, tool: item })
      continue
    }
    if (LOOKUP_TOOLS.has(item.tool.name)) {
      group.push(item)
      continue
    }
    closeGroup()
    bucket.work.push({ kind: 'tool', id: item.id, tool: item })
  }
  closeGroup()
  bucket.pending = []
}

type RunBuilder = {
  run: RecordRun
  setup: Bucket
  after: Bucket
  stepBuckets: Map<string, Bucket>
  /** Latest snapshot, in order. */
  todos: TodoItem[] | null
  /** Where work goes right now: a step key, 'setup' or 'after'. */
  target: string
  firstStarted: Map<string, number>
  lastCompleted: Map<string, number>
  /** Tool ids written while each step was in progress, for its edit summary. */
  stepTools: Map<string, ToolItem[]>
  lastAssistant: MessageItem | null
  /** The last item seen in this run was a run_error. */
  endedInError: boolean
}

function bucketFor(b: RunBuilder, key: string): Bucket {
  if (key === 'setup') return b.setup
  if (key === 'after') return b.after
  let bucket = b.stepBuckets.get(key)
  if (!bucket) {
    bucket = newBucket()
    b.stepBuckets.set(key, bucket)
  }
  return bucket
}

function current(b: RunBuilder): Bucket {
  return bucketFor(b, b.target)
}

function applySnapshot(b: RunBuilder, todos: TodoItem[], at: number | null): void {
  flush(current(b))
  const before = new Map((b.todos ?? []).map((todo) => [todoKey(todo), todo.status]))
  b.todos = todos
  for (const todo of todos) {
    const key = todoKey(todo)
    if (todo.status === 'in_progress' && at != null && !b.firstStarted.has(key)) b.firstStarted.set(key, at)
    // The moment it became completed — a later snapshot repeating it is not
    // when it finished. Reopened and completed again, the new moment counts.
    if (todo.status === 'completed' && at != null && before.get(key) !== 'completed') {
      b.lastCompleted.set(key, at)
    }
  }
  const active = todos.find((todo) => todo.status === 'in_progress')
  if (active) b.target = todoKey(active)
  else if (todos.every((todo) => todo.status === 'completed' || todo.status === 'cancelled')) b.target = 'after'
  // Every step pending: the plan exists but work has not started — still setup.
  else if (b.target !== 'after' && !b.stepBuckets.size) b.target = 'setup'
}

function startRun(n: number, user: MessageItem | null, id: string): RunBuilder {
  const at = stamp(user?.at)
  return {
    run: {
      n,
      id,
      text: user?.content ?? '',
      images: user?.images ?? [],
      attachments: user?.attachments ?? [],
      at,
      setup: [],
      steps: [],
      after: [],
      result: null,
      needs: [],
      startedAt: at,
      endedAt: at
    },
    setup: newBucket(),
    after: newBucket(),
    stepBuckets: new Map(),
    todos: null,
    target: 'setup',
    firstStarted: new Map(),
    lastCompleted: new Map(),
    stepTools: new Map(),
    lastAssistant: null,
    endedInError: false
  }
}

function touch(b: RunBuilder, at: number | null): void {
  if (at == null) return
  if (b.run.startedAt == null || at < b.run.startedAt) b.run.startedAt = at
  if (b.run.endedAt == null || at > b.run.endedAt) b.run.endedAt = at
}

function finishRun(b: RunBuilder, options: BuildOptions, isLast: boolean): RecordRun {
  flush(b.setup)
  flush(b.after)
  for (const bucket of b.stepBuckets.values()) flush(bucket)

  // The closing answer: the last thing the agent said, when no work came
  // after it. It leaves the work list and becomes the result — but only once
  // the run is over: mid-run narration is not an answer yet. (Runs are
  // finished in order, so `b.run.steps` is still empty here.)
  const live = isLast && options.running
  const last = live ? null : b.lastAssistant
  if (last) {
    for (const bucket of [b.after, ...b.stepBuckets.values(), b.setup]) {
      const at = bucket.work.findIndex((w) => w.kind === 'note' && w.item.id === last.id)
      if (at >= 0 && at === bucket.work.length - 1) {
        const note = bucket.work[at] as Extract<WorkItem, { kind: 'note' }>
        bucket.work.splice(at, 1)
        b.run.result = { item: last, text: note.text, streaming: Boolean(last.streaming) }
        break
      }
    }
  }

  const todos = b.todos ?? []
  b.run.steps = todos.map((todo, i) => {
    const key = todoKey(todo)
    let state = stepState(todo.status)
    // A step left in progress by a run that is over did not finish.
    if (state === 'running' && !live) state = isLast && options.failed ? 'failed' : 'stopped'
    const edits = editSummary(b.stepTools.get(key) ?? [])
    return {
      key,
      n: i + 1,
      title: todo.content,
      state,
      work: b.stepBuckets.get(key)?.work ?? [],
      startedAt: b.firstStarted.get(key) ?? null,
      endedAt: todo.status === 'completed' ? (b.lastCompleted.get(key) ?? null) : null,
      edits
    }
  })
  // With no plan there is no "before the steps": the work is the run's work.
  if (b.run.steps.length === 0) {
    b.run.setup = []
    b.run.after = [...b.setup.work, ...b.after.work]
  } else {
    b.run.setup = b.setup.work
    b.run.after = b.after.work
  }

  // A step waiting on you shows it; the card itself sits at the top.
  if (live) {
    for (const need of b.run.needs) {
      const step = b.run.steps.find((s) => s.key === need.stepKey)
      if (step && step.state === 'running') step.state = 'needs'
    }
  } else {
    b.run.needs = []
  }
  if (b.endedInError) b.run.endedInError = true
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
  /** The latest run ended in an error. */
  failed?: boolean
  /** Show reasoning as thought lines (the "Show thinking" setting). */
  showThinking?: boolean
  /**
   * The run's current todos from `todos.json`, fresher than any snapshot in the
   * items while a step is in flight. Only applied to the latest run, and only
   * once that run has written todos of its own.
   */
  liveTodos?: TodoItem[] | null
}

export function buildRecordModel(items: readonly UiItem[], options: BuildOptions): RecordModel {
  const runs: RecordRun[] = []
  let b: RunBuilder | null = null
  const questionGated = new Set<string>()
  for (const item of items) {
    if (item.kind === 'question' && item.question.toolCallId) questionGated.add(item.question.toolCallId)
  }

  const ensure = (id: string): RunBuilder => {
    if (!b) b = startRun(runs.length + 1, null, id)
    return b
  }

  for (const item of items) {
    if (item.kind === 'message' && item.role === 'user') {
      if (b) runs.push(finishRun(b, options, false))
      b = startRun(runs.length + 1, item, item.id)
      continue
    }
    const run = ensure(item.id)
    touch(run, stamp(item.at))
    // Anything after an error (a retry carrying on) means the run did not end there.
    run.endedInError = item.kind === 'run_error'

    if (item.kind === 'tool') {
      const snapshot = todoSnapshotOf(item.tool)
      if (item.tool.name === 'todo_write') {
        if (snapshot) applySnapshot(run, snapshot, stamp(item.at))
        continue
      }
      // Verdicts on done-when checks show with the checks, not as work.
      if (item.tool.name === 'check_done_when') continue
      if (item.approval) {
        run.run.needs.push({
          kind: 'approval',
          approval: item.approval,
          tool: item,
          stepKey: run.target === 'setup' || run.target === 'after' ? null : run.target,
          at: stamp(item.at)
        })
      }
      // Work after the agent spoke means that was not its closing answer.
      run.lastAssistant = null
      if (questionGated.has(item.id)) continue
      current(run).pending.push(item)
      if (run.target !== 'setup' && run.target !== 'after') {
        const list = run.stepTools.get(run.target) ?? []
        list.push(item)
        run.stepTools.set(run.target, list)
      }
      if (snapshot) applySnapshot(run, snapshot, stamp(item.at))
      continue
    }

    if (item.kind === 'question') {
      run.run.needs.push({
        kind: 'question',
        question: item.question,
        stepKey: run.target === 'setup' || run.target === 'after' ? null : run.target,
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
      run.lastAssistant = null
      flush(current(run))
      current(run).work.push({ kind: 'compaction', id: item.id, item })
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
    if (hasText) {
      current(run).work.push({ kind: 'note', id: message.id, item: message, text: text! })
      run.lastAssistant = message
    } else {
      run.lastAssistant = null
    }
  }

  if (b) {
    const last = b as RunBuilder
    // todos.json outlives the run that wrote it: a follow-up that made no plan
    // of its own must not wear the last run's steps. It freshens a plan only
    // once this run has written one.
    if (options.liveTodos && options.liveTodos.length > 0 && last.todos) {
      applySnapshot(last, options.liveTodos, null)
    }
    runs.push(finishRun(last, options, true))
  }
  return { runs }
}

/** The run's state for the header and history lines. */
export function runStateOf(run: RecordRun, isLast: boolean, options: BuildOptions): TaskState {
  if (isLast && options.running) return run.needs.length > 0 ? 'needs' : 'running'
  if (isLast && options.failed) return 'failed'
  if (run.endedInError) return 'failed'
  if (run.steps.some((s) => s.state === 'failed')) return 'failed'
  if (run.steps.some((s) => s.state === 'stopped') && !run.result) return 'stopped'
  return 'done'
}
