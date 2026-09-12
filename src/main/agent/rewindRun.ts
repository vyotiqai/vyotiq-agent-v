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
 * Truncate events to those that still belong to kept message history.
 * Cuts at the first event that references a dropped tool call or a rewound
 * write checkpoint.
 */
function truncateEvents(
  persisted: PersistedEvent[],
  keptIds: Set<string>,
  rewoundCheckpointIds: Set<string>
): AgentEvent[] {
  const kept: AgentEvent[] = []
  for (const row of persisted) {
    const ev = row.event
    if (!ev || typeof ev !== 'object' || !('type' in ev)) continue
    const agentEvent = ev as AgentEvent
    if (agentEvent.type === 'writes_checkpoint') {
      if (rewoundCheckpointIds.has(agentEvent.checkpointId)) break
      kept.push(agentEvent)
      continue
    }
    const toolId = eventToolCallId(agentEvent)
    if (toolId && !keptIds.has(toolId)) break
    kept.push(agentEvent)
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

/** Read-only preview of which files chatRewind to userMessageIndex would restore. */
export async function planRewindToUserMessage(input: {
  workspacePath: string
  runId: string
  userMessageIndex: number
}): Promise<RewindWritesPlan> {
  const messages = await loadMessagesAsync(input.workspacePath, input.runId)
  const scopes = await collectRewindRunScopes({
    workspacePath: input.workspacePath,
    runId: input.runId,
    messages,
    fromUserMessageIndex: input.userMessageIndex,
    quiesce: false
  })
  return planRewindWritesAcrossRuns(scopes, input.userMessageIndex)
}

/**
 * Restore workspace files and rewrite run persistence so the next invoke answers
 * the edited user message with history truncated after it.
 */
export async function prepareRewindAndReplaceUserMessage(input: {
  workspacePath: string
  runId: string
  editMessageIndex: number
  editedUserMessage: ChatMessage
}): Promise<PrepareRewindResult> {
  const { workspacePath, runId, editMessageIndex, editedUserMessage } = input
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
  if (editMessageIndex < 0 || editMessageIndex >= diskMessages.length) {
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
  nextMessages: ChatMessage[]
  writes: RewindWritesResult
}): Promise<void> {
  const { workspacePath, runId, runDir, userMessageIndex, nextMessages, writes } = input
  await syncMessagesAsync(runDir, nextMessages)
  syncTodosAfterRewind(runDir, nextMessages)

  const persistedEvents = await loadEventsAsync(runDir, runId)
  const prior = nextMessages.slice(0, userMessageIndex)
  const keptIds = keptToolCallIds(prior)
  const rewoundIds = new Set(writes.checkpointIds)
  const truncatedEvents = truncateEvents(persistedEvents, keptIds, rewoundIds)
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
  const receipt = writeRunReceiptBestEffort({
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
}): Promise<PrepareRewindResult> {
  const { workspacePath, runId, userMessageIndex } = input
  const runDir = resolveRunDir(workspacePath, runId)
  if (!existsSync(runDir)) {
    throw new Error('Run not found')
  }

  clearFollowUps(runId)
  // Same disk clear as the edit-and-resend rewind — see the comment there.
  clearFollowUpsOnDisk(runDir)

  const diskMessages = await loadMessagesAsync(workspacePath, runId)
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
    nextMessages,
    writes
  })

  return { messages: nextMessages, writes }
}
