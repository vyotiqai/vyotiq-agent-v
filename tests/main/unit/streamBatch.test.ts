import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  ChatEventBatcher,
  ChatEventDispatcher,
  excludeChatEventUiSubscription,
  getChatEventBatchStats,
  resetChatEventBatchStats,
  resetChatEventDispatcher,
  setChatEventActivePathResolver,
  setChatEventUiSubscriptions
} from '@main/ipc/streamBatch'
import { registerRunAbort, resetActiveRunsForTests } from '@main/agent/runRegistry'
import type { AgentEvent } from '@shared/ipc'

describe('ChatEventBatcher', () => {
  let sent: AgentEvent[]

  beforeEach(() => {
    sent = []
    resetChatEventBatchStats()
    resetChatEventDispatcher()
    setChatEventActivePathResolver(() => null)
    vi.useFakeTimers()
  })

  afterEach(() => {
    setChatEventActivePathResolver(null)
    resetChatEventDispatcher()
    vi.useRealTimers()
  })

  it('preserves interleaved thinking and text order within a batch window', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'reason ' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'answer' })
    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'more' })

    vi.advanceTimersByTime(16)

    expect(sent.map((ev) => ev.type)).toEqual([
      'thinking_delta',
      'text_delta',
      'thinking_delta'
    ])
    expect(sent[0]).toMatchObject({ type: 'thinking_delta', text: 'reason ' })
    expect(sent[1]).toMatchObject({ type: 'text_delta', text: 'answer' })
    expect(sent[2]).toMatchObject({ type: 'thinking_delta', text: 'more' })
  })

  it('coalesces consecutive segments of the same kind', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'hel' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'lo' })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([{ type: 'text_delta', runId: 'run-1', text: 'hello' }])
  })

  it('coalesces terminal_output_delta for the same toolCallId and stream', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'terminal_output_delta',
      runId: 'run-1',
      toolCallId: 't1',
      text: 'hel',
      stream: 'stdout'
    })
    batcher.push({
      type: 'terminal_output_delta',
      runId: 'run-1',
      toolCallId: 't1',
      text: 'lo\n',
      stream: 'stdout'
    })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      {
        type: 'terminal_output_delta',
        runId: 'run-1',
        toolCallId: 't1',
        text: 'hello\n',
        stream: 'stdout'
      }
    ])
  })

  it('flushes pending deltas before non-delta events', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'thinking_delta', runId: 'run-1', text: 'think' })
    batcher.push({ type: 'status', runId: 'run-1', status: 'done' })

    expect(sent.map((ev) => ev.type)).toEqual(['thinking_delta', 'status'])
  })

  it('batches tool_call_delta with pending text and preserves order', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'Looking up.' })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"p'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: 'ath"}'
    })

    vi.advanceTimersByTime(16)

    expect(sent.map((ev) => ev.type)).toEqual(['text_delta', 'tool_call_delta'])
    expect(sent[0]).toMatchObject({ type: 'text_delta', text: 'Looking up.' })
    expect(sent[1]).toMatchObject({
      type: 'tool_call_delta',
      toolCallId: 'c1',
      name: 'read',
      argumentsDelta: '{"path"}'
    })
  })

  it('coalesces tool_call_delta for the same toolCallId', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'toolu_1',
      name: 'read',
      argumentsDelta: ''
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'toolu_1',
      name: 'read',
      argumentsDelta: '{"a":1}'
    })

    expect(sent).toEqual([])
    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      {
        type: 'tool_call_delta',
        runId: 'run-1',
        toolCallId: 'toolu_1',
        name: 'read',
        argumentsDelta: '{"a":1}'
      }
    ])
  })

  it('keeps separate toolCallIds as separate segments', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'a',
      name: 'read',
      argumentsDelta: '1'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 'b',
      name: 'grep',
      argumentsDelta: '2'
    })

    vi.advanceTimersByTime(16)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ toolCallId: 'a', argumentsDelta: '1' })
    expect(sent[1]).toMatchObject({ toolCallId: 'b', argumentsDelta: '2' })
  })

  it('preserves invoke ids on batched deltas and keeps thinking steps separate', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({
      type: 'thinking_delta',
      runId: 'run-1',
      invokeId: 7,
      step: 1,
      text: 'first'
    })
    batcher.push({
      type: 'thinking_delta',
      runId: 'run-1',
      invokeId: 7,
      step: 2,
      text: 'second'
    })
    batcher.push({ type: 'text_delta', runId: 'run-1', invokeId: 7, text: 'answer' })

    vi.advanceTimersByTime(16)

    expect(sent).toEqual([
      { type: 'thinking_delta', runId: 'run-1', invokeId: 7, step: 1, text: 'first' },
      { type: 'thinking_delta', runId: 'run-1', invokeId: 7, step: 2, text: 'second' },
      { type: 'text_delta', runId: 'run-1', invokeId: 7, text: 'answer' }
    ])
  })

  it('tracks push vs sent counts for baseline measurement', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'a' })
    batcher.push({ type: 'text_delta', runId: 'run-1', text: 'b' })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 't1',
      argumentsDelta: 'x'
    })
    batcher.push({
      type: 'tool_call_delta',
      runId: 'run-1',
      toolCallId: 't1',
      argumentsDelta: 'y'
    })

    expect(getChatEventBatchStats().pushed).toBe(4)
    expect(getChatEventBatchStats().sent).toBe(0)

    vi.advanceTimersByTime(16)

    const stats = getChatEventBatchStats()
    expect(stats.sent).toBe(2)
    expect(stats.byType['text_delta']).toBe(2)
    expect(stats.byType['tool_call_delta']).toBe(2)
  })

  it('drops oldest deltas when the pending queue exceeds the count cap', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    // Alternating invoke ids prevent adjacent coalescing, so 600 pushes are
    // 600 distinct segments — past the cap, oldest must be dropped and the
    // newest retained (the renderer catch-up rebuilds any gap).
    for (let i = 0; i < 600; i++) {
      batcher.push({
        type: 'text_delta',
        runId: 'run-1',
        invokeId: i % 2 === 0 ? 1 : 2,
        text: `s${i}`
      })
    }

    expect(getChatEventBatchStats().pushed).toBe(600)
    expect(getChatEventBatchStats().overflowDropped).toBeGreaterThan(0)
    expect(getChatEventBatchStats().overflowDropped).toBeLessThanOrEqual(600 - 512)

    vi.advanceTimersByTime(16)

    const last = sent.at(-1) as { type: string; text: string }
    expect(last.type).toBe('text_delta')
    expect(last.text.endsWith('s599')).toBe(true)
  })

  it('drops oldest deltas when pending bytes exceed the byte cap', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    const big = 'x'.repeat(1024 * 1024)
    for (let i = 0; i < 12; i++) {
      batcher.push({
        type: 'text_delta',
        runId: 'run-1',
        invokeId: i % 2 === 0 ? 1 : 2,
        text: `${big}${i}`
      })
    }

    expect(getChatEventBatchStats().overflowDropped).toBeGreaterThan(0)

    vi.advanceTimersByTime(16)

    const last = sent.at(-1) as { text: string }
    expect(last.text.endsWith('11')).toBe(true)
  })

  it('never drops pending usage events when enforcing the cap', () => {
    const batcher = new ChatEventBatcher((ev) => sent.push(ev))

    for (let i = 0; i < 600; i++) {
      batcher.push({
        type: 'text_delta',
        runId: 'run-1',
        invokeId: i % 2 === 0 ? 1 : 2,
        text: `s${i}`
      })
    }
    // An active-workspace usage event rides the same queue — it must survive.
    batcher.push({
      type: 'step_usage',
      runId: 'run-1',
      step: 3,
      inputTokens: 9,
      outputTokens: 9
    })

    vi.advanceTimersByTime(16)

    expect(sent.some((ev) => ev.type === 'step_usage')).toBe(true)
  })
})

describe('ChatEventDispatcher priority', () => {
  beforeEach(() => {
    resetChatEventBatchStats()
    resetChatEventDispatcher()
    vi.useFakeTimers()
  })

  afterEach(() => {
    setChatEventActivePathResolver(null)
    resetChatEventDispatcher()
    vi.useRealTimers()
  })

  it('does not flush background deltas when the focused run timer fires', () => {
    const order: string[] = []
    setChatEventActivePathResolver(() => '/ws-active')

    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-bg', '/ws-bg', (ev) => order.push(`bg:${ev.type}`))
    dispatcher.attach('run-fg', '/ws-active', (ev) => order.push(`fg:${ev.type}`))

    dispatcher.push('run-bg', { type: 'text_delta', runId: 'run-bg', text: 'b' })
    dispatcher.push('run-fg', { type: 'text_delta', runId: 'run-fg', text: 'a' })

    vi.advanceTimersByTime(16)
    expect(order).toEqual(['fg:text_delta'])
    vi.advanceTimersByTime(64)
    expect(order).toEqual(['fg:text_delta', 'bg:text_delta'])
  })

  it('keeps latest background usage per step', () => {
    const sent: AgentEvent[] = []
    setChatEventActivePathResolver(() => '/ws-active')

    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-bg', '/ws-bg', (ev) => sent.push(ev))

    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 1,
      inputTokens: 1,
      outputTokens: 1
    })
    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 1,
      inputTokens: 3,
      outputTokens: 3
    })
    dispatcher.push('run-bg', {
      type: 'step_usage',
      runId: 'run-bg',
      step: 2,
      inputTokens: 9,
      outputTokens: 9
    })

    vi.advanceTimersByTime(80)

    expect(sent).toHaveLength(2)
    expect(sent[0]).toMatchObject({ type: 'step_usage', inputTokens: 3, step: 1 })
    expect(sent[1]).toMatchObject({ type: 'step_usage', inputTokens: 9, step: 2 })
  })

  it('uses background batch interval only for inactive workspaces', () => {
    const sent: AgentEvent[] = []
    setChatEventActivePathResolver(() => '/ws-active')
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-bg', '/ws-bg', (ev) => sent.push(ev))
    dispatcher.push('run-bg', { type: 'text_delta', runId: 'run-bg', text: 'a' })
    vi.advanceTimersByTime(16)
    expect(sent).toHaveLength(0)
    vi.advanceTimersByTime(64)
    expect(sent).toHaveLength(1)
  })

  it('does not slow the focused run when many runs are attached', () => {
    resetActiveRunsForTests()
    for (let i = 0; i < 8; i++) {
      registerRunAbort(`cap-${i}`, '/ws-active')
    }
    const sent: AgentEvent[] = []
    setChatEventActivePathResolver(() => '/ws-active')
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-fg', '/ws-active', (ev) => sent.push(ev))
    dispatcher.push('run-fg', { type: 'text_delta', runId: 'run-fg', text: 'a' })
    vi.advanceTimersByTime(16)
    expect(sent).toHaveLength(1)
  })

  it('flushes only the same run when a non-delta arrives', () => {
    const order: string[] = []
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('run-a', '/ws', (ev) => order.push(`a:${ev.type}`))
    dispatcher.attach('run-b', '/ws', (ev) => order.push(`b:${ev.type}`))
    dispatcher.push('run-a', { type: 'text_delta', runId: 'run-a', text: 'a' })
    dispatcher.push('run-b', { type: 'text_delta', runId: 'run-b', text: 'b' })
    dispatcher.push('run-a', { type: 'status', runId: 'run-a', status: 'running' })
    expect(order).toEqual(['a:text_delta', 'a:status'])
    vi.advanceTimersByTime(16)
    expect(order).toEqual(['a:text_delta', 'a:status', 'b:text_delta'])
  })

  it('does not emit gated deltas for unsubscribed runs', () => {
    const sent: AgentEvent[] = []
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('parent', '/ws', (ev) => sent.push(ev))
    dispatcher.attach('child', '/ws', (ev) => sent.push(ev))
    excludeChatEventUiSubscription('child')
    dispatcher.push('parent', { type: 'text_delta', runId: 'parent', text: 'p' })
    dispatcher.push('child', { type: 'text_delta', runId: 'child', text: 'c' })
    dispatcher.push('child', { type: 'status', runId: 'child', status: 'running' })
    vi.advanceTimersByTime(16)
    expect(sent.map((ev) => `${ev.runId}:${ev.type}`)).toEqual([
      'child:status',
      'parent:text_delta'
    ])
    expect(getChatEventBatchStats().uiGated).toBe(1)
  })

  it('does not emit tool_start for unsubscribed runs', () => {
    const sent: AgentEvent[] = []
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('child', '/ws', (ev) => sent.push(ev))
    excludeChatEventUiSubscription('child')
    dispatcher.push('child', {
      type: 'tool_start',
      runId: 'child',
      toolCallId: 't1',
      name: 'read',
      summary: 'read a.ts'
    })
    dispatcher.push('child', { type: 'status', runId: 'child', status: 'running' })
    expect(sent.map((ev) => ev.type)).toEqual(['status'])
    expect(getChatEventBatchStats().uiGated).toBe(1)
  })

  it('streams a child after subscribe replaces the visible set', () => {
    const sent: AgentEvent[] = []
    const dispatcher = new ChatEventDispatcher()
    dispatcher.attach('child', '/ws', (ev) => sent.push(ev))
    excludeChatEventUiSubscription('child')
    dispatcher.push('child', { type: 'text_delta', runId: 'child', text: 'hidden' })
    setChatEventUiSubscriptions(['child'])
    dispatcher.push('child', { type: 'text_delta', runId: 'child', text: 'shown' })
    vi.advanceTimersByTime(16)
    expect(sent).toEqual([{ type: 'text_delta', runId: 'child', text: 'shown' }])
  })
})
