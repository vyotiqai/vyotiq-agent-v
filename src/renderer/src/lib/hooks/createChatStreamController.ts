import type {
  AgentEvent,
  AgentInteractionMode,
  AttachedFile,
  ComposerSendExtras,
  ChatMessage,
  ChatRewindPreviewResult,
  IncompleteReason,
  PersistedEvent,
  ToolApprovalDecision,
  ToolApprovalRequest,
  AgentQuestionAnswer,
  AgentQuestionRequest
} from '@shared/ipc'
import {
  emptyStepUsageTotals,
  mergeStepUsageTotals,
  stepUsageFromEvent,
  type StepUsageTotals
} from '@shared/utils/runTelemetry'
import { getFocusedFile } from '@renderer/lib/focusedFile'
import {
  alignTurnUsageSlots,
  turnUsageFromPersistedEvents,
  userMessageAts,
  userTurnCount
} from '@shared/utils/turnUsage'
import type { AgentInstanceUiState } from '@shared/utils/agentInstance'
import {
  mergeAgentInstanceMaps,
  mergeAgentInstanceUpdate
} from '@shared/utils/mergeAgentInstanceUpdate'
import {
  buildUserContent,
  contentDisplayText,
  contentImages,
  type MessageContent
} from '@shared/ipc'
import {
  appendAssistantWithTools,
  appendToolResult,
  messagesForNextTurn
} from '@shared/chatHistory'
import { isAgentEvent } from '@shared/eventUtils'
import { toLogErr, isRetryableTurnFailure } from '@shared/errors'
import { logger } from '@shared/logger'
import {
  messagesToUiItems,
  applyEventTimestamps,
  applyCompactionItems,
  insertCompactionItem,
  weaveCompactionItems,
  applyPersistedLiveTools,
  dropNeverStartedRunningTools,
  finalizeHydratedTranscript,
  applyThinkingSnapshot,
  messageUiId,
  lastPersistedRunStatus,
  isToolShapedTextLeak,
  scrubStreamingAssistantToolLeak,
  stripToolShapedAssistantText,
  stripToolShapedAssistantTextForStream,
  uiAttachments,
  MAX_TOOL_PROGRESS_ENTRIES,
  LIVE_COMPACTION_ID,
  type UiItem,
  type UiToolProgressEntry,
  type UiToolRow,
  type TurnOutcome
} from '@shared/transcript'
import { isUnresolvedToolName, summarizeToolArgs } from '@shared/toolSummary'
import { mergeOpenAiCompatToolArgDelta } from '@shared/utils/toolArgDelta'
import {
  finalizeTodoContentOnRunEnd,
  type TodoFinalizeOutcome
} from '@shared/utils/todoContent'
import { truncateToolArgsPreview, TOOL_RESULT_IPC_PREVIEW_CHARS } from '@shared/utils/toolResultIpc'
import { toolPresentation } from '@renderer/features/chat/toolUi/meta'
import type { ContextUsageState } from '@shared/utils/contextUsage'
import {
  contextUsageFromEvent,
  summarizeContextUsageFromEvents
} from '@shared/utils/contextUsage'

const CHAT_START_MAX_ATTEMPTS = 3
const CHAT_START_RETRY_MS = 500
import {
  contentWindowFromRaw,
  remainingContentTokens
} from '@shared/domain/contextBudget'
import { recordUiResume, recordUiSuspendSkip } from './chatUiPerf'

/** Tool progress is a live view, not a log; keep the recent tail. */
const CANCEL_RECOVERY_POLL_MS = 500
const CANCEL_RECOVERY_TIMEOUT_MS = 5_000
/** Background retry window when Stop fails but main keeps the run alive. */
const CANCEL_BACKGROUND_RETRY_MS = 45_000
const CANCEL_BACKGROUND_RETRY_EVERY_MS = 5_000

/** Writing tools need full args for the Changes panel diffs; everything else is capped. */
const KEEP_FULL_ARGS_TOOLS = new Set(['edit', 'str_replace', 'delete'])

function argsPreviewForUi(name: string, args: string): string {
  // Edit/write tools parse diffs from argsPreview while running. Capping at
  // 4000 chars froze the peek on the head of the file until finalize, then
  // dumped the rest in one paint.
  if (KEEP_FULL_ARGS_TOOLS.has(name)) return args
  return truncateToolArgsPreview(args)
}

function withPresentationLock(tool: UiToolRow, name: string, argsPreview?: string): UiToolRow {
  const resolvedName = name && name !== 'tool' ? name : tool.name && tool.name !== 'tool' ? tool.name : ''
  // OpenAI often sends nameless first deltas; locking on placeholder "tool" would
  // permanently demote terminal/edit/etc. to compact.
  if (!resolvedName) return tool
  const preview = argsPreview ?? tool.argsPreview
  const summary = tool.summary
  if (tool.presentation && tool.name && tool.name !== 'tool') {
    // Recompute terminal when args/summary arrive so read-only commands can demote.
    if (resolvedName === 'terminal') {
      return { ...tool, presentation: toolPresentation(resolvedName, preview, summary) }
    }
    return tool
  }
  return { ...tool, presentation: toolPresentation(resolvedName, preview, summary) }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Prefer event.code from main; fall back for older events without a code. */
function agentErrorCode(event: Extract<AgentEvent, { type: 'error' }>): string {
  if (event.code) return event.code
  return 'AGENT_LOOP'
}

function trailingToolGroupStart(items: UiItem[]): number {
  if (!items.length || items[items.length - 1].kind !== 'tool') return -1
  let start = items.length - 1
  while (start > 0 && items[start - 1].kind === 'tool') start--
  return start
}

function toolStretchEnd(items: UiItem[], start: number): number {
  let end = start
  while (end < items.length && items[end].kind === 'tool') end++
  return end
}

function trailingLiveToolGroupStart(items: UiItem[]): number {
  const start = trailingToolGroupStart(items)
  if (start < 0) return -1
  const first = items[start]
  if (first.kind !== 'tool' || first.groupTiming?.endedAt) return -1
  return start
}

/**
 * Only insert preamble text before live tools when tools arrived before any
 * assistant text in the same turn. If a finalized assistant precedes live tools,
 * new text belongs to the next turn and must stay after those tools.
 */
function shouldInsertTextBeforeLiveTools(items: UiItem[]): boolean {
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart < 0) return false

  for (let i = liveStart - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'message' && item.role === 'assistant') {
      return item.streaming === true
    }
    if (item.kind === 'message' && item.role === 'user') {
      return true
    }
    if (item.kind === 'tool') {
      return false
    }
  }
  return true
}

function insertAssistantItem(items: UiItem[], next: Extract<UiItem, { kind: 'message' }>): UiItem[] {
  if (shouldInsertTextBeforeLiveTools(items)) {
    return insertBeforeTrailingTools(items, next)
  }
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart >= 0) {
    const end = toolStretchEnd(items, liveStart)
    return [...items.slice(0, end), next, ...items.slice(end)]
  }
  return prependClosed(items, next)
}

function closeOpenGroupTimings(items: UiItem[], endedAt = Date.now()): UiItem[] {
  const start = trailingLiveToolGroupStart(items)
  if (start < 0) return items
  const first = items[start]
  if (first.kind !== 'tool') return items
  return items.map((item, i) => {
    if (i !== start || item.kind !== 'tool') return item
    return {
      ...item,
      groupTiming: {
        startedAt: item.groupTiming?.startedAt ?? endedAt,
        endedAt
      }
    }
  })
}

function prependClosed(items: UiItem[], next: UiItem | UiItem[]): UiItem[] {
  const closed = closeOpenGroupTimings(items)
  return Array.isArray(next) ? [...closed, ...next] : [...closed, next]
}

/**
 * Place same-turn preamble text before tools that arrived first and are still live.
 * Completed tool stretches stay chronological — next iteration text appends after them.
 */
function insertBeforeTrailingTools(items: UiItem[], next: UiItem | UiItem[]): UiItem[] {
  const batch = Array.isArray(next) ? next : [next]
  const liveStart = trailingLiveToolGroupStart(items)
  if (liveStart >= 0) {
    return [...items.slice(0, liveStart), ...batch, ...items.slice(liveStart)]
  }
  return [...closeOpenGroupTimings(items), ...batch]
}

/**
 * Where to splice a new tool row into the transcript.
 * Prefer the stretch after the latest user message when that user sits after the
 * last assistant (follow-up / continue) — otherwise tools land before the bubble
 * and inherit the previous turnIndex.
 */
function toolInsertIndex(items: UiItem[]): number {
  let lastUser = -1
  let lastAssistant = -1
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind !== 'message') continue
    if (lastUser < 0 && item.role === 'user') lastUser = i
    if (lastAssistant < 0 && item.role === 'assistant') lastAssistant = i
    if (lastUser >= 0 && lastAssistant >= 0) break
  }

  if (lastUser > lastAssistant) {
    let insertAt = lastUser + 1
    while (insertAt < items.length && items[insertAt]?.kind === 'tool') insertAt++
    return insertAt
  }

  if (lastAssistant < 0) return items.length
  let insertAt = lastAssistant + 1
  while (insertAt < items.length && items[insertAt]?.kind === 'tool') insertAt++
  return insertAt
}

function appendTool(
  prev: UiItem[],
  toolItem: Extract<UiItem, { kind: 'tool' }>,
  runStartedAt?: number | null
): UiItem[] {
  const insertAt = toolInsertIndex(prev)
  const before = insertAt > 0 ? prev[insertAt - 1] : undefined
  const prevGroupClosed =
    before?.kind === 'tool' && before.groupTiming?.endedAt != null
  const isNewGroup = !before || before.kind !== 'tool' || prevGroupClosed
  const firstToolInRun = !prev.some((item) => item.kind === 'tool')
  const startedAt =
    isNewGroup && firstToolInRun && runStartedAt != null ? runStartedAt : Date.now()

  const row: Extract<UiItem, { kind: 'tool' }> = isNewGroup
    ? { ...toolItem, groupTiming: { startedAt } }
    : toolItem

  return [...prev.slice(0, insertAt), row, ...prev.slice(insertAt)]
}

function ensureToolRowsForCalls(
  items: UiItem[],
  toolCalls: Array<{ id: string; name: string; arguments: string }> | undefined,
  runStartedAt?: number | null
): UiItem[] {
  if (!toolCalls?.length) return items
  let next = items
  for (const tc of toolCalls) {
    const summary = summarizeToolArgs(tc.name, tc.arguments)
    const argsPreview = argsPreviewForUi(tc.name, tc.arguments)
    const existingIdx = findToolRowIndex(next, tc.id, tc.name)
    if (existingIdx >= 0) {
      const existing = next[existingIdx]
    if (existing?.kind === 'tool') {
      if (existing.tool.status !== 'running') continue
      next = next.map((item, i) =>
          i === existingIdx && item.kind === 'tool'
            ? withCanonicalToolId(
                {
                  ...item,
                  tool: {
                    ...item.tool,
                    name: tc.name,
                    summary: summary || item.tool.summary,
                    status: 'running' as const,
                    argsPreview
                  }
                },
                tc.id
              )
            : item
        )
      }
      continue
    }
    if (next.some((i) => i.kind === 'tool' && (i.id === tc.id || i.tool.id === tc.id))) continue
    next = appendTool(
      next,
      {
        kind: 'tool',
        id: tc.id,
        tool: {
          id: tc.id,
          name: tc.name,
          summary,
          status: 'running',
          argsPreview
        }
      },
      runStartedAt
    )
  }
  return next
}

/**
 * Drop streaming tool rows that never made it into this step's canonical
 * `toolCalls`. Otherwise a cancelled/malformed edit delta stays `running`
 * forever above later completed work.
 */
function pruneOrphanDeltaToolRows(
  items: UiItem[],
  toolCalls: Array<{ id: string }> | undefined
): UiItem[] {
  const keep = new Set((toolCalls ?? []).map((tc) => tc.id))
  let changed = false
  const next = items.filter((item) => {
    if (item.kind !== 'tool' || item.tool.status !== 'running') return true
    if (keep.has(item.id) || keep.has(item.tool.id)) return true

    const pending = isPendingToolId(item.id) || isPendingToolId(item.tool.id)
    if (pending) {
      changed = true
      return false
    }

    // Real id from a delta that the final assistant_message dropped (including
    // text-only steps where toolCalls is empty/absent).
    changed = true
    return false
  })
  return changed ? next : items
}

/** Close a live trailing tool stretch once every tool in it has finished. */
function closeTrailingGroupIfIdle(items: UiItem[], endedAt = Date.now()): UiItem[] {
  const start = trailingLiveToolGroupStart(items)
  if (start < 0) return items
  for (let i = start; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'tool') break
    if (item.tool.status === 'running') return items
  }
  return closeOpenGroupTimings(items, endedAt)
}

/** Force-fail any tool still marked running (terminal status / interrupted turn). */
function failRunningTools(
  items: UiItem[],
  reason: 'Cancelled' | 'Interrupted' | 'Not completed' | 'Connection lost'
): UiItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool' || item.tool.status !== 'running') return item
    changed = true
    return {
      ...item,
      tool: {
        ...item.tool,
        status: 'fail' as const,
        content: item.tool.content ?? reason
      }
    }
  })
  return changed ? next : items
}

function isPendingToolId(id: string): boolean {
  return id.startsWith('pending_')
}

function parsePendingIndex(toolCallId: string): number | null {
  if (!isPendingToolId(toolCallId)) return null
  const n = Number.parseInt(toolCallId.slice('pending_'.length), 10)
  return Number.isFinite(n) && n >= 0 ? n : null
}

function pendingRunningToolIndices(items: UiItem[]): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind !== 'tool') continue
    if (!isPendingToolId(item.id)) continue
    if (item.tool.status !== 'running') continue
    out.push(i)
  }
  return out
}

function findToolRowIndex(items: UiItem[], toolCallId: string, toolName?: string): number {
  const direct = items.findIndex(
    (i) => i.kind === 'tool' && (i.id === toolCallId || i.tool.id === toolCallId)
  )
  if (direct >= 0) return direct

  const pendingIndex = parsePendingIndex(toolCallId)
  if (pendingIndex !== null) {
    const pending = pendingRunningToolIndices(items)
    if (pendingIndex < pending.length) return pending[pendingIndex]
    return -1
  }

  const pending = pendingRunningToolIndices(items)
  for (const idx of pending) {
    const item = items[idx]
    if (item.kind !== 'tool') continue
    if (!isPendingToolId(item.tool.id)) continue
    if (toolName && item.tool.name !== 'tool' && item.tool.name !== toolName) continue
    return idx
  }
  return -1
}

/**
 * Adopt the provider's id on both the row and its tool. Leaving `item.id` as the
 * placeholder would keep the row in the pending pool, so a later unmatched result
 * could claim a row that has already been reconciled.
 */
function withCanonicalToolId(
  item: Extract<UiItem, { kind: 'tool' }>,
  toolCallId: string
): Extract<UiItem, { kind: 'tool' }> {
  if (item.id === toolCallId && item.tool.id === toolCallId) return item
  return {
    ...item,
    id: toolCallId,
    tool: { ...item.tool, id: toolCallId }
  }
}

/**
 * Streaming deltas hit one known row per frame. Copying the array and swapping
 * that index keeps every other row's object identity, so memoized rows skip
 * re-rendering, and avoids running a closure over the whole transcript.
 */
function replaceAt(items: UiItem[], index: number, next: UiItem): UiItem[] {
  const copy = items.slice()
  copy[index] = next
  return copy
}

/** Drop pending question prompts, either one answered or all of them. */
function clearQuestions(items: UiItem[], requestId?: string): UiItem[] {
  return items.filter((item) => {
    if (item.kind !== 'question') return true
    if (requestId && item.question.requestId !== requestId) return true
    return false
  })
}

/**
 * `messagesToUiItems` rebuilds chrome without timestamps. After edit/resend,
 * copy `at` / `groupTiming` from the prior UI so earlier turns keep duration.
 */
function carryTimingFromPriorItems(nextItems: UiItem[], priorItems: UiItem[]): UiItem[] {
  if (priorItems.length === 0) return nextItems
  const priorById = new Map(priorItems.map((item) => [item.id, item]))
  let changed = false
  const out = nextItems.map((item) => {
    const prior = priorById.get(item.id)
    if (!prior || prior.kind !== item.kind) return item
    if (item.kind === 'message' && prior.kind === 'message') {
      if (item.at || !prior.at) return item
      changed = true
      return { ...item, at: prior.at }
    }
    if (item.kind === 'tool' && prior.kind === 'tool') {
      const at = item.at ?? prior.at
      const groupTiming = item.groupTiming ?? prior.groupTiming
      if (at === item.at && groupTiming === item.groupTiming) return item
      changed = true
      return {
        ...item,
        ...(at ? { at } : {}),
        ...(groupTiming ? { groupTiming } : {})
      }
    }
    return item
  })
  return changed ? out : nextItems
}

/** Keep fold summaries that still sit at or before the last remaining item. */
function carryCompactionItems(nextItems: UiItem[], priorItems: UiItem[]): UiItem[] {
  const prior = priorItems.filter(
    (item): item is Extract<UiItem, { kind: 'compaction' }> => item.kind === 'compaction'
  )
  if (prior.length === 0) return nextItems
  const lastKept = [...nextItems].reverse().find((item) => item.kind !== 'compaction')
  if (!lastKept) return [...prior, ...nextItems]
  const lastKeptIdx = priorItems.findIndex((item) => item.id === lastKept.id)
  const keep =
    lastKeptIdx < 0
      ? prior
      : prior.filter((item) => {
          const idx = priorItems.findIndex((row) => row.id === item.id)
          return idx >= 0 && idx <= lastKeptIdx
        })
  if (keep.length === 0) return nextItems
  const base = nextItems.filter((item) => item.kind !== 'compaction')
  const extras = keep.filter((extra) => !base.some((item) => item.id === extra.id))
  return weaveCompactionItems(base, extras)
}

function liveCompactionItem(
  summary: string,
  tokenEstimate: number | undefined,
  existingCount: number,
  extra?: Partial<
    Pick<
      Extract<UiItem, { kind: 'compaction' }>,
      'verifyStatus' | 'verifyFailures' | 'verifyCoverage' | 'id'
    >
  >
): Extract<UiItem, { kind: 'compaction' }> | null {
  const trimmed = summary.trim()
  if (!trimmed) return null
  const at = new Date().toISOString()
  return {
    kind: 'compaction',
    id: extra?.id ?? `compaction:${existingCount}:${trimmed}`,
    summary: trimmed,
    at,
    ...(tokenEstimate != null ? { tokenEstimate } : {}),
    ...(extra?.verifyStatus ? { verifyStatus: extra.verifyStatus } : {}),
    ...(extra?.verifyFailures && extra.verifyFailures.length > 0
      ? { verifyFailures: extra.verifyFailures }
      : {}),
    ...(extra?.verifyCoverage != null ? { verifyCoverage: extra.verifyCoverage } : {})
  }
}

function upsertLiveCompaction(
  items: UiItem[],
  item: Extract<UiItem, { kind: 'compaction' }>
): UiItem[] {
  const live: Extract<UiItem, { kind: 'compaction' }> = { ...item, id: LIVE_COMPACTION_ID }
  const idx = items.findIndex((row) => row.id === LIVE_COMPACTION_ID)
  if (idx >= 0) {
    const prev = items[idx] as Extract<UiItem, { kind: 'compaction' }>
    const merged: Extract<UiItem, { kind: 'compaction' }> = {
      ...prev,
      ...live,
      id: LIVE_COMPACTION_ID
    }
    if (live.verifyFailures === undefined) delete merged.verifyFailures
    return items.map((row, i) => (i === idx ? merged : row))
  }
  return insertCompactionItem(items, live)
}

function replaceOrInsertCompaction(
  items: UiItem[],
  item: Extract<UiItem, { kind: 'compaction' }>
): UiItem[] {
  const withoutLive = items.filter((row) => row.id !== LIVE_COMPACTION_ID)
  const match = withoutLive.findIndex(
    (row) => row.kind === 'compaction' && row.summary === item.summary
  )
  if (match >= 0) {
    const existing = withoutLive[match]
    if (
      existing?.kind === 'compaction' &&
      (existing.verifyStatus === 'failed' || existing.verifyStatus === 'verified') &&
      (item.verifyStatus === 'failed' || item.verifyStatus === 'verified') &&
      existing.verifyStatus !== item.verifyStatus
    ) {
      return insertCompactionItem(withoutLive, item)
    }
    return withoutLive.map((row, i) =>
      i === match && row.kind === 'compaction'
        ? { ...row, ...item, id: row.id, at: row.at ?? item.at }
        : row
    )
  }
  return insertCompactionItem(withoutLive, item)
}

/** Rewrite an in-flight compact card so cancel/error does not leave it verifying. */
function settleLiveCompaction(items: UiItem[]): UiItem[] {
  return items.map((item) => {
    if (item.id !== LIVE_COMPACTION_ID || item.kind !== 'compaction') return item
    return {
      ...item,
      id: `compaction:aborted:${item.at ?? 'live'}`,
      verifyStatus: 'failed' as const,
      verifyFailures: item.verifyFailures?.length
        ? item.verifyFailures
        : ['Summary was not applied.']
    }
  })
}

/** Drop question panels gated on a settled ask_question tool call. */
function clearQuestionsForTool(items: UiItem[], toolCallId: string): UiItem[] {
  return items.filter(
    (item) => !(item.kind === 'question' && item.question.toolCallId === toolCallId)
  )
}

/** Drop pending approval prompts, either one answered or all of them. */
function clearApprovals(items: UiItem[], requestId?: string): UiItem[] {
  let changed = false
  const next = items.map((item) => {
    if (item.kind !== 'tool') return item
    let nextItem = item
    if (item.approval && (!requestId || item.approval.requestId === requestId)) {
      changed = true
      const { approval: _approval, ...rest } = item
      nextItem = rest
    }
    return nextItem
  })
  return changed ? next : items
}

/**
 * Settle transcript chrome at end of run: fail live tools, close open group
 * timings, drop pending gates, and clear streaming flags. Shared by the
 * terminal status path and the cancel-recovery fallback.
 */
function finalizeTerminalItems(
  items: UiItem[],
  reason: 'Cancelled' | 'Interrupted' | 'Not completed' | 'Connection lost',
  startedToolCallIds: Set<string>,
  todoOutcome?: TodoFinalizeOutcome
): UiItem[] {
  return settleLiveCompaction(
    clearQuestions(
      clearApprovals(
        failRunningTools(
          dropNeverStartedRunningTools(closeOpenGroupTimings(items), startedToolCallIds),
          reason
        )
      )
    )
  ).map((item) => {
    if (item.kind === 'message' && (item.streaming || item.thinkingStreaming)) {
      return { ...item, streaming: false, thinkingStreaming: false }
    }
    if (
      todoOutcome &&
      item.kind === 'tool' &&
      item.tool.name === 'todo_write' &&
      item.tool.content
    ) {
      const content = finalizeTodoContentOnRunEnd(item.tool.content, todoOutcome)
      if (content !== item.tool.content) {
        return { ...item, tool: { ...item.tool, content } }
      }
    }
    return item
  })
}

/** Search from the tail: the row a delta targets is almost always the last one. */
function findMessageIndex(items: UiItem[], id: string): number {
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]
    if (item.kind === 'message' && item.id === id) return i
  }
  return -1
}

function runningToolIndices(items: UiItem[]): number[] {
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    if (item.kind === 'tool' && item.tool.status === 'running') out.push(i)
  }
  return out
}

/**
 * Find the row a `tool_result` belongs to. Beyond the id match, a result whose id
 * drifted from its `tool_start` must still land on the live row: appending a second row
 * would leave the original running forever, which is what pins the group on "Exploring".
 * When several same-name tools are running, prefer a unique summary match; otherwise
 * complete the oldest unmatched same-name row (FIFO) so UI status stays in sync with
 * messages instead of leaving tools stuck on "running".
 */
function findToolResultRowIndex(
  items: UiItem[],
  toolCallId: string,
  name: string,
  summary?: string
): number {
  const direct = findToolRowIndex(items, toolCallId, name)
  if (direct >= 0) return direct

  const running = runningToolIndices(items)
  const sameName = running.filter((idx) => {
    const item = items[idx]
    return item.kind === 'tool' && item.tool.name === name
  })
  if (sameName.length === 1) return sameName[0]!
  if (sameName.length > 1 && summary) {
    const bySummary = sameName.filter((idx) => {
      const item = items[idx]
      return item.kind === 'tool' && item.tool.summary === summary
    })
    if (bySummary.length === 1) return bySummary[0]!
    if (bySummary.length > 1) return bySummary[0]!
  }
  // Ambiguous or missing summary: FIFO among same-name running rows.
  if (sameName.length > 0) return sameName[0]!
  if (running.length === 1) return running[0]!
  return -1
}

function errorMessageFromPersisted(events: PersistedEvent[]): string | null {
  let message: string | null = null
  for (const row of events) {
    const event = row.event
    if (!isAgentEvent(event)) continue
    // A later turn start clears a prior failure (matches live status:running).
    if (event.type === 'status' && event.status === 'running') {
      message = null
      continue
    }
    if (event.type === 'error') message = event.message
  }
  return message
}

function errorCodeFromPersisted(events: PersistedEvent[]): string | null {
  let code: string | null = null
  for (const row of events) {
    const event = row.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'status' && event.status === 'running') {
      code = null
      continue
    }
    if (event.type === 'error' && event.code) code = event.code
  }
  return code
}

function errorFromPersisted(
  events: PersistedEvent[],
  dismissedErrorMessage: string | null = null
): string | null {
  const message = errorMessageFromPersisted(events)
  if (!message) return null
  if (dismissedErrorMessage && dismissedErrorMessage === message) return null
  return message
}

/** A turn that ended before the work was finished, offering a Continue affordance. */
export type IncompleteTurnState = {
  reason: IncompleteReason
  message: string
}

export type WriteCheckpointFileState = {
  path: string
  action: 'created' | 'modified' | 'deleted'
  undoable: boolean
  resolved?: 'kept' | 'discarded'
  /** Revert refused because the file was edited after the agent wrote it. */
  conflicted?: boolean
}

export type WriteCheckpointState = {
  checkpointId: string
  undone: boolean
  files: WriteCheckpointFileState[]
}

/** Files a revert actually restored (main's post-execution result). */
export type RevertWritesOutcome = {
  restored: string[]
  skipped: string[]
}

function incompleteFromPersisted(events: PersistedEvent[]): IncompleteTurnState | null {
  let incomplete: IncompleteTurnState | null = null
  for (const row of events) {
    const event = row.event
    if (!isAgentEvent(event)) continue
    // Continue / new turn clears the prior incomplete banner (matches live handler).
    if (event.type === 'status' && event.status === 'running') {
      incomplete = null
      continue
    }
    if (event.type === 'incomplete') {
      incomplete = { reason: event.reason, message: event.message }
    }
  }
  return incomplete
}

function turnOutcomeFromPersisted(
  events: PersistedEvent[],
  idle: boolean,
  incomplete: IncompleteTurnState | null
): TurnOutcome | null {
  const status = lastPersistedRunStatus(events)
  if (status === 'running') return idle ? 'interrupted' : null
  if (status) return status
  return incomplete ? 'error' : null
}

function writeCheckpointFromPersisted(events: PersistedEvent[]): WriteCheckpointState | null {
  // A checkpoint id can appear in MULTIPLE rows: the turn's original append plus a
  // later persistWriteCheckpointEvent row (Keep/Discard/Undo) that carries the
  // resolution. Scan oldest→newest and let the newest row per checkpoint id win so
  // a stale unresolved row cannot resurrect a resolved/undone banner after reload.
  const resolvedIds = new Set<string>()
  const unresolvedRows: Extract<AgentEvent, { type: 'writes_checkpoint' }>[] = []
  for (const row of events) {
    const event = row?.event
    if (!isAgentEvent(event) || event.type !== 'writes_checkpoint') continue
    if (resolvedIds.has(event.checkpointId)) continue
    const files = event.files.map((f) => ({
      path: f.path,
      action: f.action,
      undoable: f.undoable,
      ...(f.resolved ? { resolved: f.resolved } : {}),
      ...(f.conflicted ? { conflicted: f.conflicted } : {})
    }))
    const fullyResolved =
      files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
    if (event.undone === true || fullyResolved) {
      resolvedIds.add(event.checkpointId)
      continue
    }
    unresolvedRows.push(event)
  }
  // Newest unresolved rows first, and only for ids never resolved by a later row.
  const unresolved = unresolvedRows
    .slice()
    .reverse()
    .filter((event) => !resolvedIds.has(event.checkpointId))
  if (unresolved.length === 0) return null

  const latest = unresolved[0]
  const fileMap = new Map<string, WriteCheckpointFileState>()
  for (const checkpoint of [...unresolved].reverse()) {
    for (const f of checkpoint.files) {
      fileMap.set(f.path, {
        path: f.path,
        action: f.action,
        undoable: f.undoable,
        ...(f.resolved ? { resolved: f.resolved } : {}),
        ...(f.conflicted ? { conflicted: f.conflicted } : {})
      })
    }
  }
  const files = [...fileMap.values()]
  const mergedResolved =
    files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
  return {
    checkpointId: latest.checkpointId,
    undone: mergedResolved,
    files
  }
}

function modeFromPersisted(events: PersistedEvent[]): AgentInteractionMode | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'mode_changed') return event.mode
  }
  return null
}

function agentInstancesFromEvents(events: PersistedEvent[]): Record<string, AgentInstanceUiState> {
  let map: Record<string, AgentInstanceUiState> = {}
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type !== 'agent_instance_update') continue
    map = mergeAgentInstanceUpdate(map, row.event)
  }
  return map
}

function hydrateFromDisk(
  kept: ChatMessage[],
  events: PersistedEvent[],
  dismissedErrorMessage: string | null = null,
  opts?: { idle?: boolean; priorAgentInstances?: Record<string, AgentInstanceUiState> }
) {
  const items = applyEventTimestamps(
    applyPersistedLiveTools(messagesToUiItems(kept), events),
    events
  ).map((item) => {
    if (item.kind !== 'tool' || item.tool.presentation) return item
    return {
      ...item,
      tool: {
        ...item.tool,
        presentation: toolPresentation(item.tool.name, item.tool.argsPreview, item.tool.summary)
      }
    }
  })
  const fromDisk = agentInstancesFromEvents(events)
  const prior = opts?.priorAgentInstances
  const incomplete = incompleteFromPersisted(events)
  return {
    messages: kept,
    error: errorFromPersisted(events, dismissedErrorMessage),
    errorCode: errorCodeFromPersisted(events),
    incomplete,
    turnStatus: turnOutcomeFromPersisted(events, opts?.idle === true, incomplete),
    contextUsage: summarizeContextUsageFromEvents(events),
    runNotice: null,
    compacting: compactingFromEvents(events, opts?.idle === true),
    costHint: costHintFromEvents(events),
    items: applyCompactionItems(
      appendRunErrorItems(
        finalizeHydratedTranscript(
          items,
          events,
          opts?.idle ? { treatRunningAs: 'cancelled' } : undefined
        ),
        events,
        dismissedErrorMessage
      ),
      events
    ),
    writeCheckpoint: writeCheckpointFromPersisted(events),
    agentInstances: prior ? mergeAgentInstanceMaps(prior, fromDisk) : fromDisk,
    turnUsage: turnUsageFromPersistedEvents(events, userMessageAts(kept))
  }
}

/** True when a fold started on disk and has not yet finished or failed. */
function compactingFromEvents(events: PersistedEvent[], idle = false): boolean {
  if (idle) return false
  let compacting = false
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (
      row.event.type === 'compaction_started' ||
      row.event.type === 'compaction_verifying' ||
      row.event.type === 'compaction_verify_retry'
    ) {
      compacting = true
    } else if (
      row.event.type === 'compaction' ||
      row.event.type === 'compaction_verify_failed'
    ) {
      compacting = false
    } else if (row.event.type === 'error' && row.event.code === 'COMPACTION') {
      compacting = false
    } else if (
      row.event.type === 'status' &&
      (row.event.status === 'done' ||
        row.event.status === 'cancelled' ||
        row.event.status === 'error')
    ) {
      compacting = false
    }
  }
  return compacting
}

/** Latest advisory cost hint for ContextMeter (not composer runNotice). */
function costHintFromEvents(events: PersistedEvent[]): string | null {
  let hint: string | null = null
  for (const row of events) {
    if (!isAgentEvent(row.event)) continue
    if (row.event.type === 'token_cost_hint') {
      const msg = row.event.message?.trim()
      if (msg) hint = msg
    }
  }
  return hint
}

function appendRunErrorItems(
  items: UiItem[],
  events: PersistedEvent[],
  dismissedErrorMessage: string | null = null
): UiItem[] {
  const out = [...items]
  // Mirror the live terminal handler: one error box per failed run — the last
  // error event before each status:'error', scoped by the next status:'running'.
  let lastError: { row: PersistedEvent; index: number; message: string; code?: string } | null =
    null
  const pushBox = (): void => {
    if (!lastError || lastError.message === dismissedErrorMessage) return
    const id = `run-error:${lastError.row.at}:${lastError.index}`
    if (out.some((item) => item.kind === 'run_error' && item.id === id)) return
    out.push({
      kind: 'run_error',
      id,
      message: lastError.message,
      ...(lastError.code ? { code: lastError.code } : {}),
      at: lastError.row.at
    })
  }
  for (let i = 0; i < events.length; i++) {
    const row = events[i]
    const event = row?.event
    if (!isAgentEvent(event)) continue
    if (event.type === 'status') {
      if (event.status === 'running') {
        lastError = null
      } else if (event.status === 'error') {
        pushBox()
        lastError = null
      }
      continue
    }
    if (event.type === 'error') {
      lastError = {
        row,
        index: i,
        message: event.message,
        ...(event.code ? { code: event.code } : {})
      }
    }
  }
  // Trailing error with no terminal status (truncated/legacy logs) — keep the box.
  pushBox()
  return out
}

export type PendingFollowUpState = {
  id: string
  itemId: string
  preview: string
  text: string
  /** Full queued message — preserved so text-only edits keep attachments. */
  message?: ChatMessage
}

function mergeUserFollowUpText(content: MessageContent | undefined, text: string): MessageContent {
  if (content == null || typeof content === 'string') return text
  const parts = [...content]
  const textIdx = parts.findIndex((part) => part.type === 'text')
  if (textIdx >= 0) {
    parts[textIdx] = { type: 'text', text }
  } else {
    parts.unshift({ type: 'text', text })
  }
  return parts
}

type PendingFollowUpSource = { id: string; preview: string; ready?: boolean }

function hydratePendingFollowUps(
  pendingFromMain: PendingFollowUpSource[],
  diskPending: PendingFollowUpSource[] | undefined,
  local: PendingFollowUpState[]
): PendingFollowUpState[] {
  const source =
    pendingFromMain.length > 0
      ? pendingFromMain
      : (diskPending?.length ?? 0) > 0
        ? diskPending!
        : null
  if (!source) return local
  return source.map((entry) => {
    const localEntry = local.find((p) => p.id === entry.id)
    return {
      id: entry.id,
      itemId: localEntry?.itemId ?? `followup-${entry.id}`,
      preview: localEntry?.preview ?? entry.preview,
      text: localEntry?.text ?? entry.preview,
      ...(localEntry?.message ? { message: localEntry.message } : {})
    }
  })
}

export type ChatStreamState = {
  items: UiItem[]
  messages: ChatMessage[]
  running: boolean
  runId: string | null
  error: string | null
  /** Structured code from the last agent `error` event (e.g. PROVIDER_STREAM). */
  errorCode: string | null
  runNotice: string | null
  /** True while LLM history summarization is in flight. */
  compacting: boolean
  /** Advisory token-cost tip for ContextMeter (never composer runNotice). */
  costHint: string | null
  /** Survives the terminal status event, unlike `runNotice`. */
  incomplete: IncompleteTurnState | null
  /** Live reconnect/backoff state from `network_wait` events. */
  networkWait: {
    attempt: number
    maxAttempts: number
    retryInMs: number
    code?: string
  } | null
  contextUsage: ContextUsageState | null
  /** Per UI-turn step usage, aligned with user-turn index. */
  turnUsage: StepUsageTotals[]
  /** Terminal outcome for the latest turn; null while a turn is active. */
  turnStatus: TurnOutcome | null
  runStartedAt: number | null
  runTerminalTick: number
  pendingRun: boolean
  transcriptLoading: boolean
  /** Turn summary disclosure — survives transcript remounts like tool/group expand state. */
  collapsedTurnIndices: number[]
  /** Latest turn write checkpoint for Undo on the Files Changed card. */
  writeCheckpoint: WriteCheckpointState | null
  /** Mid-run follow-ups waiting to be injected into the live agent loop. */
  pendingFollowUps: PendingFollowUpState[]
  /** Latest lifecycle for inline Agent V instances spawned by this run. */
  agentInstances: Record<string, AgentInstanceUiState>
}

export type ChatStreamController = ChatStreamState & {
  workspacePath: string
  /** Live chatStart invoke id for the active turn (null when idle). */
  getInvokeId: () => number | null
  send: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => Promise<boolean>
  /** Replace a past user message, restore write checkpoints, truncate later turns, re-run. */
  editAndResend: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => Promise<boolean>
  /** Rewind to a past user message: restore files, truncate later turns, no re-run. */
  revertToUserMessage: (userMessageIndex: number) => Promise<RevertWritesOutcome | false>
  /** Read-only preview of the files a revertToUserMessage would restore (null = unavailable). */
  previewRewindToUserMessage: (userMessageIndex: number) => Promise<ChatRewindPreviewResult | null>
  /** Drop a still-queued mid-run follow-up before the loop applies it. */
  removeFollowUp: (id: string) => Promise<boolean>
  /** Update queued follow-up text before the loop applies it. */
  editFollowUp: (id: string, text: string) => Promise<boolean>
  /** Move a queued follow-up to the front of the drain order. */
  sendFollowUpNow: (id: string) => Promise<boolean>
  stop: () => Promise<void>
  /** Resume an interrupted run from disk without adding a user turn. */
  resumeInterrupted: () => Promise<boolean>
  reset: () => void
  loadTranscript: (loaded: ChatMessage[], events?: PersistedEvent[]) => void
  /** Load messages without canceling an active/background run (restore / tab select). */
  hydrateTranscript: (loaded: ChatMessage[], events?: PersistedEvent[]) => void
  reattachActiveRun: (runId: string) => Promise<void>
  clearError: () => void
  /** Lazy-load full tool output from disk when IPC preview was truncated. */
  loadToolContent: (toolCallId: string) => Promise<string | null>
  /** Persist thinking block expand/collapse across transcript remounts. */
  setThinkingExpanded: (messageId: string, expanded: boolean) => void
  /** Persist tool detail expand/collapse across transcript remounts. */
  setToolExpanded: (toolCallId: string, expanded: boolean) => void
  /** Persist an activity group's disclosure state, keyed by its first tool row. */
  setGroupExpanded: (anchorToolCallId: string, expanded: boolean) => void
  /** Persist turn summary collapse across transcript remounts. */
  toggleTurnCollapsed: (turnIndex: number) => void
  /** Park a gated tool call on its transcript row until the reader answers. */
  handleApprovalRequest: (request: ToolApprovalRequest) => void
  respondToApproval: (requestId: string, decision: ToolApprovalDecision) => Promise<void>
  handleQuestionRequest: (request: AgentQuestionRequest) => void
  respondToQuestion: (requestId: string, answers: AgentQuestionAnswer[]) => Promise<void>
  /** Reload transcript from disk when a run finished but IPC was missed. */
  syncFromDisk: (runId: string, opts?: { ignoreActiveList?: boolean }) => Promise<boolean>
  /** Update meter + transcript summary after a manual Compact now. */
  applyManualCompaction: (result: {
    summary: string
    estimatedTokens?: number
    contextWindow?: number
    contentWindow?: number
    tokenEstimate: number
    verified?: boolean
    verifyCoverage?: number
    verifyFailures?: string[]
  }) => void
  /** Mark compacting in-flight for manual Compact (IPC has no live stream). */
  setCompacting: (compacting: boolean) => void
  /** Apply Keep/Discard results onto the live write checkpoint state. */
  applyWriteCheckpointResolution: (result: {
    checkpointId: string
    kept: string[]
    discarded: string[]
    fullyResolved: boolean
  }) => void
  handleEvent: (event: AgentEvent) => void
  /**
   * When true, high-frequency stream events are ignored (agent still runs in main).
   * Call `resumeUiIfNeeded` when the run becomes visible again.
   */
  setUiSuspended: (suspended: boolean) => void
  /** Mark that live stream events were dropped (e.g. main UI-subscribe gate). */
  markUiCatchUpNeeded: () => void
  /** Clear suspend and rehydrate transcript from disk if stream events were skipped. */
  resumeUiIfNeeded: () => Promise<void>
  readonly uiSuspended: boolean
  subscribe: (listener: () => void) => () => void
  subscribeItems: (listener: () => void) => () => void
  subscribeMeta: (listener: () => void) => () => void
  getRevision: () => number
  getItemsRevision: () => number
  getMetaRevision: () => number
  getContextUsage: () => import('@shared/utils/contextUsage').ContextUsageState | null
  getTurnUsage: () => StepUsageTotals[]
  getCostHint: () => string | null
  setTranscriptLoading: (loading: boolean) => void
  /** True after `dispose()`; async restores must not hydrate this instance. */
  readonly disposed: boolean
  dispose: () => void
}

/** Events still applied while UI is suspended (approvals/questions use separate handlers). */
const UI_SUSPEND_ALLOWED_EVENTS = new Set<AgentEvent['type']>([
  'status',
  'error',
  'incomplete',
  'network_wait',
  'compaction_started',
  'compaction_verifying',
  'compaction_verify_retry',
  'compaction_verify_failed',
  'compaction',
  'mode_changed',
  // Live tool chrome — not persisted; dropping loses output with no disk backfill.
  'terminal_output_delta',
  'tool_progress',
  'agent_instance_update',
  'goal_update',
  'loop_update'
])

/** Per-run card expansion state persisted via workspace UI state. */
export type RunExpansions = {
  toolIds: string[]
  groupIds: string[]
  thinkingIds: string[]
  collapsedTurns: number[]
}

export const EMPTY_RUN_EXPANSIONS: RunExpansions = {
  toolIds: [],
  groupIds: [],
  thinkingIds: [],
  collapsedTurns: []
}

export type CreateChatStreamControllerOptions = {
  workspacePath: string
  runId?: string | null
  onRunIdAssigned?: (runId: string) => void
  onTerminal?: () => void
  /** Current Ask / Plan / Agent mode for chatStart. */
  getAgentMode?: () => AgentInteractionMode
  /** Sync composer mode when the agent calls switch_mode. */
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  /** Restored expansion state for this run (survives reload/tab switches). */
  initialExpansions?: Partial<RunExpansions>
  /** Persist expansion changes (debounced by the caller). */
  onExpansionsChange?: (next: RunExpansions) => void
}

export function createChatStreamController(
  options: CreateChatStreamControllerOptions
): ChatStreamController {
  const { workspacePath, onRunIdAssigned, onTerminal, getAgentMode, onAgentModeChange } = options
  const { initialExpansions, onExpansionsChange } = options
  let lastNotifiedAgentMode: AgentInteractionMode | null = null
  const notifyAgentMode = (mode: AgentInteractionMode | null | undefined): void => {
    if (!mode || mode === lastNotifiedAgentMode) return
    lastNotifiedAgentMode = mode
    onAgentModeChange?.(mode)
  }
  const listeners = new Set<() => void>()
  const itemsListeners = new Set<() => void>()
  const metaListeners = new Set<() => void>()
  const closedRuns = new Set<string>()
  let assistantId: string | null = null
  /** Row that owns the current step's reasoning, cleared when the step closes. */
  let reasoningId: string | null = null
  /** Next reasoning delta opens a new step, so it needs a break from the previous one. */
  let reasoningSegmentBreak = false
  let runId: string | null = options.runId ?? null
  /** Run id used for lazy tool-result loads after the active session id is cleared. */
  let contentRunId: string | null = options.runId ?? null
  let awaitingRun = false
  let pendingCancel = false
  let ignoreStreamEvents = false
  /** Skip transcript-mutating stream events while the run is not UI-visible. */
  let uiSuspended = false
  /** True after stream events were dropped while suspended — needs disk catch-up. */
  let needsUiCatchUp = false
  /** Bumped on suspend / new resume so in-flight catch-up cannot unsuspend stale work. */
  let uiResumeGeneration = 0
  /** Generation of the catch-up currently awaiting disk; 0 when none. */
  let uiCatchUpStartedGen = 0
  // A run is reused across turns, so runId alone cannot separate the live turn from a
  // prior one still draining. Events carry the invoke that produced them.
  let activeInvokeId: number | null = null
  const supersededInvokeIds = new Set<number>()
  let disposed = false
  let revision = 0
  let itemsRevision = 0
  let metaRevision = 0
  let turnSeq = 0
  let completedTurnSeq = 0
  let runningTurnSeq = 0
  let lastRunErrorMessage: string | null = null
  let lastRunErrorCode: string | null = null
  /** Persisted error message dismissed by the reader; hydrate skips restoring it. */
  let dismissedErrorMessage: string | null = null
  let usageTotals: StepUsageTotals = emptyStepUsageTotals()
  let turnUsageSlots: StepUsageTotals[] = []
  let streamPatchRaf: number | null = null
  /** Timer fallback paint for hidden windows, where Chromium pauses rAF. */
  let streamPatchTimer: ReturnType<typeof setTimeout> | null = null
  const STREAM_PATCH_HIDDEN_FALLBACK_MS = 32

  const cancelScheduledStreamPatch = (): void => {
    if (streamPatchRaf != null) {
      cancelAnimationFrame(streamPatchRaf)
      streamPatchRaf = null
    }
    if (streamPatchTimer != null) {
      clearTimeout(streamPatchTimer)
      streamPatchTimer = null
    }
  }
  /** Coalesce reasoning deltas — markdown/shiki is skipped but DOM still updates. */
  let thinkingPatchTimer: ReturnType<typeof setTimeout> | null = null
  const THINKING_PATCH_MS = 100
  /** Same cadence as thinking — rAF-per-delta made live diffs remount/highlight every frame. */
  let toolPatchTimer: ReturnType<typeof setTimeout> | null = null
  const TOOL_PATCH_MS = 100
  let pendingTextDelta = ''
  let pendingThinkingDelta = ''
  let pendingToolCallDeltas: Array<{
    toolCallId: string
    name?: string
    argumentsDelta: string
  }> = []
  type PendingTerminalPiece = { text: string; stream: 'stdout' | 'stderr' }
  const pendingTerminalByTool = new Map<string, PendingTerminalPiece[]>()
  type PendingToolProgressEntry = {
    parentToolCallId: string
    kind: UiToolProgressEntry['kind']
    text: string
  }
  let pendingToolProgress: PendingToolProgressEntry[] = []
  const TERMINAL_UI_MAX = 64 * 1024
  const toolContentCache = new Map<string, string>()
  /** Preview retained so collapse can drop expanded full bodies. */
  const toolContentPreviews = new Map<string, string>()
  /** Full argument accumulation during streaming (items only keep a capped preview). */
  const pendingToolArgsFull = new Map<string, string>()
  /** Tool calls that reached `tool_start` this session (vs provisional delta chrome). */
  const startedToolCallIds = new Set<string>()

  const clearToolBodyCaches = (): void => {
    toolContentCache.clear()
    toolContentPreviews.clear()
    pendingToolArgsFull.clear()
  }

  /**
   * Persisted expansion state. Hydration rebuilds items without reader flags,
   * which reset every expanded tool/thinking card and collapsed turn; these
   * sets are the durable source, re-applied after hydration and written to
   * workspace UI state on change.
   */
  let restoringExpansions = false
  const expandedToolIds = new Set(initialExpansions?.toolIds ?? [])
  const expandedGroupIds = new Set(initialExpansions?.groupIds ?? [])
  const expandedThinkingIds = new Set(initialExpansions?.thinkingIds ?? [])

  const expansionsSnapshot = (): RunExpansions => ({
    toolIds: [...expandedToolIds],
    groupIds: [...expandedGroupIds],
    thinkingIds: [...expandedThinkingIds],
    collapsedTurns: [...state.collapsedTurnIndices]
  })

  const notifyExpansions = (): void => {
    if (restoringExpansions) return
    onExpansionsChange?.(expansionsSnapshot())
  }

  /** Re-apply persisted expansion flags onto (re)hydrated items. */
  const applyPersistedExpansions = (items: UiItem[]): UiItem[] => {
    if (
      expandedToolIds.size === 0 &&
      expandedGroupIds.size === 0 &&
      expandedThinkingIds.size === 0
    ) {
      return items
    }
    return items.map((item) => {
      if (item.kind === 'tool') {
        const id = item.id || item.tool.id
        const toolExpanded = expandedToolIds.has(id)
        const groupExpanded = expandedGroupIds.has(id)
        if (!toolExpanded && !groupExpanded) return item
        return {
          ...item,
          ...(toolExpanded ? { toolExpanded: true as const } : {}),
          ...(groupExpanded ? { groupExpanded: true as const } : {})
        }
      }
      if (item.kind === 'message' && expandedThinkingIds.has(item.id)) {
        return item.thinkingExpanded ? item : { ...item, thinkingExpanded: true }
      }
      return item
    })
  }

  const applyToolCallDelta = (
    items: UiItem[],
    event: { toolCallId: string; name?: string; argumentsDelta: string },
    runStartedAt: number | null
  ): UiItem[] => {
    startedToolCallIds.add(event.toolCallId)
    const existingIdx = findToolRowIndex(items, event.toolCallId, event.name)
    const existing =
      existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
    const toolName = event.name || (existing?.kind === 'tool' ? existing.tool.name : '')
    const prior =
      pendingToolArgsFull.get(event.toolCallId) ??
      (existing?.kind === 'tool' ? existing.tool.argsPreview ?? '' : '')
    const fullArgs = mergeOpenAiCompatToolArgDelta(prior, event.argumentsDelta).arguments
    pendingToolArgsFull.set(event.toolCallId, fullArgs)
    const argsPreview = argsPreviewForUi(toolName || 'tool', fullArgs)
    const resolvedName = toolName || (existing?.kind === 'tool' ? existing.tool.name : '') || 'tool'
    const summarized = summarizeToolArgs(resolvedName, fullArgs)
    const summary = isUnresolvedToolName(resolvedName)
      ? ''
      : summarized || (existing?.kind === 'tool' ? existing.tool.summary : '') || ''
    if (existing?.kind === 'tool') {
      return replaceAt(
        items,
        existingIdx,
        withCanonicalToolId(
          {
            ...existing,
            tool: withPresentationLock(
              {
                ...existing.tool,
                name: toolName || existing.tool.name,
                argsPreview,
                summary
              },
              toolName || existing.tool.name,
              argsPreview
            )
          },
          event.toolCallId
        )
      )
    }
    return appendTool(
      items,
      {
        kind: 'tool' as const,
        id: event.toolCallId,
        tool: withPresentationLock(
          {
            id: event.toolCallId,
            name: toolName || 'tool',
            summary,
            status: 'running' as const,
            argsPreview
          },
          toolName || 'tool',
          argsPreview
        )
      },
      runStartedAt
    )
  }

  /** Close the open reasoning block once answer text or tool calls begin. */
  const closeOpenThinkingStep = (): void => {
    if (!reasoningId) return
    const id = reasoningId
    const index = findMessageIndex(state.items, id)
    if (index < 0) return
    const item = state.items[index]
    if (item?.kind !== 'message' || !item.thinkingStreaming) return
    patch({
      items: replaceAt(state.items, index, {
        ...item,
        thinkingStreaming: false
      })
    })
  }

  const scheduleToolCallDelta = (
    event: Extract<AgentEvent, { type: 'tool_call_delta' }>
  ): void => {
    if (isToolShapedTextLeak(pendingTextDelta)) {
      pendingTextDelta = ''
    }
    const last = pendingToolCallDeltas[pendingToolCallDeltas.length - 1]
    if (last && last.toolCallId === event.toolCallId) {
      last.argumentsDelta += event.argumentsDelta
      if (event.name) last.name = event.name
    } else {
      pendingToolCallDeltas.push({
        toolCallId: event.toolCallId,
        name: event.name,
        argumentsDelta: event.argumentsDelta
      })
    }
    if (toolPatchTimer != null) return
    toolPatchTimer = setTimeout(() => {
      toolPatchTimer = null
      scheduleStreamingPatch()
    }, TOOL_PATCH_MS)
  }

  const materializePendingToolCallDeltas = (): void => {
    if (toolPatchTimer != null) {
      clearTimeout(toolPatchTimer)
      toolPatchTimer = null
    }
    if (!pendingToolCallDeltas.length) return
    let items = state.items
    const deltas = pendingToolCallDeltas
    pendingToolCallDeltas = []
    for (const delta of deltas) {
      items = applyToolCallDelta(items, delta, state.runStartedAt)
    }
    patch({ items: scrubStreamingAssistantToolLeak(items) })
  }

  const applyStreamingPatches = (): void => {
    let items = state.items
    let changed = false

    if (pendingThinkingDelta && reasoningId) {
      const text = pendingThinkingDelta
      pendingThinkingDelta = ''
      const id = reasoningId
      const index = findMessageIndex(items, id)
      if (index < 0) {
        // `thinkingExpanded` stays unset: it records the reader's own choice, and
        // leaving it blank lets the block follow the stream on its own.
        items = insertAssistantItem(items, {
          kind: 'message',
          id,
          role: 'assistant',
          content: '',
          thinking: text,
          thinkingStreaming: true,
          streaming: false
        })
      } else {
        const current = items[index] as Extract<UiItem, { kind: 'message' }>
        const prior = current.thinking ?? ''
        items = replaceAt(items, index, {
          ...current,
          thinking:
            reasoningSegmentBreak && prior.trim() ? `${prior.trimEnd()}\n\n${text}` : prior + text,
          thinkingStreaming: true
        })
      }
      reasoningSegmentBreak = false
      changed = true
    } else {
      pendingThinkingDelta = ''
    }

    if (pendingTextDelta && assistantId) {
      const text = pendingTextDelta
      pendingTextDelta = ''
      const id = assistantId
      const index = findMessageIndex(items, id)
      if (index < 0) {
        items = insertAssistantItem(items, {
          kind: 'message',
          id,
          role: 'assistant',
          content: stripToolShapedAssistantTextForStream(text),
          streaming: true
        })
      } else {
        const current = items[index] as Extract<UiItem, { kind: 'message' }>
        items = replaceAt(items, index, {
          ...current,
          content: stripToolShapedAssistantTextForStream(current.content + text),
          streaming: true
        })
      }
      changed = true
    } else {
      pendingTextDelta = ''
    }

    if (pendingToolCallDeltas.length) {
      if (reasoningId) {
        const id = reasoningId
        const index = findMessageIndex(items, id)
        if (index >= 0) {
          const item = items[index]
          if (item?.kind === 'message' && item.thinkingStreaming) {
            items = replaceAt(items, index, {
              ...item,
              thinkingStreaming: false
            })
          }
        }
      }
      const deltas = pendingToolCallDeltas
      pendingToolCallDeltas = []
      for (const delta of deltas) {
        items = applyToolCallDelta(items, delta, state.runStartedAt)
      }
      changed = true
    }

    if (pendingTerminalByTool.size) {
      for (const [toolCallId, pieces] of pendingTerminalByTool) {
        const idx = findToolRowIndex(items, toolCallId, 'terminal')
        const item = idx >= 0 ? items[idx] : undefined
        if (!item || item.kind !== 'tool' || item.tool.status !== 'running') continue
        let prev = item.tool.content ?? ''
        if (prev.length >= TERMINAL_UI_MAX) continue
        // Keep raw stream text (incl. `\r` progress). Sanitize only on display
        // (TerminalBody) so CR overwrite works across chunk boundaries.
        for (const piece of pieces) {
          if (prev.length >= TERMINAL_UI_MAX) break
          const room = TERMINAL_UI_MAX - prev.length
          let text = piece.text
          if (piece.stream === 'stderr' && !prev.includes('stderr:\n')) {
            text = `${prev ? '\n' : ''}stderr:\n${piece.text}`
          }
          const clipped = text.length > room ? text.slice(0, room) : text
          if (!clipped) continue
          prev += clipped
        }
        if (prev !== (item.tool.content ?? '')) {
          items = replaceAt(items, idx, {
            ...item,
            tool: { ...item.tool, content: prev }
          })
          changed = true
        }
      }
      pendingTerminalByTool.clear()
    }

    if (pendingToolProgress.length) {
      const entries = pendingToolProgress
      pendingToolProgress = []
      for (const event of entries) {
        const idx = findToolRowIndex(items, event.parentToolCallId)
        const item = idx >= 0 ? items[idx] : undefined
        if (!item || item.kind !== 'tool') continue
        const progress = [...(item.toolProgress ?? []), { kind: event.kind, text: event.text }].slice(
          -MAX_TOOL_PROGRESS_ENTRIES
        )
        items = replaceAt(items, idx, { ...item, toolProgress: progress })
        changed = true
      }
    }

    if (changed) {
      items = scrubStreamingAssistantToolLeak(items)
      patch({ items })
    }
  }

  const flushThinkingPatchTimer = (): void => {
    if (thinkingPatchTimer != null) {
      clearTimeout(thinkingPatchTimer)
      thinkingPatchTimer = null
    }
  }

  const flushToolPatchTimer = (): void => {
    if (toolPatchTimer != null) {
      clearTimeout(toolPatchTimer)
      toolPatchTimer = null
    }
  }

  const flushStreamingPatches = (): void => {
    flushThinkingPatchTimer()
    flushToolPatchTimer()
    cancelScheduledStreamPatch()
    applyStreamingPatches()
  }

  const scheduleStreamingPatch = (): void => {
    if (streamPatchRaf != null || streamPatchTimer != null) return
    // Chromium pauses requestAnimationFrame for hidden/occluded windows. Every
    // 100ms thinking/tool timer re-armed and bailed on the pending rAF, so a
    // minimized window froze mid-stream and dumped everything at restore. Use
    // a timer paint while the document is hidden.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      streamPatchTimer = setTimeout(() => {
        streamPatchTimer = null
        applyStreamingPatches()
      }, STREAM_PATCH_HIDDEN_FALLBACK_MS)
      return
    }
    streamPatchRaf = requestAnimationFrame(() => {
      streamPatchRaf = null
      applyStreamingPatches()
    })
  }

  const scheduleTextDelta = (text: string): void => {
    flushThinkingPatchTimer()
    pendingTextDelta += text
    scheduleStreamingPatch()
  }

  const scheduleThinkingDelta = (text: string): void => {
    pendingThinkingDelta += text
    if (thinkingPatchTimer != null) return
    thinkingPatchTimer = setTimeout(() => {
      thinkingPatchTimer = null
      scheduleStreamingPatch()
    }, THINKING_PATCH_MS)
  }

  const state: ChatStreamState = {
    items: [],
    messages: [],
    running: false,
    runId,
    error: null,
    errorCode: null,
    runNotice: null,
    compacting: false,
    costHint: null,
    incomplete: null,
    networkWait: null,
    contextUsage: null,
    turnUsage: [],
    turnStatus: null,
    runStartedAt: null,
    runTerminalTick: 0,
    pendingRun: false,
    transcriptLoading: false,
    collapsedTurnIndices: [...(initialExpansions?.collapsedTurns ?? [])],
    writeCheckpoint: null,
    pendingFollowUps: [],
    agentInstances: {}
  }

  const notify = (): void => {
    if (disposed) return
    revision += 1
    for (const listener of listeners) listener()
  }

  const notifyItems = (): void => {
    if (disposed) return
    itemsRevision += 1
    for (const listener of itemsListeners) listener()
    notify()
  }

  const notifyMeta = (): void => {
    if (disposed) return
    metaRevision += 1
    for (const listener of metaListeners) listener()
    notify()
  }

  const getRevision = (): number => revision
  const getItemsRevision = (): number => itemsRevision
  const getMetaRevision = (): number => metaRevision
  const getContextUsage = (): typeof state.contextUsage => state.contextUsage
  const getTurnUsage = (): StepUsageTotals[] => state.turnUsage
  const getCostHint = (): string | null => state.costHint

  const adoptHydratedUsage = (hydrated: {
    contextUsage: ChatStreamState['contextUsage']
    turnUsage: StepUsageTotals[]
  }): void => {
    turnUsageSlots = hydrated.turnUsage
    usageTotals = hydrated.turnUsage.reduce(
      (acc, slot) => mergeStepUsageTotals(acc, slot),
      emptyStepUsageTotals()
    )
  }

  const patch = (partial: Partial<ChatStreamState>): void => {
    if (disposed) return
    const touchedItems = Object.prototype.hasOwnProperty.call(partial, 'items')
    const touchedMeta = Object.keys(partial).some((key) => key !== 'items')
    Object.assign(state, partial)
    if (touchedItems && touchedMeta) {
      itemsRevision += 1
      metaRevision += 1
      for (const listener of itemsListeners) listener()
      for (const listener of metaListeners) listener()
      notify()
      return
    }
    if (touchedItems) {
      notifyItems()
      return
    }
    if (touchedMeta) notifyMeta()
  }

  const closeRun = (id: string | null | undefined): void => {
    if (!id) return
    closedRuns.add(id)
  }

  const clearSessionUi = (opts?: { preservePendingCancel?: boolean }): void => {
    assistantId = null
    reasoningId = null
    runId = null
    contentRunId = null
    ignoreStreamEvents = false
    dismissedErrorMessage = null
    lastRunErrorMessage = null
    lastRunErrorCode = null
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    usageTotals = emptyStepUsageTotals()
    turnUsageSlots = []
    clearToolBodyCaches()
    startedToolCallIds.clear()
    if (!opts?.preservePendingCancel) pendingCancel = false
    patch({
      items: [],
      messages: [],
      error: null,
      errorCode: null,
      runNotice: null,
      compacting: false,
      costHint: null,
      incomplete: null,
      networkWait: null,
      contextUsage: null,
      turnUsage: [],
      turnStatus: null,
      runId: null,
      running: false,
      runStartedAt: null,
      pendingRun: false,
      collapsedTurnIndices: [],
      writeCheckpoint: null,
      pendingFollowUps: [],
      agentInstances: {}
    })
  }

  const assignRunId = (id: string): void => {
    if (closedRuns.has(id)) return
    const changed = runId !== id
    runId = id
    contentRunId = id
    patch({ runId: id, pendingRun: false })
    if (changed) {
      onRunIdAssigned?.(id)
      // Subscribe this run for live token streams immediately so its first
      // deltas are never dropped before the bulk UI-subscription sync runs.
      void window.vyotiq?.chatUiSubscribeAdd?.({ runId: id }).catch((err: unknown) =>
        logger.warn('chatUiSubscribeAdd failed', { scope: 'chat', err })
      )
    }
  }

  /** True for events left over from a turn that a newer send has already replaced. */
  const isSupersededEvent = (event: AgentEvent): boolean => {
    // Child lifecycle outlives parent invoke — never drop on supersede.
    if (event.type === 'agent_instance_update') return false
    if (event.invokeId == null) return false
    if (supersededInvokeIds.has(event.invokeId)) return true
    return activeInvokeId != null && event.invokeId !== activeInvokeId
  }

  const discardPendingStreamPatches = (): void => {
    pendingTextDelta = ''
    pendingThinkingDelta = ''
    pendingToolCallDeltas = []
    pendingTerminalByTool.clear()
    pendingToolProgress = []
    flushThinkingPatchTimer()
    flushToolPatchTimer()
    cancelScheduledStreamPatch()
  }

  const setUiSuspended = (suspended: boolean): void => {
    if (disposed) return
    if (suspended === uiSuspended) return
    if (suspended) {
      discardPendingStreamPatches()
      uiSuspended = true
      // Invalidate any in-flight resume so catch-up cannot clear a later suspend.
      uiResumeGeneration += 1
      // needsUiCatchUp is set when stream events are skipped, or by markUiCatchUpNeeded
      // when main drops gated events for an unsubscribed run.
    } else {
      uiSuspended = false
    }
  }

  const markUiCatchUpNeeded = (): void => {
    if (disposed) return
    needsUiCatchUp = true
    // Invalidate an in-flight resume so it cannot unsuspend after this run is hidden.
    uiResumeGeneration += 1
  }

  /** Force-reload transcript while preserving live running state (after UI suspend). */
  const catchUpUiFromDisk = async (id: string): Promise<boolean> => {
    if (closedRuns.has(id) || disposed) return false
    let liveInvokeId: number | null = null
    let stillActive = false
    let pendingFromMain: { id: string; preview: string }[] = []
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (closedRuns.has(id) || disposed) return false
      if (active.ok) {
        const live = active.data.find((entry) => entry.runId === id)
        stillActive = Boolean(live)
        liveInvokeId = live?.invokeId ?? null
        pendingFromMain = live?.pendingFollowUps ?? []
      }
    } else {
      stillActive = state.running || state.pendingRun
    }
    if (!window.vyotiq?.loadRun) return false
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (closedRuns.has(id) || disposed) return false
    if (!res.ok) {
      logger.warn('catchUpUiFromDisk loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (closedRuns.has(id) || disposed) return false
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    const kept = messagesForNextTurn(res.data.messages)
    assistantId = null
    reasoningId = null
    runId = id
    contentRunId = id
    if (liveInvokeId != null) activeInvokeId = liveInvokeId
    const mode = modeFromPersisted(events)
    if (mode) notifyAgentMode(mode)
    const hydratedPending = hydratePendingFollowUps(
      pendingFromMain,
      res.data.pendingFollowUps,
      state.pendingFollowUps
    )
    const hydrated = hydrateFromDisk(kept, events, dismissedErrorMessage, {
      idle: !stillActive,
      priorAgentInstances: state.agentInstances
    })
    adoptHydratedUsage(hydrated)
    patch({
      ...hydrated,
      items: applyPersistedExpansions(hydrated.items),
      pendingFollowUps: hydratedPending,
      runId: id,
      pendingRun: false,
      running: stillActive,
      runStartedAt: stillActive ? state.runStartedAt ?? Date.now() : null,
      ...(eventsLoadError ? { error: eventsLoadError } : {})
    })
    if (!stillActive) onTerminal?.()
    return true
  }

  const resumeUiIfNeeded = async (): Promise<void> => {
    if (disposed) return
    if (!needsUiCatchUp) {
      // A later event / WM poll must not unsuspend while disk catch-up is in flight.
      if (uiCatchUpStartedGen !== 0) return
      setUiSuspended(false)
      recordUiResume(false)
      return
    }
    // Stay suspended until disk catch-up finishes so live events cannot apply
    // and then be clobbered by a stale hydrateFromDisk patch. One pass only:
    // a live stream during await would otherwise loop forever.
    setUiSuspended(true)
    const gen = ++uiResumeGeneration
    uiCatchUpStartedGen = gen
    recordUiResume(true)
    needsUiCatchUp = false
    const id = runId ?? contentRunId
    try {
      const ok = id ? await catchUpUiFromDisk(id) : true
      if (disposed || gen !== uiResumeGeneration) return
      if (!ok) {
        needsUiCatchUp = true
        return
      }
      // Deltas skipped during catch-up are not on this disk snapshot; clear the
      // flag so we unsuspend and continue from the live stream afterward.
      needsUiCatchUp = false
      setUiSuspended(false)
    } finally {
      if (uiCatchUpStartedGen === gen) uiCatchUpStartedGen = 0
    }
  }

  const handleEvent = (event: AgentEvent): void => {
    if (disposed) return
    if (closedRuns.has(event.runId)) return
    if (isSupersededEvent(event)) return

    if (runId) {
      if (event.runId !== runId) return
    } else if (awaitingRun) {
      assignRunId(event.runId)
    } else {
      return
    }

    if (
      ignoreStreamEvents &&
      event.type !== 'follow_up_applied' &&
      event.type !== 'follow_up_dropped' &&
      // Child instance lifecycle outlives parent invoke — must still update cards.
      event.type !== 'agent_instance_update'
    ) {
      return
    }

    if (uiSuspended && !UI_SUSPEND_ALLOWED_EVENTS.has(event.type)) {
      needsUiCatchUp = true
      recordUiSuspendSkip()
      return
    }

    if (
      event.type !== 'text_delta' &&
      event.type !== 'thinking_delta' &&
      event.type !== 'tool_call_delta'
    ) {
      // Scrub before flush so leak text never paints one frame ahead of tool chrome
      // (also covers status/usage events that flush pending text).
      if (isToolShapedTextLeak(pendingTextDelta)) {
        pendingTextDelta = ''
      } else if (pendingTextDelta) {
        pendingTextDelta = stripToolShapedAssistantTextForStream(pendingTextDelta)
      }
      flushStreamingPatches()
      const scrubbed = scrubStreamingAssistantToolLeak(state.items)
      if (scrubbed !== state.items) {
        patch({ items: scrubbed })
      }
    }

    if (event.type === 'text_delta') {
      if (!assistantId) assistantId = messageUiId('assistant', state.messages.length)
      materializePendingToolCallDeltas()
      closeOpenThinkingStep()
      scheduleTextDelta(event.text)
      return
    } else if (event.type === 'thinking_delta') {
      if (!assistantId) assistantId = messageUiId('assistant', state.messages.length)
      if (!reasoningId) reasoningId = assistantId
      scheduleThinkingDelta(event.text)
      return
    } else if (event.type === 'thinking_done') {
      flushStreamingPatches()
      reasoningSegmentBreak = true
      const id = reasoningId
      if (!id) return
      const doneAt = new Date().toISOString()
      patch({
        items: state.items.map((item) =>
          item.kind === 'message' && item.id === id
            ? {
                ...item,
                thinking: applyThinkingSnapshot(item.thinking, event.text),
                thinkingStreaming: false,
                at: item.at ?? doneAt
              }
            : item
        )
      })
      return
    } else if (event.type === 'assistant_message') {
      const id = assistantId ?? messageUiId('assistant', state.messages.length)
      assistantId = null
      reasoningSegmentBreak = true
      const messageAt = new Date().toISOString()
      const content = stripToolShapedAssistantText(event.content)
      // Keep same-turn tool stretches live when this message still has toolCalls.
      // Only close when this is a text-only follow-up (next iteration / final answer).
      const base = event.toolCalls?.length
        ? state.items
        : closeOpenGroupTimings(state.items)
      const exists = base.some((i) => i.kind === 'message' && i.id === id)
      const reasoningTarget =
        event.thinking && reasoningId && reasoningId !== id ? reasoningId : null
      let nextItems = reasoningTarget
        ? base.map((item) =>
            item.kind === 'message' && item.id === reasoningTarget
              ? {
                  ...item,
                  thinking: applyThinkingSnapshot(item.thinking, event.thinking),
                  thinkingStreaming: false
                }
              : item
          )
        : base
      if (exists) {
        nextItems = nextItems.map((item) =>
          item.kind === 'message' && item.id === id
            ? {
                ...item,
                content: content || stripToolShapedAssistantText(item.content),
                thinking: reasoningTarget
                  ? item.thinking
                  : applyThinkingSnapshot(item.thinking, event.thinking),
                thinkingStreaming: false,
                streaming: false,
                at: item.at ?? messageAt
              }
            : item
        )
      } else if (content || (event.thinking && !reasoningTarget)) {
        nextItems = insertAssistantItem(nextItems, {
          kind: 'message',
          id,
          role: 'assistant',
          content,
          thinking: event.thinking,
          thinkingStreaming: false,
          streaming: false,
          at: messageAt
        })
      }
      reasoningId = null
      const nextMessages = appendAssistantWithTools(
        state.messages,
        content,
        event.toolCalls,
        event.thinking
      )
      nextItems = ensureToolRowsForCalls(nextItems, event.toolCalls, state.runStartedAt)
      nextItems = pruneOrphanDeltaToolRows(nextItems, event.toolCalls)
      if (event.toolCalls?.length) {
        for (const tc of event.toolCalls) pendingToolArgsFull.delete(tc.id)
      }
      patch({ items: nextItems, messages: nextMessages })
    } else if (event.type === 'tool_call_delta') {
      scheduleToolCallDelta(event)
      return
    } else if (event.type === 'tool_start') {
      startedToolCallIds.add(event.toolCallId)
      assistantId = null
      const items = state.items
      const toolAt = new Date().toISOString()
      const existingIdx = findToolRowIndex(items, event.toolCallId, event.name)
      const existing =
        existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
      if (existing?.kind === 'tool') {
        patch({
          items: replaceAt(
            items,
            existingIdx,
            withCanonicalToolId(
              {
                ...existing,
                at: existing.at ?? toolAt,
                toolExpanded: existing.toolExpanded,
                tool: withPresentationLock(
                  {
                    ...existing.tool,
                    name: event.name,
                    summary: event.summary,
                    status: 'running' as const
                  },
                  event.name,
                  existing.tool.argsPreview
                )
              },
              event.toolCallId
            )
          )
        })
      } else {
        patch({
          items: appendTool(
            items,
            {
              kind: 'tool' as const,
              id: event.toolCallId,
              at: toolAt,
              toolExpanded: undefined,
              tool: withPresentationLock(
                {
                  id: event.toolCallId,
                  name: event.name,
                  summary: event.summary,
                  status: 'running' as const
                },
                event.name
              )
            },
            state.runStartedAt
          )
        })
      }
    } else if (event.type === 'tool_result') {
      const items = state.items
      const existingIdx = findToolResultRowIndex(
        items,
        event.toolCallId,
        event.name,
        event.summary
      )
      const existing =
        existingIdx >= 0 && items[existingIdx].kind === 'tool' ? items[existingIdx] : undefined
      let nextItems = items
      if (existing?.kind === 'tool') {
        nextItems = replaceAt(
          items,
          existingIdx,
          withCanonicalToolId(
            {
              ...existing,
              // The call is settled, so any prompt it was waiting on is moot.
              approval: undefined,
              // Drop auto-expand so finished bodies collapse; explicit user toggle wins.
              toolExpanded:
                existing.toolExpanded === true || existing.toolExpanded === false
                  ? existing.toolExpanded
                  : undefined,
              tool: {
                ...existing.tool,
                name: event.name,
                summary: event.summary,
                status: event.ok ? 'done' : 'fail',
                content: event.content ?? existing.tool.content,
                contentTruncated: event.contentTruncated ?? existing.tool.contentTruncated
              }
            },
            event.toolCallId
          )
        )
      } else if (existingIdx < 0) {
        // findToolResultRowIndex should have matched any same-name running row
        // (summary, then FIFO). If it still missed, complete the oldest same-name
        // runner instead of appending a second row that leaves the original spinning.
        const runningSame = runningToolIndices(items).filter((idx) => {
          const item = items[idx]
          return item.kind === 'tool' && item.tool.name === event.name
        })
        if (runningSame.length > 0) {
          const idx = runningSame[0]!
          const row = items[idx]
          if (row?.kind === 'tool') {
            nextItems = replaceAt(
              items,
              idx,
              withCanonicalToolId(
                {
                  ...row,
                  approval: undefined,
                  toolExpanded:
                    row.toolExpanded === true || row.toolExpanded === false
                      ? row.toolExpanded
                      : undefined,
                  tool: {
                    ...row.tool,
                    name: event.name,
                    summary: event.summary,
                    status: event.ok ? 'done' : 'fail',
                    content: event.content ?? row.tool.content,
                    contentTruncated: event.contentTruncated ?? row.tool.contentTruncated
                  }
                },
                event.toolCallId
              )
            )
          }
        } else {
          // No live same-name row to complete — create one (hydrate / late result).
          nextItems = appendTool(
            items,
            {
              kind: 'tool' as const,
              id: event.toolCallId,
              tool: {
                id: event.toolCallId,
                name: event.name,
                summary: event.summary,
                status: event.ok ? 'done' : 'fail',
                content: event.content,
                contentTruncated: event.contentTruncated
              }
            },
            state.runStartedAt
          )
        }
      }
      const nextMessages = appendToolResult(
        state.messages,
        event.toolCallId,
        event.name,
        event.content ?? event.summary,
        event.ok
      )
      // Belt-and-suspenders: mode_changed is the primary sync; successful
      // switch_mode tool_result also updates the composer if the live event
      // was dropped (suspend race / orphan buffer).
      if (event.ok && event.name === 'switch_mode') {
        const mode = event.summary?.trim()
        if (mode === 'ask' || mode === 'plan' || mode === 'agent') {
          notifyAgentMode(mode)
        }
      }
      // ask_question UI is a separate item; clear it when the tool settles
      // (answer, interrupt, timeout) so a stale panel cannot outlive the wait.
      const itemsForPatch =
        event.name === 'ask_question'
          ? clearQuestionsForTool(nextItems, event.toolCallId)
          : nextItems
      patch({
        items: closeTrailingGroupIfIdle(itemsForPatch),
        messages: nextMessages
      })
    } else if (event.type === 'terminal_output_delta') {
      const idx = findToolRowIndex(state.items, event.toolCallId, 'terminal')
      const item = idx >= 0 ? state.items[idx] : undefined
      if (!item || item.kind !== 'tool' || item.tool.status !== 'running') return
      const prev = item.tool.content ?? ''
      if (prev.length >= TERMINAL_UI_MAX) return
      const pending = pendingTerminalByTool.get(event.toolCallId) ?? []
      pending.push({ text: event.text, stream: event.stream ?? 'stdout' })
      pendingTerminalByTool.set(event.toolCallId, pending)
      scheduleStreamingPatch()
    } else if (event.type === 'tool_progress') {
      const idx = findToolRowIndex(state.items, event.parentToolCallId)
      const item = idx >= 0 ? state.items[idx] : undefined
      if (!item || item.kind !== 'tool') return
      pendingToolProgress.push({
        parentToolCallId: event.parentToolCallId,
        kind: event.kind,
        text: event.text
      })
      scheduleStreamingPatch()
    } else if (event.type === 'agent_instance_update') {
      patch({
        agentInstances: mergeAgentInstanceUpdate(state.agentInstances, event)
      })
    } else if (event.type === 'mode_changed') {
      notifyAgentMode(event.mode)
    } else if (event.type === 'goal_update' || event.type === 'loop_update') {
      // Banner and sidebar poll artifacts / subscribe via onChatEvent.
    } else if (event.type === 'error') {
      lastRunErrorMessage = event.message
      lastRunErrorCode = event.code ?? null
      dismissedErrorMessage = null
      // Put detail in the log line — AppError sanitize strips message from `err`.
      logger.warn(`Agent run error: ${event.message}`, {
        scope: 'chat',
        correlationId: event.runId,
        code: agentErrorCode(event),
        err: event.message
      })
      patch({
        error: event.message,
        errorCode: event.code ?? null,
        ...(event.code === 'COMPACTION'
          ? { compacting: false, items: settleLiveCompaction(state.items) }
          : {})
      })
    } else if (event.type === 'network_wait') {
      const reconnectIds = new Set([assistantId, reasoningId].filter((id): id is string => !!id))
      patch({
        networkWait: {
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          retryInMs: event.retryInMs,
          ...(event.code ? { code: event.code } : {})
        },
        items: state.items.map((item) =>
          item.kind === 'message' && reconnectIds.has(item.id)
            ? { ...item, reconnecting: true, streaming: false, thinkingStreaming: false }
            : item
        )
      })
    } else if (event.type === 'stream_reset') {
      // Step retry re-streams from scratch — drop partial text/thinking per IPC contract.
      pendingTextDelta = ''
      pendingThinkingDelta = ''
      pendingToolCallDeltas = []
      // Main clears its streamed tool calls before re-streaming; this map must
      // follow or the first new delta merges onto the PREVIOUS attempt's full
      // args (ids like `gemini_${i}` / `pending_${i}` repeat across attempts),
      // corrupting the args preview for the whole retry.
      pendingToolArgsFull.clear()
      startedToolCallIds.clear()
      flushStreamingPatches()
      const reconnectIds = new Set([assistantId, reasoningId].filter((id): id is string => !!id))
      const nextItems = state.items
        .filter(
          (item) =>
            !(item.kind === 'tool' && item.tool.status === 'running' && !item.approval)
        )
        .map((item) =>
          item.kind === 'message' && reconnectIds.has(item.id)
            ? {
                ...item,
                content: '',
                thinking: undefined,
                reconnecting: true,
                streaming: false,
                thinkingStreaming: false
              }
            : item
        )
      patch({ items: nextItems, networkWait: null })
    } else if (event.type === 'incomplete') {
      patch({
        incomplete: { reason: event.reason, message: event.message }
      })
    } else if (event.type === 'compaction_started') {
      patch({ compacting: true })
    } else if (event.type === 'compaction_verifying') {
      const existingCount = state.items.filter((item) => item.kind === 'compaction').length
      const item = liveCompactionItem(event.summary ?? '', event.tokenEstimate, existingCount, {
        id: LIVE_COMPACTION_ID,
        verifyStatus: 'verifying'
      })
      patch({
        compacting: true,
        ...(item ? { items: upsertLiveCompaction(state.items, item) } : {})
      })
    } else if (event.type === 'compaction_verify_retry') {
      const existingCount = state.items.filter((item) => item.kind === 'compaction').length
      const item = liveCompactionItem(event.summary ?? '', undefined, existingCount, {
        id: LIVE_COMPACTION_ID,
        verifyStatus: 'retrying',
        verifyFailures: event.failures
      })
      patch({
        compacting: true,
        ...(item ? { items: upsertLiveCompaction(state.items, item) } : {})
      })
    } else if (event.type === 'compaction_verify_failed') {
      const existingCount = state.items.filter((item) => item.kind === 'compaction').length
      const item = liveCompactionItem(
        event.summary || 'Summary failed verification and was not applied.',
        event.tokenEstimate,
        existingCount,
        { verifyStatus: 'failed', verifyFailures: event.failures }
      )
      patch({
        compacting: false,
        ...(item ? { items: replaceOrInsertCompaction(state.items, item) } : { compacting: false })
      })
    } else if (event.type === 'compaction') {
      const existingCount = state.items.filter((item) => item.kind === 'compaction').length
      const item = liveCompactionItem(event.summary, event.tokenEstimate, existingCount, {
        verifyStatus:
          event.verified === true
            ? 'verified'
            : event.verified === false
              ? 'failed'
              : undefined,
        ...(event.verifyCoverage != null ? { verifyCoverage: event.verifyCoverage } : {}),
        ...(event.verifyFailures && event.verifyFailures.length > 0
          ? { verifyFailures: event.verifyFailures }
          : {})
      })
      patch({
        compacting: false,
        ...(item ? { items: replaceOrInsertCompaction(state.items, item) } : {})
      })
    } else if (event.type === 'token_cost_hint') {
      const msg = event.message?.trim()
      if (msg) patch({ costHint: msg })
    } else if (event.type === 'writes_checkpoint') {
      const files = event.files.map((f) => ({
        path: f.path,
        action: f.action,
        undoable: f.undoable,
        ...(f.resolved ? { resolved: f.resolved } : {}),
        ...(f.conflicted ? { conflicted: f.conflicted } : {})
      }))
      const fullyResolved =
        files.length > 0 && files.every((f) => Boolean(f.resolved) || !f.undoable)
      patch({
        writeCheckpoint: {
          checkpointId: event.checkpointId,
          undone: event.undone === true || fullyResolved,
          files
        }
      })
    } else if (event.type === 'follow_up_queued') {
      // Local send already tracked the entry; ignore duplicates from IPC echo.
      if (state.pendingFollowUps.some((entry) => entry.id === event.id)) return
      patch({
        pendingFollowUps: [
          ...state.pendingFollowUps,
          {
            id: event.id,
            itemId: `followup-${event.id}`,
            preview: event.preview?.trim() || `Follow-up #${event.position}`,
            text: event.preview?.trim() || `Follow-up #${event.position}`
          }
        ]
      })
    } else if (event.type === 'follow_up_applied') {
      const applied = new Set(event.ids)
      const nextPending = state.pendingFollowUps.filter((entry) => !applied.has(entry.id))
      let nextMessages = state.messages
      let nextItems = state.items
      if (event.messages?.length) {
        const existingTail = state.messages.slice(-event.messages.length)
        const alreadyPresent =
          existingTail.length === event.messages.length &&
          existingTail.every((msg, i) => {
            const incoming = event.messages[i]
            return (
              msg.role === incoming?.role &&
              contentDisplayText(msg.content) === contentDisplayText(incoming.content)
            )
          })
        if (!alreadyPresent) {
          nextMessages = messagesForNextTurn([...state.messages, ...event.messages])
          const startIdx = nextMessages.length - event.messages.length
          // Synthetic protocol turns (goal continue) join state.messages for the
          // model but never render as user bubbles.
          const newItems = event.messages
            .map((msg, i) => ({ msg, i }))
            .filter(({ msg }) => !msg.synthetic)
            .map(({ msg, i }) => {
              const followUpId = event.ids[i]
              const pendingEntry = state.pendingFollowUps.find((entry) => entry.id === followUpId)
              const content = msg.content
              const displayText = contentDisplayText(content)
              const imageUrls = contentImages(content)
              const attachments = uiAttachments(content)
              return {
                kind: 'message' as const,
                id: pendingEntry?.itemId ?? messageUiId('user', startIdx + i),
                role: 'user' as const,
                content: displayText,
                images: imageUrls.length ? imageUrls : undefined,
                attachments: attachments.length ? attachments : undefined,
                at: msg.at ?? new Date().toISOString()
              }
            })
          if (newItems.length > 0) nextItems = prependClosed(state.items, newItems)
        }
      }
      turnUsageSlots = alignTurnUsageSlots(
        turnUsageSlots,
        userTurnCount(nextMessages),
        false
      )
      patch({
        pendingFollowUps: nextPending,
        turnUsage: turnUsageSlots,
        ...(nextMessages !== state.messages ? { messages: nextMessages, items: nextItems } : {})
      })
    } else if (event.type === 'follow_up_dropped') {
      const dropped = new Set(event.ids)
      const unappliedItemIds = new Set(
        state.pendingFollowUps.filter((entry) => dropped.has(entry.id)).map((entry) => entry.itemId)
      )
      const droppedCount = state.pendingFollowUps.filter((entry) => dropped.has(entry.id)).length
      const dropNotice =
        droppedCount === 1
          ? 'Queued follow-up was dropped because the run ended.'
          : droppedCount > 1
            ? `${droppedCount} queued follow-ups were dropped because the run ended.`
            : null
      patch({
        pendingFollowUps: state.pendingFollowUps.filter((entry) => !dropped.has(entry.id)),
        ...(dropNotice ? { runNotice: dropNotice } : {}),
        ...(unappliedItemIds.size > 0
          ? { items: state.items.filter((item) => !unappliedItemIds.has(item.id)) }
          : {})
      })
    } else if (event.type === 'step_usage') {
      const usage = stepUsageFromEvent(event)
      if (usage) {
        usageTotals = mergeStepUsageTotals(usageTotals, usage)
        if (turnUsageSlots.length === 0) {
          turnUsageSlots = [emptyStepUsageTotals()]
        }
        const slotIndex = turnUsageSlots.length - 1
        const nextSlots = turnUsageSlots.slice()
        nextSlots[slotIndex] = mergeStepUsageTotals(nextSlots[slotIndex]!, usage)
        turnUsageSlots = nextSlots
        if (state.contextUsage) {
          patch({
            turnUsage: turnUsageSlots,
            contextUsage: {
              ...state.contextUsage,
              stepUsage: usageTotals,
              updatedAt: new Date().toISOString()
            }
          })
        } else {
          // Seed a minimal meter so early step_usage is not discarded before context_usage.
          patch({
            turnUsage: turnUsageSlots,
            contextUsage: {
              step: event.step,
              used: 0,
              estimatedTokens: 0,
              window: 0,
              contentWindow: 0,
              compactionTrigger: 0,
              source: 'estimate',
              layers: { system: 0, history: 0, tools: 0, buffer: 0 },
              stepUsage: usageTotals,
              updatedAt: new Date().toISOString()
            }
          })
        }
      }
    } else if (event.type === 'context_usage') {
      const ctx = contextUsageFromEvent(event, usageTotals, state.contextUsage?.layers)
      if (ctx) patch({ contextUsage: ctx })
    } else if (event.type === 'status') {
      if (event.status === 'running') {
        startedToolCallIds.clear()
        runningTurnSeq = turnSeq
        patch({
          running: true,
          pendingRun: false,
          turnStatus: null,
          // Auto-continue after truncation clears the Continue banner for the next step.
          incomplete: null,
          networkWait: null,
          runStartedAt: state.runStartedAt ?? Date.now(),
          items: state.items.map((item) =>
            item.kind === 'message' && item.reconnecting
              ? { ...item, reconnecting: false }
              : item
          )
        })
      }
      if (event.status === 'done' || event.status === 'cancelled' || event.status === 'error') {
        // When the event carries an invoke we started, attribution is exact and any
        // stale terminal was already dropped. Otherwise — a reattached run, or a
        // replay with no stamp — fall back to the turn sequence.
        const attributed = event.invokeId != null && event.invokeId === activeInvokeId
        if (attributed) {
          // Duplicate terminal for the same invoke (e.g. error + status:error) — finalize once.
          if (ignoreStreamEvents && completedTurnSeq >= turnSeq) return
        } else {
          if (turnSeq > 0 && completedTurnSeq >= turnSeq) return
          if (
            completedTurnSeq > 0 &&
            turnSeq > completedTurnSeq &&
            state.running &&
            turnSeq > runningTurnSeq
          ) {
            return
          }
        }

        awaitingRun = false
        pendingCancel = false
        assistantId = null
        reasoningId = null
        ignoreStreamEvents = true
        completedTurnSeq = turnSeq
        const sessionRunId = runId ?? event.runId
        runId = sessionRunId
        const dropUnapplied = event.status !== 'done'
        const unappliedItemIds = dropUnapplied
          ? new Set(state.pendingFollowUps.map((entry) => entry.itemId))
          : null
        if (event.status === 'error' && !state.error) {
          dismissedErrorMessage = null
        }
        const toolStubReason =
          event.status === 'cancelled'
            ? 'Cancelled'
            : event.status === 'error'
              ? isRetryableTurnFailure({ incompleteReason: state.incomplete?.reason })
                ? 'Connection lost'
                : 'Interrupted'
              : 'Not completed'
        materializePendingToolCallDeltas()
        const finalizedItems = finalizeTerminalItems(
          unappliedItemIds && unappliedItemIds.size > 0
            ? state.items.filter((item) => !unappliedItemIds.has(item.id))
            : state.items,
          toolStubReason,
          startedToolCallIds,
          event.status
        ).map((item) =>
          item.kind === 'message' && item.reconnecting ? { ...item, reconnecting: false } : item
        )
        const errorMessage =
          event.status === 'error' && !state.error
            ? lastRunErrorMessage ?? 'Failed'
            : state.error
        const withRunError =
          event.status === 'error' && errorMessage
            ? [
                ...finalizedItems,
                {
                  kind: 'run_error' as const,
                  id: `run-error:live:${state.runTerminalTick + 1}`,
                  message: errorMessage,
                  ...(lastRunErrorCode ? { code: lastRunErrorCode } : {})
                }
              ]
            : finalizedItems
        patch({
          pendingRun: false,
          running: false,
          runId: sessionRunId,
          runStartedAt: null,
          pendingFollowUps: event.status === 'done' ? state.pendingFollowUps : [],
          networkWait: null,
          compacting: false,
          turnStatus: event.status,
          // Compaction summaries are transcript items, not composer runNotice.
          runNotice: null,
          runTerminalTick: state.runTerminalTick + 1,
          ...(event.status === 'error' && !state.error
            ? { error: errorMessage, errorCode: lastRunErrorCode }
            : {}),
          items: withRunError
        })
        onTerminal?.()
      }
    }
  }

  const send = async (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || state.transcriptLoading)
      return false
    if (state.running) {
      return followUp(text, images, files, extras)
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before starting a chat.' })
      return false
    }
    patch({
      error: null,
      errorCode: null,
      runNotice: null,
      compacting: false,
      costHint: null,
      incomplete: null,
      turnStatus: null,
      networkWait: null
    })
    lastRunErrorMessage = null
    lastRunErrorCode = null
    usageTotals = emptyStepUsageTotals()
    // Keep last contextUsage so the meter does not flicker away between turns;
    // stepUsage resets via usageTotals and is overwritten on the next event.
    pendingCancel = false
    ignoreStreamEvents = false
    void resumeUiIfNeeded()
    // Anything still arriving from the turn we are replacing is now stale, including a
    // terminal status that would otherwise close out this new turn.
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    turnSeq += 1
    const content = buildUserContent(text, images, files, extras)
    const sentAt = new Date().toISOString()
    const user: ChatMessage = { role: 'user', content, at: sentAt }
    const priorMessages = state.messages
    const priorTurnUsage = turnUsageSlots
    const priorTurnStatus = state.turnStatus
    const nextMessages = messagesForNextTurn([...priorMessages, user])
    const userItemId = messageUiId('user', nextMessages.length - 1)
    const imageUrls = contentImages(content)
    const attachments = uiAttachments(content)
    const displayText = contentDisplayText(content)
    turnUsageSlots = alignTurnUsageSlots(
      turnUsageSlots,
      userTurnCount(nextMessages),
      true
    )
    patch({
      messages: nextMessages,
      turnUsage: turnUsageSlots,
      items: prependClosed(state.items, {
        kind: 'message',
        id: userItemId,
        role: 'user',
        content: displayText,
        images: imageUrls.length ? imageUrls : undefined,
        attachments: attachments.length ? attachments : undefined,
        at: sentAt
      })
    })
    assistantId = null
    reasoningId = null
    // After syncFromDisk / idle hydrate, session may live only on contentRunId.
    const continuingRunId = runId ?? contentRunId
    if (continuingRunId) {
      runId = continuingRunId
      contentRunId = continuingRunId
      awaitingRun = false
      patch({
        pendingRun: true,
        running: true,
        runStartedAt: Date.now(),
        runId: continuingRunId
      })
    } else {
      closeRun(runId)
      runId = null
      awaitingRun = true
      patch({ pendingRun: true, running: true, runStartedAt: Date.now(), runId: null })
    }
    const mode = getAgentMode?.() ?? 'agent'
    const focusedFile = getFocusedFile() ?? undefined
    const startPayload = continuingRunId
      ? {
          incremental: true as const,
          newMessages: [user],
          // Everything the client held before this send is already on disk —
          // lets main dedupe positionally (never drops a repeated identical text).
          persistedMessageCount: nextMessages.length - 1,
          workspacePath,
          runId: continuingRunId,
          mode,
          focusedFile
        }
      : {
          messages: nextMessages,
          workspacePath,
          mode,
          focusedFile
        }
    let res = await window.vyotiq.chatStart(startPayload)
    for (let attempt = 2; attempt <= CHAT_START_MAX_ATTEMPTS && !res.ok; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, CHAT_START_RETRY_MS))
      res = await window.vyotiq.chatStart(startPayload)
    }
    if (!res.ok) {
      awaitingRun = false
      const message = res.error
      // Detail in the log line — string `err` keeps scrubbed text; AppError would not.
      logger.error(`chatStart failed: ${message}`, { scope: 'chat', err: res.error, code: res.code })
      turnUsageSlots = priorTurnUsage
      patch({
        error: message,
        errorCode: res.code ?? null,
        turnStatus: priorTurnStatus,
        running: false,
        runStartedAt: null,
        pendingRun: false,
        // Keep the existing session id — only brand-new chats stay null.
        runId: continuingRunId ?? null,
        messages: priorMessages,
        items: state.items.filter((item) => item.id !== userItemId),
        turnUsage: priorTurnUsage
      })
      return false
    }
    if (pendingCancel) {
      pendingCancel = false
      awaitingRun = false
      supersededInvokeIds.add(res.data.invokeId)
      // Existing sessions must not be closeRun'd — that blacklists the real run.
      if (continuingRunId) {
        runId = continuingRunId
        contentRunId = continuingRunId
        patch({
          pendingRun: false,
          running: false,
          runStartedAt: null,
          runId: continuingRunId,
          runNotice: null
        })
      } else {
        closeRun(res.data.runId)
        runId = null
        // Clear the pre-run "Stopping…" notice — chatCancel does not emit a
        // terminal status for a run that never started streaming.
        patch({
          pendingRun: false,
          running: false,
          runStartedAt: null,
          runId: null,
          runNotice: null
        })
      }
      const cancelRes = await window.vyotiq.chatCancel(res.data.runId)
      if (!cancelRes.ok) {
        logger.warn('chatCancel failed after pending stop', {
          scope: 'chat',
          correlationId: res.data.runId,
          err: cancelRes.error
        })
      }
      return true
    }
    if (!closedRuns.has(res.data.runId)) {
      assignRunId(res.data.runId)
    }
    activeInvokeId = res.data.invokeId
    supersededInvokeIds.delete(res.data.invokeId)
    awaitingRun = false
    return true
  }

  const resumeInterrupted = async (): Promise<boolean> => {
    if (state.running || state.pendingRun || state.transcriptLoading) return false
    const continuingRunId = runId ?? contentRunId
    if (!continuingRunId || !workspacePath) return false

    patch({
      error: null,
      errorCode: null,
      runNotice: null,
      compacting: false,
      costHint: null,
      incomplete: null,
      turnStatus: null,
      networkWait: null
    })
    lastRunErrorMessage = null
    lastRunErrorCode = null
    usageTotals = emptyStepUsageTotals()
    pendingCancel = false
    ignoreStreamEvents = false
    void resumeUiIfNeeded()
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    turnSeq += 1

    runId = continuingRunId
    contentRunId = continuingRunId
    awaitingRun = false
    patch({
      pendingRun: true,
      running: true,
      runStartedAt: Date.now(),
      runId: continuingRunId
    })

    const mode = getAgentMode?.() ?? 'agent'
    const startPayload = {
      workspacePath,
      runId: continuingRunId,
      messages: [],
      mode,
      focusedFile: getFocusedFile() ?? undefined
    }
    let res = await window.vyotiq.chatStart(startPayload)
    for (let attempt = 2; attempt <= CHAT_START_MAX_ATTEMPTS && !res.ok; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, CHAT_START_RETRY_MS))
      res = await window.vyotiq.chatStart(startPayload)
    }
    if (!res.ok) {
      awaitingRun = false
      const message = res.error
      logger.error(`chatStart failed: ${message}`, { scope: 'chat', err: res.error, code: res.code })
      // Append the box here too — without it the banner is not suppressed and
      // the turn summary would repeat the message (the duplicate-error path).
      const runErrorItem: UiItem = {
        kind: 'run_error',
        id: `run-error:resume:${state.runTerminalTick + 1}`,
        message,
        ...(res.code ? { code: res.code } : {})
      }
      patch({
        error: message,
        errorCode: res.code ?? null,
        turnStatus: 'error',
        running: false,
        runStartedAt: null,
        pendingRun: false,
        runId: continuingRunId,
        runTerminalTick: state.runTerminalTick + 1,
        items: [...state.items, runErrorItem]
      })
      return false
    }
    if (pendingCancel) {
      pendingCancel = false
      awaitingRun = false
      supersededInvokeIds.add(res.data.invokeId)
      runId = continuingRunId
      contentRunId = continuingRunId
      patch({
        pendingRun: false,
        running: false,
        runStartedAt: null,
        runId: continuingRunId,
        runNotice: null
      })
      const cancelRes = await window.vyotiq.chatCancel(res.data.runId)
      if (!cancelRes.ok) {
        logger.warn('chatCancel failed after pending stop', {
          scope: 'chat',
          correlationId: res.data.runId,
          err: cancelRes.error
        })
      }
      return true
    }
    if (!closedRuns.has(res.data.runId)) {
      assignRunId(res.data.runId)
    }
    activeInvokeId = res.data.invokeId
    supersededInvokeIds.delete(res.data.invokeId)
    awaitingRun = false
    return true
  }

  const editAndResend = async (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || state.transcriptLoading) {
      return false
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before editing a prompt.' })
      return false
    }
    const id = runId ?? contentRunId
    if (!id) {
      patch({ error: 'No run to edit. Send a message first.' })
      return false
    }
    if (
      editMessageIndex < 0 ||
      editMessageIndex >= state.messages.length ||
      state.messages[editMessageIndex]?.role !== 'user'
    ) {
      patch({ error: 'Cannot edit that message.' })
      return false
    }

    const content = buildUserContent(text, images, files, extras)
    const sentAt = new Date().toISOString()
    const user: ChatMessage = { role: 'user', content, at: sentAt }
    const priorMessages = state.messages
    const priorItems = state.items
    const priorFollowUps = state.pendingFollowUps
    const priorIncomplete = state.incomplete
    const priorWriteCheckpoint = state.writeCheckpoint
    const priorCollapsed = state.collapsedTurnIndices
    const priorTurnUsage = turnUsageSlots
    const priorTurnStatus = state.turnStatus
    const nextMessages = messagesForNextTurn([...priorMessages.slice(0, editMessageIndex), user])
    const editedUserId = messageUiId('user', editMessageIndex)
    const nextItems = carryCompactionItems(
      carryTimingFromPriorItems(messagesToUiItems(nextMessages), priorItems).map((item) => {
        if (item.kind === 'message' && item.role === 'user' && item.id === editedUserId) {
          return { ...item, at: sentAt }
        }
        return item
      }),
      priorItems
    )

    turnUsageSlots = alignTurnUsageSlots(
      turnUsageSlots,
      userTurnCount(nextMessages),
      true
    )
    patch({
      error: null,
      runNotice: null,
      compacting: false,
      incomplete: null,
      turnStatus: null,
      writeCheckpoint: null,
      pendingFollowUps: [],
      collapsedTurnIndices: priorCollapsed.filter((i) => i <= editMessageIndex),
      messages: nextMessages,
      items: nextItems,
      turnUsage: turnUsageSlots
    })

    lastRunErrorMessage = null
    usageTotals = emptyStepUsageTotals()
    pendingCancel = false
    ignoreStreamEvents = false
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    turnSeq += 1
    assistantId = null
    reasoningId = null
    clearToolBodyCaches()

    // Bind local session before await so stop() can chatCancel the real id.
    runId = id
    contentRunId = id
    awaitingRun = true
    patch({
      pendingRun: true,
      running: true,
      runStartedAt: Date.now(),
      runId: id
    })

    const mode = getAgentMode?.() ?? 'agent'
    const res = await window.vyotiq.chatRewindAndStart({
      workspacePath,
      runId: id,
      editMessageIndex,
      editedUserMessage: user,
      mode
    })

    if (!res.ok) {
      awaitingRun = false
      logger.error('chatRewindAndStart failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({
        error: res.error,
        running: false,
        runStartedAt: null,
        pendingRun: false,
        runId: id,
        messages: priorMessages,
        items: priorItems,
        pendingFollowUps: priorFollowUps,
        incomplete: priorIncomplete,
        writeCheckpoint: priorWriteCheckpoint,
        collapsedTurnIndices: priorCollapsed,
        turnUsage: priorTurnUsage,
        turnStatus: priorTurnStatus
      })
      turnUsageSlots = priorTurnUsage
      return false
    }

    if (pendingCancel) {
      pendingCancel = false
      awaitingRun = false
      supersededInvokeIds.add(res.data.invokeId)
      // Keep the edited session — do not closeRun/blacklist it.
      runId = id
      contentRunId = id
      patch({
        pendingRun: false,
        running: false,
        runStartedAt: null,
        runId: id,
        runNotice: null
      })
      const cancelRes = await window.vyotiq.chatCancel(res.data.runId)
      if (!cancelRes.ok) {
        logger.warn('chatCancel failed after pending stop (rewind)', {
          scope: 'chat',
          correlationId: res.data.runId,
          err: cancelRes.error
        })
      }
      return true
    }

    if (!closedRuns.has(res.data.runId)) {
      assignRunId(res.data.runId)
    }
    activeInvokeId = res.data.invokeId
    supersededInvokeIds.delete(res.data.invokeId)
    awaitingRun = false
    return true
  }

  const previewRewindToUserMessage = async (
    userMessageIndex: number
  ): Promise<ChatRewindPreviewResult | null> => {
    if (state.transcriptLoading || !workspacePath) return null
    const id = runId ?? contentRunId
    if (!id) return null
    if (
      userMessageIndex < 0 ||
      userMessageIndex >= state.messages.length ||
      state.messages[userMessageIndex]?.role !== 'user'
    ) {
      return null
    }
    if (state.messages.length <= userMessageIndex + 1) return null
    if (state.running || state.pendingRun) return null
    try {
      const res = await window.vyotiq.chatRewindPreview({
        workspacePath,
        runId: id,
        userMessageIndex
      })
      return res.ok ? res.data : null
    } catch {
      return null
    }
  }

  const revertToUserMessage = async (userMessageIndex: number): Promise<RevertWritesOutcome | false> => {
    if (state.transcriptLoading) return false
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before reverting.' })
      return false
    }
    const id = runId ?? contentRunId
    if (!id) {
      patch({ error: 'No run to revert.' })
      return false
    }
    if (
      userMessageIndex < 0 ||
      userMessageIndex >= state.messages.length ||
      state.messages[userMessageIndex]?.role !== 'user'
    ) {
      patch({ error: 'Cannot revert to that message.' })
      return false
    }
    if (state.messages.length <= userMessageIndex + 1) {
      patch({ error: 'Nothing to revert after that prompt.' })
      return false
    }
    if (state.running || state.pendingRun) {
      patch({ error: 'Wait for the run to finish before reverting.' })
      return false
    }

    const priorMessages = state.messages
    const priorItems = state.items
    const priorFollowUps = state.pendingFollowUps
    const priorIncomplete = state.incomplete
    const priorWriteCheckpoint = state.writeCheckpoint
    const priorCollapsed = state.collapsedTurnIndices
    const priorTurnUsage = turnUsageSlots
    const priorTurnStatus = state.turnStatus
    const nextMessages = priorMessages.slice(0, userMessageIndex + 1)
    const nextItems = carryCompactionItems(
      carryTimingFromPriorItems(messagesToUiItems(nextMessages), priorItems),
      priorItems
    )

    turnUsageSlots = alignTurnUsageSlots(
      turnUsageSlots,
      userTurnCount(nextMessages),
      true
    )
    patch({
      error: null,
      runNotice: null,
      compacting: false,
      incomplete: null,
      turnStatus: null,
      writeCheckpoint: null,
      pendingFollowUps: [],
      collapsedTurnIndices: priorCollapsed.filter((i) => i <= userMessageIndex),
      messages: nextMessages,
      items: nextItems,
      turnUsage: turnUsageSlots
    })

    clearToolBodyCaches()
    assistantId = null
    reasoningId = null

    const res = await window.vyotiq.chatRewind({
      workspacePath,
      runId: id,
      userMessageIndex
    })

    if (!res.ok) {
      logger.error('chatRewind failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({
        error: res.error,
        messages: priorMessages,
        items: priorItems,
        pendingFollowUps: priorFollowUps,
        incomplete: priorIncomplete,
        writeCheckpoint: priorWriteCheckpoint,
        collapsedTurnIndices: priorCollapsed,
        turnUsage: priorTurnUsage,
        turnStatus: priorTurnStatus
      })
      turnUsageSlots = priorTurnUsage
      return false
    }

    const authoritativeItems = carryCompactionItems(
      carryTimingFromPriorItems(messagesToUiItems(res.data.messages), priorItems),
      priorItems
    )
    turnUsageSlots = alignTurnUsageSlots(
      turnUsageSlots,
      userTurnCount(res.data.messages),
      true
    )
    patch({
      messages: res.data.messages,
      items: authoritativeItems,
      writeCheckpoint: null,
      turnUsage: turnUsageSlots
    })
    return { restored: res.data.restored, skipped: res.data.skipped }
  }

  const canQueueFollowUp = (): boolean =>
    Boolean(runId) &&
    (state.running || state.pendingRun || state.pendingFollowUps.length > 0)

  const followUp = async (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ): Promise<boolean> => {
    const trimmed = text.trim()
    const id = runId
    const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
    if ((!trimmed && !images?.length && !files?.length && !hasExtras) || !canQueueFollowUp()) return false
    if (!id) {
      patch({
        error: state.pendingRun
          ? 'Wait for the run to start before sending a follow-up.'
          : 'No active run to follow up on.'
      })
      return false
    }
    if (!workspacePath) {
      patch({ error: 'Pick a workspace before sending a follow-up.' })
      return false
    }
    const content = buildUserContent(text, images, files, extras)
    const user: ChatMessage = { role: 'user', content, at: new Date().toISOString() }
    const displayText = contentDisplayText(content)
    const preview = displayText.trim() || (uiAttachments(content).length ? uiAttachments(content)[0]!.name : 'Follow-up')
    const res = await window.vyotiq.chatFollowUp({
      runId: id,
      message: user
    })
    if (!res.ok) {
      logger.warn('chatFollowUp failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    patch({
      pendingFollowUps: [
        ...state.pendingFollowUps.filter((entry) => entry.id !== res.data.id),
        {
          id: res.data.id,
          itemId: `followup-${res.data.id}`,
          preview,
          text: displayText.trim() || preview,
          message: user
        }
      ]
    })
    return true
  }

  const removeFollowUp = async (followUpId: string): Promise<boolean> => {
    const id = runId
    const pending = state.pendingFollowUps.find((entry) => entry.id === followUpId)
    if (!id || !pending) return false
    const res = await window.vyotiq.chatFollowUpRemove({ runId: id, id: followUpId })
    if (!res.ok) {
      logger.warn('chatFollowUpRemove failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    const nextPending = state.pendingFollowUps.filter((entry) => entry.id !== followUpId)
    patch({ pendingFollowUps: nextPending })
    return true
  }

  const editFollowUp = async (followUpId: string, text: string): Promise<boolean> => {
    const id = runId
    const pending = state.pendingFollowUps.find((entry) => entry.id === followUpId)
    const trimmed = text.trim()
    if (!id || !pending || !trimmed || !canQueueFollowUp()) return false
    const content = mergeUserFollowUpText(pending.message?.content, trimmed)
    const user: ChatMessage = { role: 'user', content, at: new Date().toISOString() }
    const res = await window.vyotiq.chatFollowUpUpdate({ runId: id, id: followUpId, message: user })
    if (!res.ok) {
      logger.warn('chatFollowUpUpdate failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    patch({
      pendingFollowUps: state.pendingFollowUps.map((entry) =>
        entry.id === followUpId
          ? { ...entry, preview: res.data.preview, text: trimmed, message: user }
          : entry
      )
    })
    return true
  }

  const sendFollowUpNow = async (followUpId: string): Promise<boolean> => {
    const id = runId
    if (!id || !canQueueFollowUp()) return false
    if (!state.pendingFollowUps.some((entry) => entry.id === followUpId)) return false
    const res = await window.vyotiq.chatFollowUpPromote({ runId: id, id: followUpId })
    if (!res.ok) {
      logger.warn('chatFollowUpPromote failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      return false
    }
    const nextPending = [...state.pendingFollowUps]
    const idx = nextPending.findIndex((entry) => entry.id === followUpId)
    if (idx > 0) {
      const [item] = nextPending.splice(idx, 1)
      nextPending.unshift(item)
      patch({ pendingFollowUps: nextPending })
    }
    return true
  }

  const clearPendingFollowUps = (removeItems: boolean): void => {
    if (state.pendingFollowUps.length === 0) return
    const pending = state.pendingFollowUps
    const itemIds = new Set(pending.map((entry) => entry.itemId))
    let nextMessages = state.messages
    if (removeItems) {
      nextMessages = [...state.messages]
      const indices = pending
        .map((entry) => {
          const match = /^user-(\d+)$/.exec(entry.itemId)
          return match ? Number(match[1]) : -1
        })
        .filter((idx) => idx >= 0)
        .sort((a, b) => b - a)
      for (const idx of indices) {
        if (nextMessages[idx]?.role === 'user') {
          nextMessages.splice(idx, 1)
        }
      }
      // Drop any remaining by preview (reattach / echo itemIds).
      for (const entry of pending) {
        if (/^user-\d+$/.test(entry.itemId)) continue
        for (let i = nextMessages.length - 1; i >= 0; i--) {
          const msg = nextMessages[i]
          if (msg?.role === 'user' && contentDisplayText(msg.content) === entry.preview) {
            nextMessages.splice(i, 1)
            break
          }
        }
      }
    }
    patch({
      pendingFollowUps: [],
      ...(removeItems
        ? {
            items: state.items.filter((item) => !itemIds.has(item.id)),
            messages: nextMessages
          }
        : {})
    })
  }

  const syncFromDisk = async (
    id: string,
    opts?: { ignoreActiveList?: boolean }
  ): Promise<boolean> => {
    if (closedRuns.has(id) || disposed) return false
    // Brief listActiveRuns misses must not force idle while main is still streaming.
    if (!opts?.ignoreActiveList && window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (active.ok && active.data.some((entry) => entry.runId === id)) {
        return false
      }
    }
    if (closedRuns.has(id) || disposed) return false
    if (!window.vyotiq?.loadRun) return false
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (!res.ok) {
      logger.warn('syncFromDisk loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      return false
    }
    // Re-check after awaits — run may have resumed / re-registered.
    if (!opts?.ignoreActiveList && window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (active.ok && active.data.some((entry) => entry.runId === id)) {
        return false
      }
    }
    if (closedRuns.has(id) || disposed) return false
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    const kept = messagesForNextTurn(res.data.messages)
    assistantId = null
    reasoningId = null
    // Keep session id so the next send continues this run (not a forked transcript).
    runId = id
    contentRunId = id
    awaitingRun = false
    pendingCancel = false
    const mode = modeFromPersisted(events)
    if (mode) notifyAgentMode(mode)
    const hydrated = hydrateFromDisk(kept, events, dismissedErrorMessage, {
      idle: true,
      priorAgentInstances: state.agentInstances
    })
    patch({
      ...hydrated,
      items: applyPersistedExpansions(hydrated.items),
      ...(eventsLoadError ? { error: eventsLoadError } : {}),
      pendingFollowUps: hydratePendingFollowUps([], res.data.pendingFollowUps, state.pendingFollowUps),
      runId: id,
      pendingRun: false,
      running: false,
      runStartedAt: null,
      runTerminalTick: state.runTerminalTick + 1
    })
    onTerminal?.()
    return true
  }

  const recoverAfterCancelFailure = async (id: string, cancelError: string): Promise<void> => {
    if (/not found/i.test(cancelError)) {
      const synced = await syncFromDisk(id)
      if (synced) return
    }
    const deadline = Date.now() + CANCEL_RECOVERY_TIMEOUT_MS
    let runStillActive = false
    while (Date.now() < deadline) {
      const active = await window.vyotiq.listActiveRuns?.()
      if (active?.ok) {
        runStillActive = active.data.some((entry) => entry.runId === id)
        if (!runStillActive) {
          const synced = await syncFromDisk(id)
          if (synced) return
          break
        }
      }
      await sleep(CANCEL_RECOVERY_POLL_MS)
    }
    if (runStillActive) {
      // Stop failed and main is still streaming — keep the composer locked and
      // let the eventual terminal status (or a later disk sync) settle the run
      // instead of unlocking over live events. Stop stays clickable for a manual
      // retry; meanwhile keep retrying in the background so a transient IPC
      // failure cannot strand the UI in a running state forever.
      patch({ error: `${cancelError} Click Stop to retry.` })
      const retryDeadline = Date.now() + CANCEL_BACKGROUND_RETRY_MS
      while (Date.now() < retryDeadline) {
        await sleep(CANCEL_BACKGROUND_RETRY_EVERY_MS)
        if (closedRuns.has(id) || disposed) return
        const retry = await window.vyotiq.chatCancel(id)
        if (retry.ok) return // terminal events settle the UI via the normal path
        const active = await window.vyotiq.listActiveRuns?.()
        const stillActive = active?.ok ? active.data.some((entry) => entry.runId === id) : false
        if (!stillActive) {
          const synced = await syncFromDisk(id)
          if (synced) return
          break
        }
      }
      return
    }
    discardPendingStreamPatches()
    patch({
      error: cancelError,
      running: false,
      pendingRun: false,
      runStartedAt: null,
      compacting: false,
      runTerminalTick: state.runTerminalTick + 1,
      items: finalizeTerminalItems(state.items, 'Cancelled', startedToolCallIds, 'cancelled')
    })
    clearPendingFollowUps(true)
    onTerminal?.()
  }

  const stop = async (): Promise<void> => {
    const queuedFollowUpCount = state.pendingFollowUps.length
    if (queuedFollowUpCount > 0) {
      const noun = queuedFollowUpCount === 1 ? 'follow-up' : 'follow-ups'
      if (
        !window.confirm(
          `Stop this run and discard ${queuedFollowUpCount} queued ${noun}?`
        )
      ) {
        return
      }
    }
    const id = runId
    // While chatStart/rewind is in flight, activeInvokeId is still null — a lone
    // chatCancel can lose the race against the terminal guard. Always arm
    // pendingCancel so the start path unwinds after chatStart resolves.
    const awaitingStart =
      state.pendingRun || awaitingRun || (Boolean(state.running) && activeInvokeId == null)
    if (!id) {
      pendingCancel = true
      if (state.pendingRun || state.running || awaitingRun) {
        patch({ runNotice: 'Stopping…' })
      }
      return
    }
    if (awaitingStart) {
      pendingCancel = true
      patch({ runNotice: 'Stopping…' })
    }
    // Do not clear follow-ups before cancel succeeds — a failed cancel would
    // drop UI rows while main still holds the queue.
    const res = await window.vyotiq.chatCancel(id)
    if (!res.ok) {
      logger.warn('chatCancel failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      // pendingCancel still covers an in-flight chatStart that has not registered yet.
      if (awaitingStart) return
      await recoverAfterCancelFailure(id, res.error)
      return
    }
    // Successful cancel: terminal status clears follow-ups; clear optimistically
    // only after main accepted cancel so a failed cancel cannot lose UI state.
    clearPendingFollowUps(true)
  }

  const reset = (): void => {
    const id = runId
    if (id) {
      closeRun(id)
      void window.vyotiq.chatCancel(id).then(async (res) => {
        if (!res.ok) await recoverAfterCancelFailure(id, res.error)
      })
      awaitingRun = false
      clearSessionUi()
      return
    }
    if (awaitingRun) {
      pendingCancel = true
      clearSessionUi({ preservePendingCancel: true })
      return
    }
    clearSessionUi()
    awaitingRun = false
  }

  const applyTranscriptUi = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    const kept = messagesForNextTurn(loaded)
    const rows = events ?? []
    assistantId = null
    reasoningId = null
    if (activeInvokeId != null) supersededInvokeIds.add(activeInvokeId)
    activeInvokeId = null
    clearToolBodyCaches()
    startedToolCallIds.clear()
    const mode = modeFromPersisted(rows)
    if (mode) notifyAgentMode(mode)
    const hydrated = hydrateFromDisk(kept, rows, dismissedErrorMessage, {
      idle: true,
      priorAgentInstances: state.agentInstances
    })
    adoptHydratedUsage(hydrated)
    patch({
      // Transcript load / sidebar switch — run is not live on this controller.
      ...hydrated,
      items: applyPersistedExpansions(hydrated.items)
    })
  }

  /** Replace session UI and cancel any in-flight run on this controller. */
  const loadTranscript = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    const id = runId
    if (id) {
      closeRun(id)
      void window.vyotiq.chatCancel(id).then(async (res) => {
        if (!res.ok) await recoverAfterCancelFailure(id, res.error)
      })
      pendingCancel = false
      awaitingRun = false
    } else if (awaitingRun) {
      pendingCancel = true
      awaitingRun = false
    } else {
      pendingCancel = false
    }
    runId = null
    contentRunId = null
    patch({
      pendingRun: false,
      running: false,
      runId: null,
      runStartedAt: null,
      collapsedTurnIndices: []
    })
    applyTranscriptUi(loaded, events)
  }

  /** Hydrate UI from disk without canceling — used for restore and tab select. */
  const hydrateTranscript = (loaded: ChatMessage[], events?: PersistedEvent[]): void => {
    if (disposed) return
    // Never clobber an in-flight live stream with a lagging disk snapshot.
    if (state.running || state.pendingRun || awaitingRun) return
    applyTranscriptUi(loaded, events)
  }

  const reattachActiveRun = async (id: string): Promise<void> => {
    if (closedRuns.has(id) || disposed) return
    // Poll can race terminal status while main unwinds — don't resurrect a finished turn.
    if (!state.running && state.runTerminalTick > 0 && state.runId === id) {
      await syncFromDisk(id, { ignoreActiveList: true })
      return
    }
    // Poll/mount can race a terminal status — verify the run is still live.
    let liveInvokeId: number | null = null
    let pendingFromMain: { id: string; preview: string }[] = []
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
      const live = active.data.find((entry) => entry.runId === id)
      liveInvokeId = live?.invokeId ?? null
      pendingFromMain = live?.pendingFollowUps ?? []
    }
    if (closedRuns.has(id) || disposed) return
    runId = id
    contentRunId = id
    // Live reattach must accept new events even if a prior terminal set ignoreStreamEvents.
    ignoreStreamEvents = false
    if (liveInvokeId != null) activeInvokeId = liveInvokeId
    let hydratedPending = hydratePendingFollowUps(
      pendingFromMain,
      undefined,
      state.pendingFollowUps
    )

    if (!window.vyotiq?.loadRun) {
      patch({
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: null,
        pendingFollowUps: hydratedPending
      })
      return
    }
    const res = await window.vyotiq.loadRun(workspacePath, id)
    if (closedRuns.has(id) || disposed) return
    // TOCTOU: run may have finished while we loaded disk.
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
      const live = active.data.find((entry) => entry.runId === id)
      if (live?.invokeId != null) activeInvokeId = live.invokeId
      if (live?.pendingFollowUps) {
        pendingFromMain = live.pendingFollowUps
      }
    }
    if (!res.ok) {
      logger.warn('reattachActiveRun loadRun failed', {
        scope: 'chat',
        correlationId: id,
        err: toLogErr(res.error)
      })
      // Still mark running if list said live — live events will catch up.
      patch({
        runId: id,
        running: true,
        pendingRun: false,
        runStartedAt: state.runStartedAt ?? Date.now(),
        error: null,
        pendingFollowUps: hydratedPending
      })
      return
    }
    let events: PersistedEvent[] = []
    let eventsLoadError: string | null = null
    if (window.vyotiq.loadRunEvents) {
      const eventsRes = await window.vyotiq.loadRunEvents(workspacePath, id)
      if (closedRuns.has(id) || disposed) return
      if (eventsRes.ok) events = eventsRes.data
      else eventsLoadError = eventsRes.error
    }
    // Final active check before committing running:true + hydrate.
    if (window.vyotiq?.listActiveRuns) {
      const active = await window.vyotiq.listActiveRuns()
      if (!active.ok || !active.data.some((entry) => entry.runId === id)) {
        await syncFromDisk(id)
        return
      }
    }
    const kept = messagesForNextTurn(res.data.messages)
    const mode = modeFromPersisted(events)
    if (mode) notifyAgentMode(mode)
    const refreshedPending = hydratePendingFollowUps(
      pendingFromMain,
      res.data.pendingFollowUps,
      hydratedPending
    )
    const hydrated = hydrateFromDisk(kept, events, dismissedErrorMessage, {
      priorAgentInstances: state.agentInstances
    })
    adoptHydratedUsage(hydrated)
    const pendingQuestions = state.items.filter(
      (item): item is Extract<UiItem, { kind: 'question' }> => item.kind === 'question'
    )
    const mergedItems = applyPersistedExpansions(
      pendingQuestions.length === 0
        ? hydrated.items
        : [
            ...hydrated.items,
            ...pendingQuestions.filter(
              (q) => !hydrated.items.some((item) => item.kind === 'question' && item.id === q.id)
            )
          ]
    )
    patch({
      ...hydrated,
      items: mergedItems,
      messages: kept,
      runId: id,
      running: true,
      pendingRun: false,
      runStartedAt: state.runStartedAt ?? Date.now(),
      error: eventsLoadError,
      pendingFollowUps: refreshedPending
    })
  }

  const setToolExpanded = (toolCallId: string, expanded: boolean): void => {
    if (expanded) expandedToolIds.add(toolCallId)
    else expandedToolIds.delete(toolCallId)
    if (!expanded) {
      const preview = toolContentPreviews.get(toolCallId)
      const full = toolContentCache.get(toolCallId)
      if (preview != null && full != null && full !== preview) {
        toolContentCache.delete(toolCallId)
        patch({
          items: state.items.map((item) =>
            item.kind === 'tool' && (item.id === toolCallId || item.tool.id === toolCallId)
              ? {
                  ...item,
                  toolExpanded: false,
                  tool: {
                    ...item.tool,
                    content: preview,
                    contentTruncated: true
                  }
                }
              : item
          )
        })
        notifyExpansions()
        return
      }
    }
    patch({
      items: state.items.map((item) =>
        item.kind === 'tool' && (item.id === toolCallId || item.tool.id === toolCallId)
          ? { ...item, toolExpanded: expanded }
          : item
      )
    })
    notifyExpansions()
  }

  const setGroupExpanded = (anchorToolCallId: string, expanded: boolean): void => {
    if (expanded) expandedGroupIds.add(anchorToolCallId)
    else expandedGroupIds.delete(anchorToolCallId)
    patch({
      items: state.items.map((item) =>
        item.kind === 'tool' && (item.id === anchorToolCallId || item.tool.id === anchorToolCallId)
          ? { ...item, groupExpanded: expanded }
          : item
      )
    })
    notifyExpansions()
  }

  const handleApprovalRequest = (request: ToolApprovalRequest): void => {
    if (closedRuns.has(request.runId)) return
    if (runId && request.runId !== runId) return

    const approval = {
      requestId: request.requestId,
      toolName: request.name,
      summary: request.summary,
      argsPreview: request.argsPreview,
      mutating: request.mutating
    }

    const idx = findToolRowIndex(state.items, request.toolCallId, request.name)
    if (idx >= 0 && state.items[idx]?.kind === 'tool') {
      const item = state.items[idx]
      if (item.kind !== 'tool') return
      patch({
        items: replaceAt(state.items, idx, {
          ...item,
          approval
        })
      })
      return
    }

    // Tool row not yet visible — create a running stub so the approval card has a home.
    patch({
      items: appendTool(
        state.items,
        {
          kind: 'tool',
          id: request.toolCallId,
          at: new Date().toISOString(),
          approval,
          tool: withPresentationLock(
            {
              id: request.toolCallId,
              name: request.name,
              summary: request.summary,
              status: 'running',
              argsPreview: request.argsPreview
            },
            request.name,
            request.argsPreview
          )
        },
        state.runStartedAt
      )
    })
  }

  const respondToApproval = async (
    requestId: string,
    decision: ToolApprovalDecision
  ): Promise<void> => {
    // Failures throw for ToolApprovalCard localError only — do not patch composer error.
    if (!runId) {
      throw new Error('No active run for approval response.')
    }
    const res = await window.vyotiq?.respondToolApproval?.(requestId, decision, runId)
    if (!res) {
      logger.warn('Tool approval response unavailable', { scope: 'chat' })
      throw new Error('Tool approval response is unavailable.')
    }
    if (!res.ok) {
      logger.warn('Tool approval response rejected', {
        scope: 'chat',
        err: toLogErr(res.error)
      })
      throw new Error(res.error)
    }
    if (res.data !== true) {
      logger.warn('Tool approval response not accepted', { scope: 'chat' })
      throw new Error('Tool approval was not accepted. Try again.')
    }
    patch({ items: clearApprovals(state.items, requestId), error: null })
  }

  const handleQuestionRequest = (request: AgentQuestionRequest): void => {
    if (closedRuns.has(request.runId)) return
    if (runId && request.runId !== runId) return

    const questionItem: Extract<UiItem, { kind: 'question' }> = {
      kind: 'question',
      id: `question:${request.requestId}`,
      question: {
        requestId: request.requestId,
        toolCallId: request.toolCallId,
        ...(request.title ? { title: request.title } : {}),
        questions: request.questions.map((q) => ({
          id: q.id,
          prompt: q.prompt,
          type: q.type,
          ...(q.options?.length ? { options: q.options } : {}),
          ...(q.allowCustom === true ? { allowCustom: true } : {})
        }))
      },
      at: new Date().toISOString()
    }
    const existingIdx = state.items.findIndex(
      (item) => item.kind === 'question' && item.question.requestId === request.requestId
    )
    if (existingIdx >= 0) {
      patch({ items: replaceAt(state.items, existingIdx, questionItem) })
      return
    }
    patch({ items: [...state.items, questionItem] })
  }

  const respondToQuestion = async (
    requestId: string,
    answers: AgentQuestionAnswer[]
  ): Promise<void> => {
    if (!runId) {
      const message = 'No active run for question response.'
      patch({ error: message })
      throw new Error(message)
    }
    const res = await window.vyotiq?.respondAgentQuestion?.(requestId, answers, runId)
    if (!res) {
      const message = 'Question response is unavailable.'
      logger.warn('Agent question response unavailable', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    if (!res.ok) {
      logger.warn('Agent question response rejected', {
        scope: 'chat',
        err: toLogErr(res.error)
      })
      patch({ error: res.error })
      throw new Error(res.error)
    }
    // Main returns ok(false) when the requestId is unknown — leave the card so
    // the user can retry; otherwise the run stays parked with no UI.
    if (res.data !== true) {
      const message = 'Question answer was not accepted. Try again.'
      logger.warn('Agent question response not accepted', { scope: 'chat' })
      patch({ error: message })
      throw new Error(message)
    }
    patch({ items: clearQuestions(state.items, requestId), error: null })
  }

  const clearError = (): void => {
    const dismissed = state.error
    if (dismissed) dismissedErrorMessage = dismissed
    patch({
      error: null,
      errorCode: null,
      // Symmetric with the banner: dismiss drops the matching error boxes too,
      // and hydration skips them so they stay dismissed for the session.
      items: dismissed
        ? state.items.filter((item) => !(item.kind === 'run_error' && item.message === dismissed))
        : state.items
    })
  }

  const setThinkingExpanded = (messageId: string, expanded: boolean): void => {
    if (expanded) expandedThinkingIds.add(messageId)
    else expandedThinkingIds.delete(messageId)
    patch({
      items: state.items.map((item) =>
        item.kind === 'message' && item.id === messageId
          ? { ...item, thinkingExpanded: expanded }
          : item
      )
    })
    notifyExpansions()
  }

  const toggleTurnCollapsed = (turnIndex: number): void => {
    const collapsed = new Set(state.collapsedTurnIndices)
    if (!collapsed.delete(turnIndex)) collapsed.add(turnIndex)
    patch({ collapsedTurnIndices: [...collapsed] })
    notifyExpansions()
  }

  const patchToolContent = (toolCallId: string, content: string): void => {
    const idx = findToolRowIndex(state.items, toolCallId)
    const existing = idx >= 0 && state.items[idx]?.kind === 'tool' ? state.items[idx] : undefined
    if (existing?.kind === 'tool' && existing.tool.contentTruncated) {
      toolContentPreviews.set(toolCallId, existing.tool.content ?? '')
    } else if (!toolContentPreviews.has(toolCallId)) {
      const preview =
        content.length > TOOL_RESULT_IPC_PREVIEW_CHARS
          ? `${content.slice(0, TOOL_RESULT_IPC_PREVIEW_CHARS)}\n…`
          : content
      toolContentPreviews.set(toolCallId, preview)
    }
    toolContentCache.set(toolCallId, content)
    if (idx < 0 || state.items[idx]?.kind !== 'tool') return
    patch({
      items: state.items.map((item, i) =>
        i === idx && item.kind === 'tool'
          ? {
              ...item,
              tool: {
                ...item.tool,
                content,
                contentTruncated: false
              }
            }
          : item
      )
    })
  }

  const loadToolContent = async (toolCallId: string): Promise<string | null> => {
    const cached = toolContentCache.get(toolCallId)
    if (cached) return cached

    const id = runId ?? contentRunId
    if (!id || !window.vyotiq?.loadToolResult) return null

    const res = await window.vyotiq.loadToolResult(workspacePath, id, toolCallId)
    if (disposed) return null
    if (!res.ok) {
      // A run interrupted mid-tool-call never persisted a result line; that is
      // expected after a crash/quit, not a failure worth warn-level noise.
      const notFound = /tool result not found/i.test(res.error ?? '')
      const log = notFound ? logger.debug.bind(logger) : logger.warn.bind(logger)
      log('loadToolResult failed', {
        scope: 'chat',
        correlationId: id,
        toolCallId,
        err: toLogErr(res.error)
      })
      const idx = findToolRowIndex(state.items, toolCallId)
      const item = idx >= 0 ? state.items[idx] : undefined
      if (item?.kind === 'tool') {
        const notice = notFound
          ? 'Full output not saved — the run was interrupted before this tool finished.'
          : "Couldn't load full output."
        patch({
          items: replaceAt(state.items, idx, {
            ...item,
            tool: {
              ...item.tool,
              content: item.tool.content ? `${item.tool.content}\n\n${notice}` : notice,
              // Stop expand retries from looping on a permanent failure.
              contentTruncated: false
            }
          })
        })
      }
      return null
    }
    patchToolContent(toolCallId, res.data.content)
    return res.data.content
  }

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const subscribeItems = (listener: () => void): (() => void) => {
    itemsListeners.add(listener)
    return () => itemsListeners.delete(listener)
  }

  const subscribeMeta = (listener: () => void): (() => void) => {
    metaListeners.add(listener)
    return () => metaListeners.delete(listener)
  }

  const setTranscriptLoading = (loading: boolean): void => {
    if (disposed) return
    patch({ transcriptLoading: loading })
  }

  const applyManualCompaction = (result: {
    summary: string
    estimatedTokens?: number
    contextWindow?: number
    contentWindow?: number
    tokenEstimate: number
    verified?: boolean
    verifyCoverage?: number
    verifyFailures?: string[]
  }): void => {
    if (disposed) return
    const estimated = result.estimatedTokens ?? result.tokenEstimate
    const prev = state.contextUsage
    const summaryTokens = Math.max(0, result.tokenEstimate)
    const historyTokens = Math.max(0, estimated - summaryTokens)
    const window = result.contextWindow ?? prev?.window ?? 0
    const contentBudget =
      result.contentWindow ?? prev?.contentWindow ?? (window > 0 ? contentWindowFromRaw(window) : 0)
    const buffer = remainingContentTokens(contentBudget, estimated)
    // Summary is injected into system on the next assemble; kept turns are history.
    const compactLayers = {
      system: summaryTokens,
      history: historyTokens,
      tools: 0,
      buffer
    }
    const existingCount = state.items.filter((row) => row.kind === 'compaction').length
    const item = liveCompactionItem(result.summary, result.tokenEstimate, existingCount, {
      verifyStatus: result.verified === false ? 'failed' : 'verified',
      ...(result.verifyCoverage != null ? { verifyCoverage: result.verifyCoverage } : {}),
      ...(result.verifyFailures && result.verifyFailures.length > 0
        ? { verifyFailures: result.verifyFailures }
        : {})
    })
    patch({
      compacting: false,
      ...(item ? { items: replaceOrInsertCompaction(state.items, item) } : {}),
      contextUsage: prev
        ? {
            ...prev,
            used: estimated,
            estimatedTokens: estimated,
            inputTokens: undefined,
            source: 'estimate',
            window: result.contextWindow ?? prev.window,
            contentWindow: result.contentWindow ?? prev.contentWindow,
            layers: compactLayers,
            // Manual compact cleared wire overflow; do not keep a stale danger flag.
            overflow: false,
            updatedAt: new Date().toISOString()
          }
        : result.contextWindow && result.contentWindow
          ? {
              step: 0,
              used: estimated,
              estimatedTokens: estimated,
              window: result.contextWindow,
              contentWindow: result.contentWindow,
              compactionTrigger: contentWindowFromRaw(result.contextWindow),
              source: 'estimate',
              layers: compactLayers,
              stepUsage: emptyStepUsageTotals(),
              overflow: false,
              updatedAt: new Date().toISOString()
            }
          : prev
    })
  }

  const setCompacting = (next: boolean): void => {
    if (disposed) return
    if (state.compacting === next) return
    patch({ compacting: next })
  }

  const applyWriteCheckpointResolution = (result: {
    checkpointId: string
    kept: string[]
    discarded: string[]
    conflicted?: string[]
    fullyResolved: boolean
  }): void => {
    if (disposed) return
    const current = state.writeCheckpoint
    if (!current) return
    const kept = new Set(result.kept)
    const discarded = new Set(result.discarded)
    const conflicted = new Set(result.conflicted ?? [])
    const files = current.files.map((f) => {
      if (kept.has(f.path)) return { ...f, resolved: 'kept' as const, conflicted: undefined }
      if (discarded.has(f.path)) return { ...f, resolved: 'discarded' as const, conflicted: undefined }
      if (conflicted.has(f.path)) return { ...f, conflicted: true as const }
      return f
    })
    patch({
      writeCheckpoint: {
        ...current,
        files,
        undone: result.fullyResolved || files.every((f) => Boolean(f.resolved))
      }
    })
  }

  const dispose = (): void => {
    disposed = true
    flushStreamingPatches()
    listeners.clear()
    itemsListeners.clear()
    metaListeners.clear()
  }

  const controller: ChatStreamController = {
    get items() {
      return state.items
    },
    get messages() {
      return state.messages
    },
    get running() {
      return state.running
    },
    get runId() {
      return state.runId
    },
    get error() {
      return state.error
    },
    get errorCode() {
      return state.errorCode
    },
    get runNotice() {
      return state.runNotice
    },
    get compacting() {
      return state.compacting
    },
    get costHint() {
      return state.costHint
    },
    get incomplete() {
      return state.incomplete
    },
    get networkWait() {
      return state.networkWait
    },
    get contextUsage() {
      return state.contextUsage
    },
    get turnUsage() {
      return state.turnUsage
    },
    get turnStatus() {
      return state.turnStatus
    },
    get runStartedAt() {
      return state.runStartedAt
    },
    get runTerminalTick() {
      return state.runTerminalTick
    },
    get pendingRun() {
      return state.pendingRun
    },
    get transcriptLoading() {
      return state.transcriptLoading
    },
    get collapsedTurnIndices() {
      return state.collapsedTurnIndices
    },
    get writeCheckpoint() {
      return state.writeCheckpoint
    },
    get pendingFollowUps() {
      return state.pendingFollowUps
    },
    get agentInstances() {
      return state.agentInstances
    },
    get disposed() {
      return disposed
    },
    get uiSuspended() {
      return uiSuspended
    },
    workspacePath,
    getInvokeId: () => activeInvokeId,
    send,
    resumeInterrupted,
    editAndResend,
    revertToUserMessage,
    previewRewindToUserMessage,
    removeFollowUp,
    editFollowUp,
    sendFollowUpNow,
    stop,
    reset,
    loadTranscript,
    hydrateTranscript,
    reattachActiveRun,
    clearError,
    loadToolContent,
    setThinkingExpanded,
    setToolExpanded,
    setGroupExpanded,
    toggleTurnCollapsed,
    handleApprovalRequest,
    respondToApproval,
    handleQuestionRequest,
    respondToQuestion,
    syncFromDisk,
    applyManualCompaction,
    setCompacting,
    applyWriteCheckpointResolution,
    handleEvent,
    setUiSuspended,
    markUiCatchUpNeeded,
    resumeUiIfNeeded,
    subscribe,
    subscribeItems,
    subscribeMeta,
    getRevision,
    getItemsRevision,
    getMetaRevision,
    getContextUsage,
    getTurnUsage,
    getCostHint,
    setTranscriptLoading,
    dispose
  }

  return controller
}
