import type {
  CompactionVerifyStatus,
  UiAgentQuestion,
  UiItem,
  UiToolApproval
} from '@shared/transcript'
import {
  duplicatesReasoning,
  mergeThinkingContent,
  shouldRenderThinking,
  stripToolShapedAssistantText,
  stripToolShapedAssistantTextForStream
} from '@shared/transcript'
import type { TurnOutcome } from '@shared/transcript'
import { isProminentPresentation } from '../toolUi'
import { collectWritingChanges } from '../toolUi/parsers/edit'
import { parseDeleteData } from '../toolUi/parsers/delete'
import { compactActivityFromRows, deriveRunActivity, type RunActivityPhase } from './runActivity'
import { mergeChangedFileAction, normalizeRelPath, WRITING_TOOLS } from './turnFileDiffs'

export type { RunActivityPhase } from './runActivity'

export type MessageItem = Extract<UiItem, { kind: 'message' }>
export type UserItem = MessageItem & { role: 'user' }
export type AssistantItem = MessageItem & { role: 'assistant' }
export type ToolItem = Extract<UiItem, { kind: 'tool' }>

export type TranscriptRow =
  | { kind: 'user'; id: string; item: UserItem; turnIndex: number }
  | { kind: 'turn'; id: string; turnIndex: number; span: TurnSpan }
  | { kind: 'thinking'; id: string; item: AssistantItem; turnIndex: number }
  /** `final` marks the turn's closing answer, the one that earns a footer. */
  | { kind: 'text'; id: string; item: AssistantItem; turnIndex: number; final: boolean }
  | { kind: 'activity'; id: string; tools: ToolItem[]; turnIndex: number }
  | { kind: 'card'; id: string; item: ToolItem; turnIndex: number }
  | { kind: 'changes'; id: string; turnIndex: number; files: ChangedFile[] }
  | { kind: 'approval'; id: string; approval: UiToolApproval; turnIndex: number }
  | { kind: 'question'; id: string; question: UiAgentQuestion; turnIndex: number }
  | { kind: 'run_error'; id: string; message: string; code?: string; turnIndex: number }
  | {
      kind: 'compaction'
      id: string
      summary: string
      tokenEstimate?: number
      expanded?: boolean
      at?: string
      turnIndex: number
      verifyStatus?: CompactionVerifyStatus
      verifyFailures?: string[]
      verifyCoverage?: number
    }

export type ChangedFile = {
  path: string
  /** Line counts when known from tool args; absent for checkpoint-only paths. */
  added?: number
  removed?: number
  action?: 'created' | 'modified' | 'deleted'
}

export type TurnSpan = {
  startedAt: number | null
  endedAt: number | null
  /** Still producing output, so any duration is provisional. */
  active: boolean
  /** What the agent is doing while the turn is active. */
  activity?: RunActivityPhase | null
  /** Terminal network/provider failure on this turn. */
  failed?: boolean
  failureLabel?: string
  /** Terminal outcome for the latest turn. */
  status?: TurnOutcome
}

/**
 * Rows a turn summary stands for, and therefore hides when it is collapsed.
 * Mid-turn narration is part of the work; only the closing answer survives.
 * Approval prompts must stay visible — collapsing them deadlocks a running turn
 * (composer locked, no Allow/Deny).
 */
export function isTurnWorkRow(row: TranscriptRow): boolean {
  if (row.kind === 'approval' || row.kind === 'question') return false
  // Collapsed turns rely on TurnSummary for live phase; hide cards/activity so
  // tool chrome is not shown beside the collapsed timeline label.
  if (row.kind === 'thinking' || row.kind === 'activity' || row.kind === 'card') {
    return true
  }
  return row.kind === 'text' && !row.final
}

/** True when the turn has activity/card rows (real tool chrome in the timeline). */
export function turnHasVisibleToolWork(
  rows: readonly TranscriptRow[],
  turnIndex: number
): boolean {
  return rows.some(
    (row) =>
      row.turnIndex === turnIndex && (row.kind === 'activity' || row.kind === 'card')
  )
}

/** Closing answer with text — that row owns the finished receipt footer. */
export function turnHasClosingAnswer(
  rows: readonly TranscriptRow[],
  turnIndex: number
): boolean {
  return rows.some(
    (row) =>
      row.kind === 'text' &&
      row.final &&
      row.turnIndex === turnIndex &&
      Boolean(row.item.content?.trim())
  )
}

/** Extra lead-in above a user prompt that opens a new turn (matches TRANSCRIPT_TURN_GAP). */
export const TURN_GAP_PX = 32

/** Tools whose output is worth a dedicated card instead of a group line. */
function isCardTool(item: ToolItem): boolean {
  return isProminentPresentation(item.tool)
}

function isStandaloneActivityTool(item: ToolItem): boolean {
  return (
    item.tool.name === 'spawn_agent_instance' ||
    item.tool.name === 'await_agent_instance' ||
    item.tool.name === 'pull_agent_instance' ||
    item.tool.name === 'merge_agent_instance'
  )
}

/**
 * Build turn-aware transcript rows.
 *
 * Consecutive lookup-style calls collapse into one activity row, while a call
 * whose output is the point — a command, an edit — breaks out into its own card
 * where the reader can see it without opening anything. Assistant narration
 * stays where it happened, which also separates the groups on either side of it.
 */
export function buildTranscriptRows(
  items: UiItem[],
  options?: {
    pendingRun?: boolean
    running?: boolean
    showThinking?: boolean
    networkWait?: {
      attempt: number
      maxAttempts: number
      retryInMs: number
      code?: string
    } | null
    compacting?: boolean
    turnFailed?: boolean
    turnFailureLabel?: string | null
    turnStatus?: TurnOutcome | null
  }
): TranscriptRow[] {
  const rows: TranscriptRow[] = []
  let turnIndex = -1
  let pending: ToolItem[] = []
  const includeThinking = options?.showThinking !== false
  const hiddenThinkingStreamingTurns = new Set<number>()
  const todoWriteRunningTurns = new Set<number>()
  // Single O(items) pass so per-tool gating lookups below stay O(1).
  const questionGatedToolIds = new Set<string>()
  for (const entry of items) {
    if (entry.kind === 'question' && entry.question.toolCallId) {
      questionGatedToolIds.add(entry.question.toolCallId)
    }
  }

  const flush = (): void => {
    const run = pending
    pending = []
    let group: ToolItem[] = []

    const closeGroup = (): void => {
      if (!group.length) return
      rows.push({ kind: 'activity', id: `activity:${group[0]!.id}`, tools: group, turnIndex })
      group = []
    }

    const emitTool = (item: ToolItem): void => {
      // A gated call waits on the reader — show only the approval card, not a
      // parallel "Working…" tool chrome for the same call.
      if (item.approval) {
        closeGroup()
        rows.push({
          kind: 'approval',
          id: `approval:${item.approval.requestId}`,
          approval: item.approval,
          turnIndex: Math.max(turnIndex, 0)
        })
        return
      }
      if (isCardTool(item)) {
        closeGroup()
        rows.push({ kind: 'card', id: item.id, item, turnIndex })
        return
      }
      if (isStandaloneActivityTool(item)) {
        closeGroup()
        const compactItem =
          item.tool.status === 'running' && item.toolExpanded == null
            ? { ...item, toolExpanded: false }
            : item
        rows.push({ kind: 'activity', id: `activity:${item.id}`, tools: [compactItem], turnIndex })
        return
      }
      group.push(item)
    }

    for (const item of run) {
      emitTool(item)
    }
    closeGroup()
  }

  for (const item of items) {
    if (item.kind === 'question') {
      flush()
      rows.push({
        kind: 'question',
        id: item.id,
        question: item.question,
        turnIndex: Math.max(turnIndex, 0)
      })
      continue
    }
    if (item.kind === 'run_error') {
      flush()
      rows.push({
        kind: 'run_error',
        id: item.id,
        message: item.message,
        ...(item.code ? { code: item.code } : {}),
        turnIndex: Math.max(turnIndex, 0)
      })
      continue
    }
    if (item.kind === 'compaction') {
      flush()
      rows.push({
        kind: 'compaction',
        id: item.id,
        summary: item.summary,
        ...(item.tokenEstimate != null ? { tokenEstimate: item.tokenEstimate } : {}),
        ...(item.expanded != null ? { expanded: item.expanded } : {}),
        ...(item.at ? { at: item.at } : {}),
        ...(item.verifyStatus ? { verifyStatus: item.verifyStatus } : {}),
        ...(item.verifyFailures && item.verifyFailures.length > 0
          ? { verifyFailures: item.verifyFailures }
          : {}),
        ...(item.verifyCoverage != null ? { verifyCoverage: item.verifyCoverage } : {}),
        turnIndex: Math.max(turnIndex, 0)
      })
      continue
    }
    if (item.kind === 'tool') {
      // Capture before coalesceTodoWrites strips running todo_write rows.
      if (item.tool.name === 'todo_write' && item.tool.status === 'running') {
        todoWriteRunningTurns.add(Math.max(turnIndex, 0))
      }
      // `questionGatedToolIds` is built once per pass below; the previous
      // `items.some(...)` here was an O(items) scan inside the O(items) item
      // loop, i.e. O(items²) on every streamed frame.
      if (!questionGatedToolIds.has(item.id)) pending.push(item)
      continue
    }

    if (item.kind === 'message' && item.role === 'user') {
      flush()
      turnIndex += 1
      rows.push({ kind: 'user', id: item.id, item: item as UserItem, turnIndex })
      continue
    }

    const assistant = item as AssistantItem
    const showThinking =
      includeThinking &&
      shouldRenderThinking(assistant.thinking, assistant.thinkingStreaming)
    const cleanedContent = assistant.streaming
      ? stripToolShapedAssistantTextForStream(assistant.content)
      : stripToolShapedAssistantText(assistant.content)
    const showContent = Boolean(
      cleanedContent?.trim() &&
        !duplicatesReasoning({ ...assistant, content: cleanedContent })
    )
    if (assistant.thinkingStreaming && !showThinking) {
      // Timeline/aria still show Thinking while the block is hidden (setting off
      // or streaming before meaningful text arrives).
      hiddenThinkingStreamingTurns.add(Math.max(turnIndex, 0))
    }
    // A row with nothing to show must not split the stretch around it, or the
    // transcript stacks identical group headers with no separator between them.
    if (!showThinking && !showContent) continue

    flush()
    if (showThinking) {
      const last = rows[rows.length - 1]
      if (
        last?.kind === 'thinking' &&
        last.turnIndex === turnIndex &&
        !last.item.thinkingStreaming &&
        !assistant.thinkingStreaming
      ) {
        const merged = mergeThinkingContent(
          [last.item.thinking, assistant.thinking].filter(Boolean) as string[]
        )
        rows[rows.length - 1] = {
          kind: 'thinking',
          id: last.id,
          item: { ...last.item, thinking: merged, thinkingStreaming: assistant.thinkingStreaming },
          turnIndex
        }
      } else {
        rows.push({ kind: 'thinking', id: `${assistant.id}:thinking`, item: assistant, turnIndex })
      }
    }
    if (showContent) {
      rows.push({
        kind: 'text',
        id: assistant.id,
        item: cleanedContent === assistant.content ? assistant : { ...assistant, content: cleanedContent },
        turnIndex,
        final: false
      })
    }
  }

  flush()
  // Turn summaries stand for the work rows, and which text row is the closing
  // answer decides what counts as work, so that has to be settled first.
  // Reasoning stays in step order (thinking → tools → thinking) — do not hoist
  // every step into one Thought at the top of the turn. Do not fold activity
  // groups across thinking separators (that scrambled chronology).
  return withTurnSummaries(
    withChangeSummaries(coalesceTodoWrites(markFinalText(rows)), {
      pendingRun: options?.pendingRun,
      running: options?.running
    }),
    {
      pendingRun: options?.pendingRun,
      running: options?.running,
      hiddenThinkingStreamingTurns,
      todoWriteRunningTurns,
      networkWait: options?.networkWait,
      compacting: options?.compacting,
      turnFailed: options?.turnFailed,
      turnFailureLabel: options?.turnFailureLabel,
      turnStatus: options?.turnStatus
    }
  )
}

function activityFingerprint(activity: RunActivityPhase | null | undefined): string {
  if (!activity) return ''
  if (activity.kind === 'tool') {
    return `tool:${activity.label}:${activity.detail ?? ''}`
  }
  return activity.kind
}

/** Cheap content identity for React.memo reuse — length alone hides same-length replacements. */
function contentFingerprint(content: string): string {
  const len = content.length
  if (len <= 48) return content
  const mid = Math.floor(len / 2)
  const midStart = Math.max(0, mid - 8)
  return `${len}:${content.slice(0, 16)}:${content.slice(midStart, midStart + 16)}:${content.slice(-16)}`
}

/** Fingerprint of a row's visible content for React.memo identity reuse. */
export function transcriptRowFingerprint(row: TranscriptRow): string {
  switch (row.kind) {
    case 'user':
      return `user:${row.id}:${contentFingerprint(row.item.content)}:${row.item.at ?? ''}`
    case 'turn':
      return `turn:${row.id}:${row.span.startedAt}:${row.span.endedAt}:${row.span.active}:${activityFingerprint(row.span.activity)}`
    case 'thinking':
      return `thinking:${row.id}:${contentFingerprint(row.item.thinking ?? '')}:${row.item.thinkingStreaming ? 1 : 0}:${row.item.thinkingExpanded ?? ''}`
    case 'text':
      return `text:${row.id}:${contentFingerprint(row.item.content)}:${row.item.streaming ? 1 : 0}:${row.final ? 1 : 0}`
    case 'activity':
      return `activity:${row.id}:${row.tools
        .map((t) => {
          const sub = t.toolProgress?.length ?? 0
          const subLast = t.toolProgress?.[t.toolProgress.length - 1]
          return [
            t.id,
            t.tool.status,
            t.tool.argsPreview?.length ?? 0,
            contentFingerprint(t.tool.content ?? ''),
            t.tool.contentTruncated ? 1 : 0,
            t.tool.summary,
            t.groupExpanded ?? '',
            t.toolExpanded ?? '',
            sub,
            subLast ? `${subLast.kind}:${contentFingerprint(subLast.text)}` : ''
          ].join(':')
        })
        .join('|')}`
    case 'card': {
      const t = row.item
      const sub = t.toolProgress?.length ?? 0
      const subLast = t.toolProgress?.[t.toolProgress.length - 1]
      return [
        'card',
        row.id,
        t.tool.status,
        t.tool.argsPreview?.length ?? 0,
        contentFingerprint(t.tool.content ?? ''),
        t.tool.contentTruncated ? 1 : 0,
        t.tool.summary,
        t.toolExpanded ?? '',
        sub,
        subLast ? `${subLast.kind}:${contentFingerprint(subLast.text)}` : ''
      ].join(':')
    }
    case 'changes':
      return `changes:${row.id}:${row.files.map((f) => `${f.path}:${f.added ?? 0}:${f.removed ?? 0}:${f.action ?? ''}`).join('|')}`
    case 'approval':
      return `approval:${row.id}:${row.approval.requestId}`
    case 'question': {
      const q = row.question
      const shape = [
        q.title ?? '',
        ...q.questions.map(
          (item) =>
            `${item.id}\0${item.prompt}\0${item.type}\0${item.allowCustom ? 1 : 0}\0${(item.options ?? []).join('\u001f')}`
        )
      ].join('\n')
      return `question:${row.id}:${q.requestId}:${shape}`
    }
    case 'run_error':
      return `run_error:${row.id}:${row.message}:${row.code ?? ''}`
    case 'compaction':
      return `compaction:${row.id}:${contentFingerprint(row.summary)}:${row.expanded ?? ''}:${row.tokenEstimate ?? ''}:${row.verifyStatus ?? ''}:${(row.verifyFailures ?? []).join('\u001f')}:${row.verifyCoverage ?? ''}`
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

/**
 * Reuse previous TranscriptRow object references when fingerprints match so
 * React.memo(TranscriptRowBlock) can skip historical rows during streaming.
 */
export function stabilizeTranscriptRows(
  previous: readonly TranscriptRow[] | null | undefined,
  next: TranscriptRow[]
): TranscriptRow[] {
  if (!previous?.length) return next
  const prevById = new Map(previous.map((row) => [row.id, row]))
  let changed = previous.length !== next.length
  const out = next.map((row, index) => {
    const prior = prevById.get(row.id) ?? previous[index]
    // Streaming rows always re-derive: a fingerprint collision must not freeze
    // live content onto a stale row object. Mirror text `streaming` for thinking.
    const live =
      ((row.kind === 'text' || row.kind === 'thinking') &&
        (row.item.streaming === true || row.item.thinkingStreaming === true)) ||
      ((row.kind === 'activity' || row.kind === 'card') &&
        (row.kind === 'activity'
          ? row.tools.some((t) => t.tool.status === 'running')
          : row.item.tool.status === 'running')) ||
      (row.kind === 'compaction' &&
        (row.verifyStatus === 'verifying' || row.verifyStatus === 'retrying'))
    if (
      !live &&
      prior &&
      prior.kind === row.kind &&
      transcriptRowFingerprint(prior) === transcriptRowFingerprint(row)
    ) {
      return prior
    }
    changed = true
    return row
  })
  return changed ? out : (previous as TranscriptRow[])
}

/** Tools that write files, and so contribute to a turn's change summary. */

function writingToolChanges(item: ToolItem): ChangedFile[] {
  if (!WRITING_TOOLS.has(item.tool.name) || item.tool.status !== 'done') return []
  if (item.tool.name === 'delete') {
    const { path } = parseDeleteData(item.tool)
    if (!path) return []
    return [{ path, added: 0, removed: 1, action: 'deleted' }]
  }
  return collectWritingChanges(item.tool)
}

function turnToolItems(row: TranscriptRow): ToolItem[] {
  if (row.kind === 'card') return [row.item]
  if (row.kind === 'activity') return row.tools
  return []
}

/**
 * Close a turn that touched files with a rollup of what changed.
 * Transcript emits a compact receipt; Keep/Discard lives in the Changes panel.
 * Defer the live turn's card until the run settles — mid-run it reads as
 * "work is done" while Investigating / more tools are still going.
 */
function withChangeSummaries(
  rows: TranscriptRow[],
  options?: { pendingRun?: boolean; running?: boolean }
): TranscriptRow[] {
  const live = options?.pendingRun === true || options?.running === true
  let lastTurnIndex = -1
  for (const row of rows) {
    if (row.turnIndex > lastTurnIndex) lastTurnIndex = row.turnIndex
  }

  const out: TranscriptRow[] = []
  let index = 0

  while (index < rows.length) {
    const turnIndex = rows[index]!.turnIndex
    const turnRows: TranscriptRow[] = []
    while (index < rows.length && rows[index]!.turnIndex === turnIndex) {
      turnRows.push(rows[index]!)
      index += 1
    }

    const totals = new Map<string, ChangedFile>()
    for (const row of turnRows) {
      for (const item of turnToolItems(row)) {
        for (const change of writingToolChanges(item)) {
          const key = normalizeRelPath(change.path)
          const existing = totals.get(key)
          if (existing) {
            existing.added = (existing.added ?? 0) + (change.added ?? 0)
            existing.removed = (existing.removed ?? 0) + (change.removed ?? 0)
            existing.action = mergeChangedFileAction(existing.action, change.action)
            if (!existing.action) delete existing.action
          } else {
            totals.set(key, { ...change, path: key })
          }
        }
      }
    }

    // Files Changed is the turn receipt — after work and closing answer, not between them.
    out.push(...turnRows)

    // Prior turns in a multi-turn run still get their receipt; only the
    // active last turn waits until the agent stops.
    if (totals.size >= 1 && !(live && turnIndex === lastTurnIndex)) {
      out.push({
        kind: 'changes',
        id: `changes:${turnIndex}`,
        turnIndex,
        files: [...totals.values()].sort((a, b) => a.path.localeCompare(b.path))
      })
    }
  }

  return out
}

/**
 * Drop successful/running todo_write rows from the transcript — the pinned
 * Tasks band (under the current user prompt) and Plan Tasks section own the
 * checklist. Keep failures so errors remain visible inline.
 */
function coalesceTodoWrites(rows: TranscriptRow[]): TranscriptRow[] {
  const out: TranscriptRow[] = []
  for (const row of rows) {
    if (row.kind === 'activity') {
      const tools = row.tools.filter(
        (item) => item.tool.name !== 'todo_write' || item.tool.status === 'fail'
      )
      if (tools.length === 0) continue
      out.push(tools.length === row.tools.length ? row : { ...row, tools })
      continue
    }
    if (
      row.kind === 'card' &&
      row.item.tool.name === 'todo_write' &&
      row.item.tool.status !== 'fail'
    ) {
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * Index where the closing answer begins: a trailing run of text rows only.
 * Mid-turn narration followed by tools is not closing, so it stays out of this suffix.
 * Trailing Files Changed receipts are skipped so they do not hide the answer.
 */
function closingAnswerStart(turnRows: TranscriptRow[]): number {
  let end = turnRows.length
  while (
    end > 0 &&
    (turnRows[end - 1]!.kind === 'changes' || turnRows[end - 1]!.kind === 'compaction')
  ) {
    end -= 1
  }
  let index = end
  while (index > 0 && turnRows[index - 1]!.kind === 'text') {
    index -= 1
  }
  return index
}

/** Only trailing answer text earns a footer; earlier narration stays mid-turn work. */
function markFinalText(rows: TranscriptRow[]): TranscriptRow[] {
  const rowsByTurn = new Map<number, TranscriptRow[]>()
  for (const row of rows) {
    if (row.kind === 'user') continue
    const list = rowsByTurn.get(row.turnIndex) ?? []
    list.push(row)
    rowsByTurn.set(row.turnIndex, list)
  }
  if (rowsByTurn.size === 0) return rows

  const finalTextIds = new Set<string>()
  for (const turnRows of rowsByTurn.values()) {
    const start = closingAnswerStart(turnRows)
    const closing = turnRows.slice(start).filter((row) => row.kind === 'text')
    const last = closing[closing.length - 1]
    if (last?.kind === 'text') finalTextIds.add(last.id)
  }

  return rows.map((row) =>
    row.kind === 'text' ? { ...row, final: finalTextIds.has(row.id) } : row
  )
}

export function timestampMs(iso: string | undefined): number | null {
  if (!iso) return null
  const ms = new Date(iso).getTime()
  return Number.isNaN(ms) ? null : ms
}

function rowTimestamps(row: TranscriptRow): { at: number | null; endedAt: number | null } {
  switch (row.kind) {
    case 'user':
    case 'thinking':
    case 'text':
      return { at: timestampMs(row.item.at), endedAt: null }
    case 'card':
      return { at: timestampMs(row.item.at), endedAt: row.item.groupTiming?.endedAt ?? null }
    case 'activity': {
      let at: number | null = null
      let endedAt: number | null = null
      for (const tool of row.tools) {
        const started = timestampMs(tool.at) ?? tool.groupTiming?.startedAt ?? null
        if (started != null) at = at == null ? started : Math.min(at, started)
        const ended = tool.groupTiming?.endedAt ?? null
        if (ended != null) endedAt = endedAt == null ? ended : Math.max(endedAt, ended)
      }
      return { at, endedAt }
    }
    case 'turn':
    case 'changes':
    case 'approval':
    case 'question':
    case 'run_error':
      return { at: null, endedAt: null }
    case 'compaction':
      return { at: timestampMs(row.at), endedAt: null }
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

function isRowActive(row: TranscriptRow): boolean {
  switch (row.kind) {
    case 'thinking':
    case 'text':
      return row.item.streaming === true || row.item.thinkingStreaming === true
    case 'card':
      return row.item.tool.status === 'running'
    case 'activity':
      return row.tools.some((tool) => tool.tool.status === 'running')
    case 'approval':
    case 'question':
      return true
    case 'user':
    case 'turn':
    case 'changes':
    case 'run_error':
    case 'compaction':
      return false
    default: {
      const _exhaustive: never = row
      return _exhaustive
    }
  }
}

/**
 * Append a turn summary after all turn rows (work + closing answer).
 *
 * Bottom placement keeps the live "Working · …" line near the composer when the
 * transcript is pinned to the tail — not above a streaming closing answer.
 *
 * The span runs from the prompt to the last thing the turn produced, which is
 * the interval a reader means by "how long did that take" — not the sum of the
 * individual tool durations, which would exclude the model's own thinking.
 */
function withTurnSummaries(
  rows: TranscriptRow[],
  options?: {
    pendingRun?: boolean
    running?: boolean
    hiddenThinkingStreamingTurns?: ReadonlySet<number>
    todoWriteRunningTurns?: ReadonlySet<number>
    networkWait?: {
      attempt: number
      maxAttempts: number
      retryInMs: number
      code?: string
    } | null
    compacting?: boolean
    turnFailed?: boolean
    turnFailureLabel?: string | null
    turnStatus?: TurnOutcome | null
  }
): TranscriptRow[] {
  const pendingRun = options?.pendingRun
  const running = options?.running
  const hiddenThinkingStreamingTurns = options?.hiddenThinkingStreamingTurns
  const todoWriteRunningTurns = options?.todoWriteRunningTurns
  const turnStatus = options?.turnStatus
  let maxTurnIndex = -1
  for (const row of rows) {
    if (row.kind === 'user') maxTurnIndex = Math.max(maxTurnIndex, row.turnIndex)
  }

  const out: TranscriptRow[] = []
  let index = 0

  while (index < rows.length) {
    const row = rows[index]!
    if (row.kind !== 'user') {
      out.push(row)
      index += 1
      continue
    }

    const userRow = row
    out.push(userRow)
    index += 1

    const turnIndex = userRow.turnIndex
    const turnRows: TranscriptRow[] = []
    while (index < rows.length && rows[index]!.turnIndex === turnIndex) {
      turnRows.push(rows[index]!)
      index += 1
    }

    const isLastTurn = turnIndex === maxTurnIndex
    const hasWork = turnRows.some(isTurnWorkRow)
    const isLiveTurn = isLastTurn && (pendingRun === true || running === true)

    // Live expanded: turn summary rides the end of work (inline in the timeline).
    // Collapsed view still shows it under the prompt because work rows are filtered out.
    // Closing answer + Files Changed stay after the summary.
    const closingStart = closingAnswerStart(turnRows)
    out.push(...turnRows.slice(0, closingStart))

    const terminalStatus =
      isLastTurn && !isLiveTurn
        ? turnStatus ?? (options?.turnFailed === true ? 'error' : 'done')
        : undefined

    if (hasWork || isLiveTurn || (terminalStatus != null && terminalStatus !== 'done')) {
      const startedAt = timestampMs(userRow.item.at)
      let endedAt: number | null = null
      for (const entry of turnRows) {
        const { at, endedAt: closed } = rowTimestamps(entry)
        for (const candidate of [at, closed]) {
          if (candidate != null) endedAt = endedAt == null ? candidate : Math.max(endedAt, candidate)
        }
      }

      // Only a live turn (last turn of a pending/running run) is active. Rows
      // left at status 'running' by a dead run render as finished, timed by
      // their own timestamps — otherwise a corpse turn shimmers forever.
      const rowActive = turnRows.some(isRowActive)
      const active = isLiveTurn
      const activity = active
        ? options?.compacting
          ? compactActivityFromRows(rows)
          : options?.networkWait
            ? {
                kind: 'reconnecting' as const,
                attempt: options.networkWait.attempt,
                maxAttempts: options.networkWait.maxAttempts
              }
            : deriveRunActivity(turnRows, isLiveTurn && !rowActive && turnRows.length === 0, {
                hiddenThinkingStreaming: hiddenThinkingStreamingTurns?.has(turnIndex) === true,
                todoWriteRunning: todoWriteRunningTurns?.has(turnIndex) === true
              })
        : null
      const failed = terminalStatus === 'error'
      // A run_error row in this turn already renders the full message — the
      // summary falls back to TurnSummary's short "Failed" instead of repeating it.
      const turnHasRunError = turnRows.some((row) => row.kind === 'run_error')
      const failureLabel =
        failed && !turnHasRunError
          ? options?.turnFailureLabel?.trim() || 'Failed'
          : undefined

      out.push({
        kind: 'turn',
        id: `turn:${userRow.id}`,
        turnIndex,
        span: {
          startedAt,
          endedAt,
          active,
          activity,
          ...(terminalStatus ? { status: terminalStatus } : {}),
          ...(failed ? { failed: true, failureLabel } : {})
        }
      })
    }

    out.push(...turnRows.slice(closingStart))
  }

  return out
}

/** Leading space a row reserves for turn separation. */
export function rowLeadingGap(row: TranscriptRow): number {
  return row.kind === 'user' && row.turnIndex > 0 ? TURN_GAP_PX : 0
}
