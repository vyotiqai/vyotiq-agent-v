import { existsSync, rmSync } from 'fs'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { AgentEvent, ChatMessage, PersistedEvent } from '../../shared/ipc'
import { contentDisplayText } from '../../shared/ipc'
import {
  planRewindWritesAcrossRuns,
  rewindWritesFromScopes,
  type RewindRunScope,
  type RewindWritesPlan,
  type RewindWritesResult
} from './checkpoints'
import {
  loadCompaction,
  loadEventsAsync,
  loadMessagesAsync,
  saveCompaction,
  syncEventsAsync,
  syncMessagesAsync,
  updateStatus,
  flushEventAppends,
  flushStatusWrites,
  loadStatus,
  readContract
} from './state'
import { resolveRunDir, workspaceSessionsRoot } from '../storage/paths'
import { cancelRun, clearFollowUps, isActive, waitUntilRunInactive } from './runRegistry'
import { clearFollowUps as clearFollowUpsOnDisk } from './followUpStore'
import { logger } from '../../shared/logger'
import { writeRunReceiptBestEffort } from './runReceipt'
import { writeTrajectoryArtifactsBestEffort } from './runTrajectory'
import { syncTodosAfterRewind } from './tools/todo'

export type PrepareRewindResult = {
  messages: ChatMessage[]
  writes: RewindWritesResult
}

function keptToolCallIds(messages: ChatMessage[]): Set<string> {
  const ids = new Set<string>()
  for (const m of messages) {
    if (m.role === 'assistant' && m.toolCalls) {
      for (const tc of m.toolCalls) ids.add(tc.id)
    }
    if (m.role === 'tool' && m.toolCallId) ids.add(m.toolCallId)
  }
  return ids
}

function eventToolCallId(event: AgentEvent): string | undefined {
  if ('toolCallId' in event && typeof event.toolCallId === 'string' && event.toolCallId) {
    return event.toolCallId
  }
  return undefined
}

/**
 * The row that opens the rewound turn: the invoke that answered the rewound
 * prompt, or the follow-up drain that applied it mid-run. A `status: running`
 * row does not name its prompt, so an invoke is matched by starting at or after
 * the moment the prompt was sent.
 */
function opensRewoundTurn(row: PersistedEvent, event: AgentEvent, rewoundUserAt: string): boolean {
  if (event.type === 'follow_up_applied') {
    return event.messages.some((m) => m.role === 'user' && m.at === rewoundUserAt)
  }
  if (event.type !== 'status' || event.status !== 'running') return false
  const startedMs = Date.parse(row.at)
  const sentMs = Date.parse(rewoundUserAt)
  return !Number.isNaN(startedMs) && !Number.isNaN(sentMs) && startedMs >= sentMs
}

/**
 * Truncate events to those that still belong to kept message history.
 * Cuts at the first event that references a dropped tool call or a rewound
 * write checkpoint, or — when the rewound prompt's send time is known — at the
 * row that opened its turn. The tool cut alone missed a turn that failed before
 * calling any tool: its `error` and `status: error` survived the rewind and
 * reappeared in the timeline under the resent prompt.
 *
 * Rows keep their original `at`.
 */
function truncateEvents(
  persisted: PersistedEvent[],
  keptIds: Set<string>,
  rewoundCheckpointIds: Set<string>,
  rewoundUserAt?: string
): PersistedEvent[] {
  // A row naming a kept tool call is kept history, so the turn cut never lands
  // before the last one. Rewinds used to re-stamp every row they kept, which can
  // make older turns look newer than the prompt being rewound.
  let lastKeptToolRow = -1
  if (rewoundUserAt) {
    persisted.forEach((row, index) => {
      const ev = row.event
      if (!ev || typeof ev !== 'object' || !('type' in ev)) return
      const toolId = eventToolCallId(ev as AgentEvent)
      if (toolId && keptIds.has(toolId)) lastKeptToolRow = index
    })
  }
  const kept: PersistedEvent[] = []
  for (let index = 0; index < persisted.length; index++) {
    const row = persisted[index]!
    const ev = row.event
    if (!ev || typeof ev !== 'object' || !('type' in ev)) continue
    const agentEvent = ev as AgentEvent
    if (
      rewoundUserAt &&
      index > lastKeptToolRow &&
      opensRewoundTurn(row, agentEvent, rewoundUserAt)
    ) {
      break
    }
    if (agentEvent.type === 'writes_checkpoint') {
      if (rewoundCheckpointIds.has(agentEvent.checkpointId)) break
      kept.push(row)
      continue
    }
    const toolId = eventToolCallId(agentEvent)
    if (toolId && !keptIds.has(toolId)) break
    kept.push(row)
  }
  return kept
}

/**
 * Locate the parent user message whose turn spawned `childRunId`. The spawn
 * tool result (`run_id: <id>`) is the first tool message naming the run, and
 * the newest user message before it anchors the instance to a turn — the same
 * anchor rule parent write checkpoints use.
 */
function deriveInstanceSpawnAnchorIndex(
  messages: ChatMessage[],
  childRunId: string
): number | undefined {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i]
    if (!message || message.role !== 'tool') continue
    if (!contentDisplayText(message.content).includes(childRunId)) continue
    for (let j = i; j >= 0; j--) {
      if (messages[j]?.role === 'user') return j
    }
    return undefined
  }
  return undefined
}

type SharedWorkspaceInstance = { runId: string; runDir: string }

/**
 * Inline instance runs of `parentRunId` that wrote into the shared workspace.
 * Worktree instances snapshot their own checkout, not this workspace — their
 * edits reach the parent only through merge_agent_instance — so they are not
 * part of the checkpoint rewind.
 */
async function listSharedWorkspaceInstances(
  workspacePath: string,
  parentRunId: string
): Promise<SharedWorkspaceInstance[]> {
  const root = workspaceSessionsRoot(workspacePath)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found: SharedWorkspaceInstance[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    let runDir: string
    try {
      runDir = resolveRunDir(workspacePath, entry.name)
    } catch {
      continue
    }
    const status = loadStatus(runDir)
    if (!status?.inlineInstance || status.parentRunId !== parentRunId) continue
    if (status.worktreePath) continue
    found.push({ runId: entry.name, runDir })
  }
  return found
}

/**
 * Build the checkpoint scopes for a rewind of `runId` to `fromUserMessageIndex`:
 * the parent run's anchored checkpoints plus the full checkpoint history of
 * every shared-workspace instance spawned at or after that point. Instances
 * whose spawn turn cannot be located in the transcript follow the
 * legacy-checkpoint rule and are only undone by a rewind to the very start.
 */
export async function collectRewindRunScopes(input: {
  workspacePath: string
  runId: string
  /** Full parent transcript (messages.jsonl) used to locate each spawn turn. */
  messages: ChatMessage[]
  fromUserMessageIndex: number
  /** Cancel and wait out included instances that are still running. */
  quiesce: boolean
}): Promise<RewindRunScope[]> {
  const scopes: RewindRunScope[] = [
    { runDir: resolveRunDir(input.workspacePath, input.runId), selection: 'anchored' }
  ]
  const instances = await listSharedWorkspaceInstances(input.workspacePath, input.runId)
  for (const instance of instances) {
    const anchor = deriveInstanceSpawnAnchorIndex(input.messages, instance.runId)
    if (anchor === undefined && input.fromUserMessageIndex !== 0) continue
    if (anchor !== undefined && anchor < input.fromUserMessageIndex) continue
    if (input.quiesce && isActive(instance.runId)) {
      // An included instance still unwinding (or running in the background)
      // must stop before the restore — its late checkpoint finalizes would
      // otherwise race the index read in rewindWritesFromScopes.
      cancelRun(instance.runId)
      await waitUntilRunInactive(instance.runId)
    }
    scopes.push({ runDir: instance.runDir, selection: 'all' })
  }
  return scopes
}

/**
 * Resolve the disk index of a user message. Under capped hydration the renderer
 * cannot know global transcript indexes; it sends the target user message's ISO
 * `at`, resolved here against the full transcript the rewind loads anyway.
 */
function resolveUserMessageIndex(
  messages: ChatMessage[],
  requestedIndex: number,
  targetUserAt?: string
): number {
  if (!targetUserAt) return requestedIndex
  return messages.findIndex((m) => m.role === 'user' && m.at === targetUserAt)
}

/**
 * Precise failure for an edit anchor the persisted transcript no longer
 * contains — after auto-compaction the compacted-away turns cannot be edited.
 * The generic 'out of range' read like a renderer bug; this tells the user why
 * and what to do.
 */
function rewindAnchorMissingMessage(hadTimestampAnchor: boolean): string {
  return hadTimestampAnchor
    ? 'Edited message no longer exists in the saved transcript — it was compacted away. Reload the chat and edit a newer message.'
    : 'editMessageIndex out of range'
}

/** Read-only preview of which files chatRewind to userMessageIndex would restore. */
export async function planRewindToUserMessage(input: {
  workspacePath: string
  runId: string
  userMessageIndex: number
  targetUserAt?: string
}): Promise<RewindWritesPlan> {
  const messages = await loadMessagesAsync(input.workspacePath, input.runId)
  const userMessageIndex = resolveUserMessageIndex(messages, input.userMessageIndex, input.targetUserAt)
  if (userMessageIndex < 0) {
    throw new Error(rewindAnchorMissingMessage(input.targetUserAt != null))
  }
  if (userMessageIndex >= messages.length) {
    throw new Error('editMessageIndex out of range')
  }
  const scopes = await collectRewindRunScopes({
    workspacePath: input.workspacePath,
    runId: input.runId,
    messages,
    fromUserMessageIndex: userMessageIndex,
    quiesce: false
  })
  return planRewindWritesAcrossRuns(scopes, userMessageIndex)
}

/**
 * Restore workspace files and rewrite run persistence so the next invoke answers
 * the edited user message with history truncated after it.
 */
export async function prepareRewindAndReplaceUserMessage(input: {
  workspacePath: string
  runId: string
  editMessageIndex: number
  targetUserAt?: string
  editedUserMessage: ChatMessage
}): Promise<PrepareRewindResult> {
  const { workspacePath, runId, editedUserMessage } = input
  const runDir = resolveRunDir(workspacePath, runId)
  if (!existsSync(runDir)) {
    throw new Error('Run not found')
  }

  clearFollowUps(runId)
  // The queue is persisted at enqueue time; without the disk clear the
  // pre-rewind follow-ups resurrect on the next chatStart(resume) and execute
  // against the rewound transcript.
  clearFollowUpsOnDisk(runDir)

  const diskMessages = await loadMessagesAsync(workspacePath, runId)
  const editMessageIndex = resolveUserMessageIndex(diskMessages, input.editMessageIndex, input.targetUserAt)
  if (editMessageIndex < 0) {
    throw new Error(rewindAnchorMissingMessage(input.targetUserAt != null))
  }
  if (editMessageIndex >= diskMessages.length) {
    throw new Error('editMessageIndex out of range')
  }
  if (diskMessages[editMessageIndex]?.role !== 'user') {
    throw new Error('editMessageIndex must point at a user message')
  }

  const scopes = await collectRewindRunScopes({
    workspacePath,
    runId,
    messages: diskMessages,
    fromUserMessageIndex: editMessageIndex,
    quiesce: true
  })
  const writes = rewindWritesFromScopes(workspacePath, scopes, editMessageIndex)
  if (writes.undoableRestoreFailed) {
    throw new Error('Could not restore checkpoint files; history was not truncated')
  }
  const prior = diskMessages.slice(0, editMessageIndex)
  const nextMessages: ChatMessage[] = [...prior, { ...editedUserMessage, role: 'user' }]

  await applyRewindPersistence({
    workspacePath,
    runId,
    runDir,
    userMessageIndex: editMessageIndex,
    // The prompt as it was on disk — the edited copy carries a fresh `at`.
    rewoundUserAt: diskMessages[editMessageIndex]?.at,
    nextMessages,
    writes
  })

  return { messages: nextMessages, writes }
}

async function applyRewindPersistence(input: {
  workspacePath: string
  runId: string
  runDir: string
  userMessageIndex: number
  /** Send time of the rewound prompt; its turn's events are cut from there. */
  rewoundUserAt?: string
  nextMessages: ChatMessage[]
  writes: RewindWritesResult
}): Promise<void> {
  const { workspacePath, runId, runDir, userMessageIndex, rewoundUserAt, nextMessages, writes } =
    input
  await syncMessagesAsync(runDir, nextMessages)
  syncTodosAfterRewind(runDir, nextMessages)

  const persistedEvents = await loadEventsAsync(runDir, runId)
  const prior = nextMessages.slice(0, userMessageIndex)
  const keptIds = keptToolCallIds(prior)
  const rewoundIds = new Set(writes.checkpointIds)
  const truncatedEvents = truncateEvents(persistedEvents, keptIds, rewoundIds, rewoundUserAt)
  await syncEventsAsync(runDir, truncatedEvents)

  const compaction = loadCompaction(runDir)
  const folded = compaction?.foldedMessages ?? 0
  if (compaction && folded > nextMessages.length) {
    const path = join(runDir, 'compaction.json')
    if (existsSync(path)) {
      rmSync(path, { force: true })
    }
    logger.info('Cleared compaction watermark after rewind', {
      scope: 'agent',
      correlationId: runId,
      foldedMessages: folded,
      messageCount: nextMessages.length
    })
  } else if (compaction && folded > prior.length) {
    saveCompaction(runDir, { ...compaction, foldedMessages: prior.length })
  }

  await updateStatus(
    runDir,
    {
      status: 'done',
      error: undefined
    },
    { sync: true }
  )

  await flushEventAppends(runDir)
  await flushStatusWrites(runDir)
  const events = await loadEventsAsync(runDir, runId)
  const receipt = await writeRunReceiptBestEffort({
    runDir,
    runId,
    loadStatus,
    loadMessages: () => nextMessages,
    loadEvents: () => events,
    readContract
  })
  writeTrajectoryArtifactsBestEffort({
    runDir,
    runId,
    loadEvents: () => events,
    receipt
  })
}

/**
 * Restore workspace files and truncate run persistence to the chosen user message
 * without replacing its text or starting a new invoke.
 */
export async function prepareRewindToUserMessage(input: {
  workspacePath: string
  runId: string
  userMessageIndex: number
  targetUserAt?: string
}): Promise<PrepareRewindResult> {
  const { workspacePath, runId } = input
  const runDir = resolveRunDir(workspacePath, runId)
  if (!existsSync(runDir)) {
    throw new Error('Run not found')
  }

  clearFollowUps(runId)
  // Same disk clear as the edit-and-resend rewind — see the comment there.
  clearFollowUpsOnDisk(runDir)

  const diskMessages = await loadMessagesAsync(workspacePath, runId)
  const userMessageIndex = resolveUserMessageIndex(diskMessages, input.userMessageIndex, input.targetUserAt)
  if (userMessageIndex < 0 || userMessageIndex >= diskMessages.length) {
    throw new Error('userMessageIndex out of range')
  }
  if (diskMessages[userMessageIndex]?.role !== 'user') {
    throw new Error('userMessageIndex must point at a user message')
  }

  const scopes = await collectRewindRunScopes({
    workspacePath,
    runId,
    messages: diskMessages,
    fromUserMessageIndex: userMessageIndex,
    quiesce: true
  })
  const writes = rewindWritesFromScopes(workspacePath, scopes, userMessageIndex)
  if (writes.undoableRestoreFailed) {
    throw new Error('Could not restore checkpoint files; history was not truncated')
  }
  const nextMessages = diskMessages.slice(0, userMessageIndex + 1)

  await applyRewindPersistence({
    workspacePath,
    runId,
    runDir,
    userMessageIndex,
    rewoundUserAt: diskMessages[userMessageIndex]?.at,
    nextMessages,
    writes
  })

  return { messages: nextMessages, writes }
}
