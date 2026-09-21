import type { AgentEvent } from '../../shared/ipc'

/**
 * Backstop caps for the in-loop live-event queue. While a tool step's await is
 * blocked, `emitLiveEvent` appends progress to a main-thread array with no
 * bound, so once a cap is exceeded the OLDEST delta events are dropped instead
 * of letting the queue balloon the main heap — the same fail-open policy
 * src/main/ipc/streamBatch.ts applies to the renderer-bound batch queue.
 *
 * Dropping loses live output (see LIVE_DELTA_TYPES), so both caps must measure
 * what is actually RETAINED. Every removal therefore goes through
 * `shiftLiveEvent` or `dropOldestDelta`; draining `events` directly desyncs
 * `bytes` and permanently trips the byte cap.
 */
export const LIVE_EVENTS_MAX = 1024
export const LIVE_EVENTS_MAX_BYTES = 4 * 1024 * 1024

/**
 * Delta types this queue may drop under backpressure.
 *
 * NOT "reconstructable via events.jsonl catch-up", as this previously claimed.
 * Only `terminal_output_delta` ever reaches this queue — the other three are
 * yielded straight out of the stream loop — and it is persisted nowhere:
 * `loop.ts` appends only tool_progress/mode_changed/agent_instance_update/
 * goal_update/loop_update, and `toolResultEventForPersistence` strips
 * tool_result content past 200 chars. A dropped chunk is a real gap in the
 * live terminal row until the tool's result message renders from
 * messages.jsonl, which is the only durable copy.
 *
 * The gap is bounded in practice: the renderer stops accumulating a terminal
 * row at TERMINAL_UI_MAX (64 KB), far below this queue's 4 MB cap.
 */
const LIVE_DELTA_TYPES = new Set<string>([
  'text_delta',
  'thinking_delta',
  'tool_call_delta',
  'terminal_output_delta'
])

export type LiveEventQueue = {
  events: AgentEvent[]
  /** Rough retained size: text / argumentsDelta lengths of queued events. */
  bytes: number
  /** Total delta events dropped by the caps since queue creation. */
  dropped: number
}

/** Rough retained byte size of an event, mirroring streamBatch's estimate. */
function liveEventBytes(ev: AgentEvent): number {
  if ('text' in ev && typeof ev.text === 'string') return ev.text.length
  if ('argumentsDelta' in ev && typeof ev.argumentsDelta === 'string') {
    return ev.argumentsDelta.length
  }
  return 0
}

export function createLiveEventQueue(): LiveEventQueue {
  return { events: [], bytes: 0, dropped: 0 }
}

/**
 * Take the oldest queued event, keeping `bytes` in step with `events`.
 *
 * Draining with a bare `queue.events.shift()` leaves `bytes` counting events
 * that are already gone, so it only ever climbs. Once it passes
 * LIVE_EVENTS_MAX_BYTES the cap is permanently tripped and every later push
 * drops the delta it just appended — an "overflow" on an empty queue, which is
 * how this surfaced: 43,934 `dropped 1 … queued=0` warnings in 58 seconds,
 * with live terminal output going dark for the rest of the step.
 */
export function shiftLiveEvent(queue: LiveEventQueue): AgentEvent | undefined {
  const ev = queue.events.shift()
  if (!ev) return undefined
  queue.bytes = Math.max(0, queue.bytes - liveEventBytes(ev))
  return ev
}

/**
 * Append `ev`, then while either cap is exceeded drop the oldest droppable
 * delta events. Non-delta events are never dropped; with nothing droppable the
 * queue keeps growing (fail-open, same as streamBatch).
 *
 * @returns Number of delta events dropped by this push.
 */
export function pushLiveEvent(queue: LiveEventQueue, ev: AgentEvent): number {
  queue.events.push(ev)
  queue.bytes += liveEventBytes(ev)
  let droppedByPush = 0
  while (
    (queue.events.length > LIVE_EVENTS_MAX || queue.bytes > LIVE_EVENTS_MAX_BYTES) &&
    dropOldestDelta(queue)
  ) {
    droppedByPush += 1
  }
  return droppedByPush
}

function dropOldestDelta(queue: LiveEventQueue): boolean {
  const idx = queue.events.findIndex((queued) => LIVE_DELTA_TYPES.has(queued.type))
  if (idx === -1) return false
  const [dropped] = queue.events.splice(idx, 1)
  queue.bytes -= liveEventBytes(dropped)
  queue.dropped += 1
  return true
}
