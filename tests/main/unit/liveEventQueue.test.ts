import { describe, expect, it } from 'vitest'
import {
  LIVE_EVENTS_MAX,
  LIVE_EVENTS_MAX_BYTES,
  createLiveEventQueue,
  pushLiveEvent
} from '@main/agent/liveEventQueue'
import type { AgentEvent } from '@shared/ipc'

const textDelta = (text: string): AgentEvent => ({ type: 'text_delta', runId: 'run-1', text })

const thinkingDelta = (text: string): AgentEvent => ({ type: 'thinking_delta', runId: 'run-1', text })

const toolCallDelta = (argumentsDelta: string): AgentEvent => ({
  type: 'tool_call_delta',
  runId: 'run-1',
  toolCallId: 'call-1',
  argumentsDelta
})

const terminalOutputDelta = (text: string): AgentEvent => ({
  type: 'terminal_output_delta',
  runId: 'run-1',
  toolCallId: 'call-1',
  text
})

// Non-delta event: even though it carries text, it must never be dropped.
const toolProgress = (text: string): AgentEvent => ({
  type: 'tool_progress',
  runId: 'run-1',
  parentToolCallId: 'parent-1',
  kind: 'text',
  text
})

describe('liveEventQueue', () => {
  it('keeps every event, in order, while under both caps', () => {
    const queue = createLiveEventQueue()
    const events = [
      textDelta('a'),
      toolProgress('p'),
      thinkingDelta('b'),
      toolCallDelta('cd'),
      terminalOutputDelta('e')
    ]
    for (const ev of events) {
      expect(pushLiveEvent(queue, ev)).toBe(0)
    }
    expect(queue.events).toEqual(events)
    expect(queue.bytes).toBe('a'.length + 'p'.length + 'b'.length + 'cd'.length + 'e'.length)
    expect(queue.dropped).toBe(0)
  })

  it('drops the oldest delta events once the segment cap is exceeded', () => {
    const queue = createLiveEventQueue()
    let fillBytes = 0
    for (let i = 0; i < LIVE_EVENTS_MAX; i += 1) {
      const text = `d${i}`
      fillBytes += text.length
      pushLiveEvent(queue, textDelta(text))
    }
    expect(queue.events).toHaveLength(LIVE_EVENTS_MAX)
    expect(queue.bytes).toBe(fillBytes)

    const dropped = pushLiveEvent(queue, textDelta('extra'))
    expect(dropped).toBe(1)
    expect(queue.events).toHaveLength(LIVE_EVENTS_MAX)
    // The oldest delta was dropped, the newest was kept, order is preserved.
    expect(queue.events[0]).toEqual(textDelta('d1'))
    expect(queue.events[queue.events.length - 1]).toEqual(textDelta('extra'))
    // Byte accounting shrinks by the dropped delta's size.
    expect(queue.bytes).toBe(fillBytes + 'extra'.length - 'd0'.length)
    expect(queue.dropped).toBe(1)
  })

  it('retains non-delta events in order while dropping deltas over the cap', () => {
    const queue = createLiveEventQueue()
    const progress1 = toolProgress('p1')
    const progress2 = toolProgress('p2')
    pushLiveEvent(queue, progress1)
    pushLiveEvent(queue, textDelta('d0'))
    pushLiveEvent(queue, progress2)
    // Length reaches 1025 while pushing d1022, then 1025 again for d1023:
    // two pushes each drop one oldest delta (d0, then d1).
    let dropped = 0
    for (let i = 1; i < LIVE_EVENTS_MAX; i += 1) {
      dropped += pushLiveEvent(queue, textDelta(`d${i}`))
    }
    expect(dropped).toBe(2)
    expect(queue.dropped).toBe(2)
    expect(queue.events).toHaveLength(LIVE_EVENTS_MAX)
    // Non-delta events survive, in order, at the head of the queue.
    expect(queue.events.slice(0, 2)).toEqual([progress1, progress2])
    expect(queue.events[2]).toEqual(textDelta('d2'))
    expect(queue.events[queue.events.length - 1]).toEqual(textDelta(`d${LIVE_EVENTS_MAX - 1}`))
  })

  it('enforces the byte cap by dropping oldest delta events', () => {
    const queue = createLiveEventQueue()
    const big1 = 'x'.repeat(LIVE_EVENTS_MAX_BYTES / 2 + 1)
    const big2 = 'y'.repeat(LIVE_EVENTS_MAX_BYTES / 2 + 1)
    expect(pushLiveEvent(queue, textDelta(big1))).toBe(0)
    expect(queue.events).toHaveLength(1)

    const dropped = pushLiveEvent(queue, textDelta(big2))
    expect(dropped).toBe(1)
    expect(queue.events).toEqual([textDelta(big2)])
    expect(queue.bytes).toBe(big2.length)
    expect(queue.dropped).toBe(1)
  })

  it('accounts tool_call_delta bytes via argumentsDelta', () => {
    const queue = createLiveEventQueue()
    pushLiveEvent(queue, toolCallDelta('{"a"'))
    pushLiveEvent(queue, toolCallDelta(':1}'))
    expect(queue.bytes).toBe('{"a"'.length + ':1}'.length)
  })

  it('grows past both caps when nothing is droppable (fail-open)', () => {
    const queue = createLiveEventQueue()
    for (let i = 0; i < LIVE_EVENTS_MAX + 5; i += 1) {
      expect(pushLiveEvent(queue, toolProgress(`p${i}`))).toBe(0)
    }
    expect(queue.events).toHaveLength(LIVE_EVENTS_MAX + 5)
    expect(queue.events[0]).toEqual(toolProgress('p0'))
    expect(queue.events[queue.events.length - 1]).toEqual(toolProgress(`p${LIVE_EVENTS_MAX + 4}`))
    expect(queue.dropped).toBe(0)
  })
})
