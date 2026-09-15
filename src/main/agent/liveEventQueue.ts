import type { AgentEvent } from '../../shared/ipc'

/**
 * Backstop caps for the in-loop live-event queue. While a tool step's await is
 * blocked, `emitLiveEvent` appends progress to a main-thread array with no
 * bound. Delta events are reconstructable via events.jsonl catch-up, so once a
 * cap is exceeded the OLDEST delta events are dropped instead of letting the
 * queue balloon the main heap — the same fail-open policy
 * src/main/ipc/streamBatch.ts applies to the renderer-bound batch queue.
 */
export const LIVE_EVENTS_MAX = 1024
export const LIVE_EVENTS_MAX_BYTES = 4 * 1024 * 1024

/** Delta events whose loss the renderer repairs via events.jsonl catch-up. */
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
