import type { AgentEvent } from '../../shared/ipc'
import { logger } from '../../shared/logger'
import { workspacePathsEqual } from '../../shared/workspacePathMatch'

const ACTIVE_BATCH_MS = 16
const BACKGROUND_BATCH_MS = 80

/**
 * Backstop caps for a wedged renderer whose slot stays attached: delta
 * segments are reconstructable from events.jsonl catch-up, so once the queue
 * exceeds either cap the oldest delta segments are dropped instead of
 * ballooning the main heap (OOM amplifier, 2026-09-11 crash).
 */
const PENDING_SEGMENTS_MAX = 512
const PENDING_SEGMENTS_MAX_BYTES = 8 * 1024 * 1024

type PendingSegment =
  | { kind: 'text'; text: string; invokeId?: number }
  | { kind: 'thinking'; text: string; step?: number; invokeId?: number }
  | {
      kind: 'tool_call_delta'
      toolCallId: string
      name?: string
      argumentsDelta: string
      invokeId?: number
    }
  | {
      kind: 'terminal_output_delta'
      toolCallId: string
      text: string
      stream?: 'stdout' | 'stderr'
      invokeId?: number
    }

/**
 * One entry of a run's ordered emission queue: either a coalescable delta
 * segment or a verbatim non-delta event (active-workspace usage).
 *
 * Sharing one queue is what lets usage events ride the batch timer without
 * reordering: previously each active-workspace `step_usage`/`context_usage`
 * called `flushRun()` first, which emitted every still-pending delta early and
 * reset the 16 ms coalescing window three times per agent step.
 */
type PendingEmission =
  | PendingSegment
  | { kind: 'event'; event: AgentEvent }

/** Composite pending-usage key: step + kind (0 = step_usage, 1 = context_usage). */
function usageKey(type: string, step: number): string {
  return `${step}:${type === 'context_usage' ? 1 : 0}`
}

function parseUsageKey(key: string): { step: number; kind: number } {
  const sep = key.lastIndexOf(':')
  const step = Number(key.slice(0, sep))
  const kind = Number(key.slice(sep + 1))
  return { step: Number.isFinite(step) ? step : 0, kind: Number.isFinite(kind) ? kind : 0 }
}

/** Rough retained size of a pending emission for the queue byte cap. */
function pendingSegmentBytes(segment: PendingEmission): number {
  if (segment.kind === 'event') return 0
  if (segment.kind === 'tool_call_delta') return segment.argumentsDelta.length
  return segment.text.length
}

type RunSlot = {
  workspacePath: string
  send: (ev: AgentEvent) => void
  pendingSegments: PendingEmission[]
  /** Rough byte size of pendingSegments (text/argumentsDelta lengths). */
  pendingBytes: number
  /**
   * Background coalesce: latest usage event per (type, step) so inactive
   * workspaces do not lose earlier step meters when several arrive before
   * activate. Keyed by type AND step — a step_usage and a context_usage for
   * the same step are different signals; keying by step alone dropped one of
   * them (the token meter under-reported that step).
   */
  pendingUsageByStep: Map<string, AgentEvent>
  /** Number of ChatEventBatcher owners; detach only when this hits 0. */
  attachCount: number
  /** Earliest time this run's pending segments may flush; 0 = none scheduled. */
  dueMs: number
}

/** Dev/test counters for IPC send rate (Electron: measure before optimizing). */
export type ChatEventBatchStats = {
  pushed: number
  sent: number
  /** Pushes with no attached slot (not delivered). */
  dropped: number
  byType: Record<string, number>
  /** Timer flushes that prioritized an active-workspace run. */
  activeFlushes: number
  /** Timer flushes that only drained background runs (no active pending). */
  backgroundFlushes: number
  /** Background usage events that replaced a still-pending usage. */
  usageCoalesced: number
  /** Peak pending segment+usage depth since last reset. */
  maxPendingDepth: number
  attachedRuns: number
  /** Deltas dropped because the renderer is not subscribed to that run. */
  uiGated: number
  /** Oldest delta segments dropped by the pending-queue cap (wedged renderer backstop). */
  overflowDropped: number
}

let stats: ChatEventBatchStats = {
  pushed: 0,
  sent: 0,
  dropped: 0,
  byType: {},
  activeFlushes: 0,
  backgroundFlushes: 0,
  usageCoalesced: 0,
  maxPendingDepth: 0,
  attachedRuns: 0,
  uiGated: 0,
  overflowDropped: 0
}

export function getChatEventBatchStats(): ChatEventBatchStats {
  return {
    pushed: stats.pushed,
    sent: stats.sent,
    dropped: stats.dropped,
    byType: { ...stats.byType },
    activeFlushes: stats.activeFlushes,
    backgroundFlushes: stats.backgroundFlushes,
    usageCoalesced: stats.usageCoalesced,
    maxPendingDepth: stats.maxPendingDepth,
    attachedRuns: stats.attachedRuns,
    uiGated: stats.uiGated,
    overflowDropped: stats.overflowDropped
  }
}

export function resetChatEventBatchStats(): void {
  stats = {
    pushed: 0,
    sent: 0,
    dropped: 0,
    byType: {},
    activeFlushes: 0,
    backgroundFlushes: 0,
    usageCoalesced: 0,
    maxPendingDepth: 0,
    attachedRuns: 0,
    uiGated: 0,
    overflowDropped: 0
  }
}

function recordPush(type: string): void {
  stats.pushed += 1
  stats.byType[type] = (stats.byType[type] ?? 0) + 1
}

function recordSend(type: string): void {
  stats.sent += 1
  const key = `sent:${type}`
  stats.byType[key] = (stats.byType[key] ?? 0) + 1
}

type ActivePathResolver = () => string | null

let resolveActivePath: ActivePathResolver = defaultActivePathResolver

function defaultActivePathResolver(): string | null {
  try {
    // Lazy require avoids circular import at module load (workspaces ↔ ipc).
    const { getWorkspaces } = require('../workspace/workspaces') as {
      getWorkspaces: () => { activePath: string | null }
    }
    return getWorkspaces().activePath
  } catch {
    return null
  }
}

/** @internal Override active-path lookup in unit tests. */
export function setChatEventActivePathResolver(resolver: ActivePathResolver | null): void {
  resolveActivePath = resolver ?? defaultActivePathResolver
}

function isActiveWorkspace(workspacePath: string): boolean {
  // Empty path = isolated/local batcher (unit tests) — treat as active (16ms).
  if (!workspacePath) return true
  const active = resolveActivePath()
  if (!active) return true
  return workspacePathsEqual(active, workspacePath)
}

function batchDelayMs(workspacePath: string): number {
  if (!isActiveWorkspace(workspacePath)) return BACKGROUND_BATCH_MS
  return ACTIVE_BATCH_MS
}

/** High-frequency / reconstructable events — skipped when the renderer is not watching. */
const UI_GATED_STREAM_TYPES = new Set<AgentEvent['type']>([
  'text_delta',
  'thinking_delta',
  'thinking_done',
  'tool_call_delta',
  'tool_start',
  'tool_result',
  'tool_progress',
  'terminal_output_delta',
  'assistant_message',
  'step_usage',
  'context_usage',
  'token_cost_hint'
])

let uiSubscribeExplicit = false
const uiSubscribedRuns = new Set<string>()
const uiExcludedRuns = new Set<string>()

function resetChatEventUiSubscriptions(): void {
  uiSubscribeExplicit = false
  uiSubscribedRuns.clear()
  uiExcludedRuns.clear()
}

/** Replace the set of run ids that should receive token streams. */
export function setChatEventUiSubscriptions(runIds: readonly string[]): void {
  uiSubscribeExplicit = true
  uiSubscribedRuns.clear()
  for (const id of runIds) {
    const trimmed = id.trim()
    if (!trimmed) continue
    uiSubscribedRuns.add(trimmed)
    uiExcludedRuns.delete(trimmed)
  }
}

/** Child instance starts hidden — do not stream tokens until the pane opens. */
export function excludeChatEventUiSubscription(runId: string): void {
  const trimmed = runId.trim()
  if (!trimmed) return
  uiExcludedRuns.add(trimmed)
  uiSubscribedRuns.delete(trimmed)
}

/** Add one run to the subscribed set (called as soon as a run id is assigned on the
 * renderer, so its live deltas are never dropped before the bulk subscription sync). */
export function addChatEventUiSubscription(runId: string): void {
  const trimmed = runId.trim()
  if (!trimmed) return
  uiSubscribeExplicit = true
  uiExcludedRuns.delete(trimmed)
  uiSubscribedRuns.add(trimmed)
}

export function isChatEventUiSubscribed(runId: string): boolean {
  if (uiExcludedRuns.has(runId)) return false
  if (!uiSubscribeExplicit) return true
  return uiSubscribedRuns.has(runId)
}

function totalPendingDepth(slots: Map<string, RunSlot>): number {
  let n = 0
  for (const slot of slots.values()) {
    n += slot.pendingSegments.length
    n += slot.pendingUsageByStep.size
  }
  return n
}

/**
 * Single shared chat-event dispatcher: one timer, active-workspace runs flush first,
 * background runs coalesce longer and may drop intermediate usage under pressure.
 */
export class ChatEventDispatcher {
  private readonly slots = new Map<string, RunSlot>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private nextDueMs = 0

  attach(
    runId: string,
    workspacePath: string,
    send: (ev: AgentEvent) => void,
    options?: { retain?: boolean }
  ): void {
    const retain = options?.retain !== false
    const existing = this.slots.get(runId)
    if (existing) {
      existing.workspacePath = workspacePath
      existing.send = send
      if (retain) existing.attachCount += 1
      return
    }
    this.slots.set(runId, {
      workspacePath,
      send,
      pendingSegments: [],
      pendingBytes: 0,
      pendingUsageByStep: new Map(),
      attachCount: 1,
      dueMs: 0
    })
    stats.attachedRuns = this.slots.size
  }

  detach(runId: string): void {
    const slot = this.slots.get(runId)
    if (!slot) return
    slot.attachCount = Math.max(0, slot.attachCount - 1)
    if (slot.attachCount > 0) {
      this.flushRun(runId)
      return
    }
    this.flushRun(runId)
    this.slots.delete(runId)
    stats.attachedRuns = this.slots.size
    if (this.slots.size === 0 && this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.nextDueMs = 0
    }
  }

  push(runId: string, ev: AgentEvent): void {
    const slot = this.slots.get(runId)
    if (!slot) {
      recordPush(ev.type)
      stats.dropped += 1
      logger.warn(`Chat event dropped: no attached slot (${ev.type})`, {
        scope: 'ipc',
        runId,
        kind: ev.type
      })
      return
    }
    recordPush(ev.type)

    if (UI_GATED_STREAM_TYPES.has(ev.type) && !isChatEventUiSubscribed(runId)) {
      stats.uiGated += 1
      return
    }

    if (ev.type === 'text_delta') {
      this.appendSegment(slot, { kind: 'text', text: ev.text, invokeId: ev.invokeId })
      this.schedule(slot)
      return
    }

    if (ev.type === 'thinking_delta') {
      this.appendSegment(slot, {
        kind: 'thinking',
        text: ev.text,
        step: ev.step,
        invokeId: ev.invokeId
      })
      this.schedule(slot)
      return
    }

    if (ev.type === 'tool_call_delta') {
      this.appendSegment(slot, {
        kind: 'tool_call_delta',
        toolCallId: ev.toolCallId,
        name: ev.name,
        argumentsDelta: ev.argumentsDelta,
        invokeId: ev.invokeId
      })
      this.schedule(slot)
      return
    }

    if (ev.type === 'terminal_output_delta') {
      this.appendSegment(slot, {
        kind: 'terminal_output_delta',
        toolCallId: ev.toolCallId,
        text: ev.text,
        stream: ev.stream,
        invokeId: ev.invokeId
      })
      this.schedule(slot)
      return
    }

    if (ev.type === 'step_usage' || ev.type === 'context_usage') {
      if (isActiveWorkspace(slot.workspacePath)) {
        // Ride the batch timer in emission order instead of forcing a flush.
        // Forcing one here emitted every pending delta early and restarted the
        // coalescing window up to three times per step for the meters alone.
        slot.pendingSegments.push({ kind: 'event', event: ev })
        this.schedule(slot)
        return
      }
      // Keep latest usage per (type, step) so background workspaces retain meters.
      const key = usageKey(ev.type, ev.step)
      const prev = slot.pendingUsageByStep.get(key)
      if (prev) stats.usageCoalesced += 1
      slot.pendingUsageByStep.set(key, ev)
      this.notePendingDepth()
      this.schedule(slot)
      return
    }

    this.flushRun(runId)
    this.emit(slot, ev)
  }

  /** Flush one run (approvals / end of turn), or all runs when omitted. */
  flush(runId?: string): void {
    if (runId) {
      this.flushRun(runId)
      return
    }
    this.flushAllDeltas()
  }

  /** Current queue depth across attached runs. */
  pendingDepth(): number {
    return totalPendingDepth(this.slots)
  }

  attachedCount(): number {
    return this.slots.size
  }

  private flushPendingUsageEvents(slot: RunSlot): void {
    if (slot.pendingUsageByStep.size === 0) return
    // Rebuild emission order: step asc; step_usage before context_usage within
    // a step (matches the loop's emission order).
    const ordered = [...slot.pendingUsageByStep.entries()].sort((a, b) => {
      const ka = parseUsageKey(a[0])
      const kb = parseUsageKey(b[0])
      if (ka.step !== kb.step) return ka.step - kb.step
      return ka.kind - kb.kind
    })
    for (const [, usageEv] of ordered) {
      this.emit(slot, usageEv)
    }
    slot.pendingUsageByStep.clear()
  }

  private flushRun(runId: string): void {
    const slot = this.slots.get(runId)
    if (!slot) return
    this.emitSegments(slot, runId, slot.pendingSegments)
    slot.pendingSegments = []
    slot.pendingBytes = 0
    this.flushPendingUsageEvents(slot)
    slot.dueMs = 0
  }

  private flushAllDeltas(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
      this.nextDueMs = 0
    }

    const ordered = [...this.slots.entries()].sort(([, a], [, b]) => {
      const aActive = isActiveWorkspace(a.workspacePath) ? 0 : 1
      const bActive = isActiveWorkspace(b.workspacePath) ? 0 : 1
      return aActive - bActive
    })

    let flushedActive = false
    let flushedBackground = false
    for (const [runId, slot] of ordered) {
      const had =
        slot.pendingSegments.length > 0 || slot.pendingUsageByStep.size > 0
      if (!had) {
        slot.dueMs = 0
        continue
      }
      if (isActiveWorkspace(slot.workspacePath)) flushedActive = true
      else flushedBackground = true
      if (slot.pendingSegments.length) {
        this.emitSegments(slot, runId, slot.pendingSegments)
        slot.pendingSegments = []
        slot.pendingBytes = 0
      }
      this.flushPendingUsageEvents(slot)
      slot.dueMs = 0
    }
    if (flushedActive) stats.activeFlushes += 1
    else if (flushedBackground) stats.backgroundFlushes += 1
  }

  private notePendingDepth(): void {
    const depth = totalPendingDepth(this.slots)
    if (depth > stats.maxPendingDepth) stats.maxPendingDepth = depth
  }

  private schedule(slot: RunSlot): void {
    this.notePendingDepth()
    if (slot.dueMs === 0) {
      slot.dueMs = Date.now() + batchDelayMs(slot.workspacePath)
    }
    this.ensureTimer(slot.dueMs)
  }

  private ensureTimer(dueMs: number): void {
    if (this.timer && this.nextDueMs > 0 && this.nextDueMs <= dueMs) return
    if (this.timer) clearTimeout(this.timer)
    this.nextDueMs = dueMs
    const delay = Math.max(0, dueMs - Date.now())
    this.timer = setTimeout(() => {
      this.timer = null
      this.nextDueMs = 0
      this.flushDueDeltas()
    }, delay)
  }

  /** Flush runs whose cadence has elapsed; leave later siblings queued. */
  private flushDueDeltas(): void {
    const now = Date.now()
    const ordered = [...this.slots.entries()].sort(([, a], [, b]) => {
      const aActive = isActiveWorkspace(a.workspacePath) ? 0 : 1
      const bActive = isActiveWorkspace(b.workspacePath) ? 0 : 1
      return aActive - bActive
    })

    let flushedActive = false
    let flushedBackground = false
    let nextDue = 0
    for (const [runId, slot] of ordered) {
      const had =
        slot.pendingSegments.length > 0 || slot.pendingUsageByStep.size > 0
      if (!had) {
        slot.dueMs = 0
        continue
      }
      if (slot.dueMs === 0 || slot.dueMs > now) {
        const due = slot.dueMs === 0 ? now + batchDelayMs(slot.workspacePath) : slot.dueMs
        slot.dueMs = due
        if (nextDue === 0 || due < nextDue) nextDue = due
        continue
      }
      if (isActiveWorkspace(slot.workspacePath)) flushedActive = true
      else flushedBackground = true
      if (slot.pendingSegments.length) {
        this.emitSegments(slot, runId, slot.pendingSegments)
        slot.pendingSegments = []
        slot.pendingBytes = 0
      }
      this.flushPendingUsageEvents(slot)
      slot.dueMs = 0
    }
    if (flushedActive) stats.activeFlushes += 1
    else if (flushedBackground) stats.backgroundFlushes += 1
    if (nextDue > 0) this.ensureTimer(nextDue)
  }

  private emit(slot: RunSlot, ev: AgentEvent): void {
    recordSend(ev.type)
    slot.send(ev)
  }

  private appendSegment(slot: RunSlot, segment: PendingSegment): void {
    const queue = slot.pendingSegments
    const last = queue[queue.length - 1]
    if (
      last &&
      last.kind === segment.kind &&
      last.invokeId === segment.invokeId &&
      (segment.kind !== 'thinking' || (last.kind === 'thinking' && last.step === segment.step)) &&
      (segment.kind !== 'tool_call_delta' ||
        (last.kind === 'tool_call_delta' && last.toolCallId === segment.toolCallId)) &&
      (segment.kind !== 'terminal_output_delta' ||
        (last.kind === 'terminal_output_delta' &&
          last.toolCallId === segment.toolCallId &&
          last.stream === segment.stream))
    ) {
      if (segment.kind === 'thinking' && last.kind === 'thinking') {
        queue[queue.length - 1] = {
          kind: 'thinking',
          text: last.text + segment.text,
          step: segment.step,
          invokeId: segment.invokeId
        }
        slot.pendingBytes += segment.text.length
      } else if (segment.kind === 'text' && last.kind === 'text') {
        queue[queue.length - 1] = {
          kind: 'text',
          text: last.text + segment.text,
          invokeId: segment.invokeId
        }
        slot.pendingBytes += segment.text.length
      } else if (segment.kind === 'tool_call_delta' && last.kind === 'tool_call_delta') {
        queue[queue.length - 1] = {
          kind: 'tool_call_delta',
          toolCallId: last.toolCallId,
          name: segment.name ?? last.name,
          argumentsDelta: last.argumentsDelta + segment.argumentsDelta,
          invokeId: segment.invokeId
        }
        slot.pendingBytes += segment.argumentsDelta.length
      } else if (segment.kind === 'terminal_output_delta' && last.kind === 'terminal_output_delta') {
        queue[queue.length - 1] = {
          kind: 'terminal_output_delta',
          toolCallId: last.toolCallId,
          text: last.text + segment.text,
          stream: segment.stream,
          invokeId: segment.invokeId
        }
        slot.pendingBytes += segment.text.length
      }
    } else {
      queue.push(segment)
      slot.pendingBytes += pendingSegmentBytes(segment)
    }
    this.enforcePendingCap(slot)
  }

  /**
   * Drop the oldest delta segments once the pending queue exceeds either cap.
   * Only reconstructable deltas are dropped — `{kind:'event'}` entries
   * (usage etc.) are never dropped, and the renderer rebuilds any gaps via its
   * loadRun + resumeUiIfNeeded catch-up after reconnect.
   */
  private enforcePendingCap(slot: RunSlot): void {
    if (
      slot.pendingSegments.length <= PENDING_SEGMENTS_MAX &&
      slot.pendingBytes <= PENDING_SEGMENTS_MAX_BYTES
    ) {
      return
    }
    let dropped = 0
    while (
      slot.pendingSegments.length > PENDING_SEGMENTS_MAX ||
      slot.pendingBytes > PENDING_SEGMENTS_MAX_BYTES
    ) {
      const idx = slot.pendingSegments.findIndex((segment) => segment.kind !== 'event')
      if (idx < 0) break
      const removed = slot.pendingSegments[idx]!
      slot.pendingSegments.splice(idx, 1)
      slot.pendingBytes -= pendingSegmentBytes(removed)
      dropped += 1
    }
    if (dropped > 0) stats.overflowDropped += dropped
  }

  private emitSegments(slot: RunSlot, runId: string, segments: PendingEmission[]): void {
    for (const segment of segments) {
      if (segment.kind === 'event') {
        this.emit(slot, segment.event)
        continue
      }
      if (segment.kind === 'text') {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'text_delta',
          runId,
          text: segment.text,
          invokeId: segment.invokeId
        })
      } else if (segment.kind === 'thinking') {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'thinking_delta',
          runId,
          text: segment.text,
          step: segment.step,
          invokeId: segment.invokeId
        })
      } else if (segment.kind === 'tool_call_delta') {
        this.emit(slot, {
          type: 'tool_call_delta',
          runId,
          toolCallId: segment.toolCallId,
          name: segment.name,
          argumentsDelta: segment.argumentsDelta,
          invokeId: segment.invokeId
        })
      } else {
        if (!segment.text) continue
        this.emit(slot, {
          type: 'terminal_output_delta',
          runId,
          toolCallId: segment.toolCallId,
          text: segment.text,
          stream: segment.stream,
          invokeId: segment.invokeId
        })
      }
    }
  }
}

let sharedDispatcher: ChatEventDispatcher | null = null

export function getChatEventDispatcher(): ChatEventDispatcher {
  if (!sharedDispatcher) sharedDispatcher = new ChatEventDispatcher()
  return sharedDispatcher
}

/** Live dispatcher queue depth for load snapshots. */
export function getChatEventDispatcherSnapshot(): {
  pendingDepth: number
  attachedRuns: number
} {
  if (!sharedDispatcher) return { pendingDepth: 0, attachedRuns: 0 }
  return {
    pendingDepth: sharedDispatcher.pendingDepth(),
    attachedRuns: sharedDispatcher.attachedCount()
  }
}

/** @internal Reset singleton between tests. */
export function resetChatEventDispatcher(): void {
  if (sharedDispatcher) {
    sharedDispatcher.flush()
  }
  sharedDispatcher = null
  resetChatEventBatchStats()
  resetChatEventUiSubscriptions()
}

export type ChatEventBatcherOptions = {
  runId: string
  workspacePath: string
  /** Default true when options provided. */
  shared?: boolean
}

/**
 * Per-run facade. Production chatStart uses the shared prioritized dispatcher.
 * Unit tests construct without options for an isolated local dispatcher.
 */
export class ChatEventBatcher {
  private readonly send: (ev: AgentEvent) => void
  private readonly fixedRunId: string | null
  private readonly workspacePath: string
  private readonly dispatcher: ChatEventDispatcher
  private readonly shared: boolean

  constructor(send: (ev: AgentEvent) => void, options?: ChatEventBatcherOptions) {
    this.send = send
    if (options?.runId && options.shared !== false) {
      this.fixedRunId = options.runId
      this.workspacePath = options.workspacePath
      this.shared = true
      this.dispatcher = getChatEventDispatcher()
      this.dispatcher.attach(options.runId, options.workspacePath, send)
    } else {
      this.fixedRunId = null
      this.workspacePath = ''
      this.shared = false
      this.dispatcher = new ChatEventDispatcher()
    }
  }

  push(ev: AgentEvent): void {
    const id = this.fixedRunId ?? ev.runId
    // Refresh send target without taking another retain (constructor/dispose own the count).
    this.dispatcher.attach(id, this.workspacePath, this.send, { retain: false })
    this.dispatcher.push(id, { ...ev, runId: id })
  }

  flush(): void {
    if (this.fixedRunId) {
      this.dispatcher.flush(this.fixedRunId)
      return
    }
    this.dispatcher.flush()
  }

  dispose(): void {
    if (this.shared && this.fixedRunId) {
      this.dispatcher.detach(this.fixedRunId)
    } else {
      this.dispatcher.flush()
    }
  }
}
