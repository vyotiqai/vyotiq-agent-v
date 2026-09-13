import { describe, expect, it } from 'vitest'
import { parseRendererChatEvent } from '@shared/ipc'

describe('parseRendererChatEvent', () => {
  it('fast-paths live deltas without dropping invoke ids', () => {
    expect(
      parseRendererChatEvent({ type: 'text_delta', runId: 'r1', text: 'hi', invokeId: 3 })
    ).toEqual({ type: 'text_delta', runId: 'r1', text: 'hi', invokeId: 3 })
    expect(
      parseRendererChatEvent({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 't1',
        argumentsDelta: '{'
      })
    ).toMatchObject({ type: 'tool_call_delta', toolCallId: 't1' })
  })

  it('rejects malformed deltas and still parses status via schema', () => {
    expect(parseRendererChatEvent({ type: 'text_delta', runId: 'r1' })).toBeNull()
    expect(parseRendererChatEvent({ type: 'status', runId: 'r1', status: 'running' })).toEqual({
      type: 'status',
      runId: 'r1',
      status: 'running'
    })
  })
})
