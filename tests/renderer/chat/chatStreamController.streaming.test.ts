/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { parseDiffPreview, parseEditCardData } from '@renderer/features/chat/toolUi'

async function flushStreamPatches(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

describe('createChatStreamController', () => {
  it('persists turn collapse across transcript remounts', () => {
    const controller = createChatStreamController({ workspacePath: '/ws' })

    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([0])

    controller.toggleTurnCollapsed(0)
    expect(controller.collapsedTurnIndices).toEqual([])

    controller.toggleTurnCollapsed(1)
    controller.toggleTurnCollapsed(2)
    expect(controller.collapsedTurnIndices).toEqual([1, 2])

    controller.reset()
    expect(controller.collapsedTurnIndices).toEqual([])
  })

  it('re-notifies agent mode when a stale dedup cache would swallow a live divergence', () => {
    let liveMode: 'ask' | 'plan' | 'agent' = 'agent'
    const onAgentModeChange = vi.fn((mode: 'ask' | 'plan' | 'agent') => {
      liveMode = mode
    })
    const controller = createChatStreamController({
      workspacePath: '/ws',
      runId: 'r1',
      getAgentMode: () => liveMode,
      onAgentModeChange
    })

    // Prime the dedup cache with an event that matches live state: no notify.
    controller.handleEvent({ type: 'mode_changed', runId: 'r1', mode: 'agent' })
    expect(onAgentModeChange).not.toHaveBeenCalled()

    // User picks plan locally while idle — UI state changes without an event.
    liveMode = 'plan'

    // Run later emits 'agent' (switch_mode): the stale cache still says
    // 'agent', but live state says 'plan' — the notify must not be swallowed.
    controller.handleEvent({ type: 'mode_changed', runId: 'r1', mode: 'agent' })
    expect(onAgentModeChange).toHaveBeenCalledTimes(1)
    expect(onAgentModeChange).toHaveBeenCalledWith('agent')

    // Identical follow-up with live state already correct stays suppressed.
    controller.handleEvent({ type: 'mode_changed', runId: 'r1', mode: 'agent' })
    expect(onAgentModeChange).toHaveBeenCalledTimes(1)
  })

  it('appends terminal_output_delta into a running terminal tool row', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })

    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'term-1',
      name: 'terminal',
      summary: 'echo hi'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'hi\n',
      stream: 'stdout'
    })
    controller.handleEvent({
      type: 'terminal_output_delta',
      runId: 'r1',
      toolCallId: 'term-1',
      text: 'boom\n',
      stream: 'stderr'
    })
    await flushStreamPatches()

    const tool = controller.items.find((item) => item.kind === 'tool' && item.id === 'term-1')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind !== 'tool') return
    expect(tool.tool.status).toBe('running')
    expect(tool.tool.content).toBe('hi\n\nstderr:\nboom\n')
  })

  it('batches rapid text_delta events into one items revision per frame', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const revisions: number[] = []
    const unsub = controller.subscribeItems(() => {
      revisions.push(controller.getItemsRevision())
    })

    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'a', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'b', invokeId: 1 })
    controller.handleEvent({ type: 'text_delta', runId: 'r1', text: 'c', invokeId: 1 })
    await flushStreamPatches()

    unsub()
    expect(revisions.length).toBeLessThanOrEqual(2)
    expect(
      controller.items.some((item) => item.kind === 'message' && item.content === 'abc')
    ).toBe(true)
  })

  it('coalesces rapid tool_call_delta paints instead of one revision per chunk', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const revisions: number[] = []
    const unsub = controller.subscribeItems(() => {
      revisions.push(controller.getItemsRevision())
    })

    for (const argumentsDelta of ['{"path":"a.ts","diff":"', '@@\\n+', 'LIVE']) {
      controller.handleEvent({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 'e-coalesce',
        name: 'edit',
        argumentsDelta
      })
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 20))
    expect(revisions.length).toBe(0)

    await flushStreamPatches()
    unsub()

    expect(revisions.length).toBe(1)
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'e-coalesce')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview).toContain('LIVE')
  })
  it('streams edit argsPreview so parseDiffPreview grows before JSON closes', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })

    const full = JSON.stringify({
      path: 'src/live.ts',
      diff: ['@@', '-old', '+first', '+second', '+third'].join('\n')
    })
    // Chunk like a provider: small JSON fragments that stay invalid until the end.
    const chunks = [full.slice(0, 28), full.slice(28, 48), full.slice(48, 70), full.slice(70)]
    expect(chunks.join('')).toBe(full)

    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'edit-live',
      name: 'edit',
      summary: ''
    })

    let prev = 0
    for (const argumentsDelta of chunks) {
      controller.handleEvent({
        type: 'tool_call_delta',
        runId: 'r1',
        toolCallId: 'edit-live',
        name: 'edit',
        argumentsDelta
      })
      await flushStreamPatches()

      const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-live')
      expect(row?.kind).toBe('tool')
      if (row?.kind !== 'tool') return
      expect(row.tool.status).toBe('running')
      expect(row.tool.argsPreview?.length).toBeGreaterThan(0)

      const lines = parseDiffPreview(row.tool)
      expect(lines.length).toBeGreaterThanOrEqual(prev)
      prev = lines.length
    }

    expect(prev).toBeGreaterThanOrEqual(3)
    const finalRow = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-live')
    expect(finalRow?.kind).toBe('tool')
    if (finalRow?.kind !== 'tool') return
    expect(finalRow.tool.argsPreview).toBe(full)
    const finalLines = parseDiffPreview(finalRow.tool)
    expect(finalLines.some((l) => l.kind === 'add' && l.text === 'third')).toBe(true)
    expect(finalLines.some((l) => l.kind === 'del' && l.text === 'old')).toBe(true)
  })

  it('path-only argsPreview stays empty for parseDiffPreview until diff opens', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: ''
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: '{"path":"src/live-stream.ts"'
    })
    await flushStreamPatches()

    const pathOnly = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-path')
    expect(pathOnly?.kind).toBe('tool')
    if (pathOnly?.kind !== 'tool') return
    expect(parseDiffPreview(pathOnly.tool)).toEqual([])
    expect(parseEditCardData(pathOnly.tool).path).toBe('src/live-stream.ts')

    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-path',
      name: 'edit',
      argumentsDelta: ',"diff":"@@\\n+LIVE_EARLY'
    })
    await flushStreamPatches()
    const mid = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-path')
    expect(mid?.kind).toBe('tool')
    if (mid?.kind !== 'tool') return
    expect(parseDiffPreview(mid.tool).some((l) => l.text === 'LIVE_EARLY')).toBe(true)
  })

  it('keeps full streaming edit args so late lines paint past the 4000-char cap', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    const pad = 'x'.repeat(4500)
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-big',
      name: 'edit',
      argumentsDelta: `{"path":"big.ts","contents":"${pad}`
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-big',
      name: 'edit',
      argumentsDelta: 'LATE_STREAM_MARK'
    })
    await flushStreamPatches()
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-big')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview?.includes('LATE_STREAM_MARK')).toBe(true)
    expect(parseDiffPreview(row.tool).some((l) => l.text.includes('LATE_STREAM_MARK'))).toBe(true)
  })

  it('does not duplicate argsPreview when a growing full JSON blob is re-sent', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    const full1 = '{"path":"a.ts","diff":"'
    const full2 = '{"path":"a.ts","diff":"@@\\n+LIVE'
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-cum',
      name: 'edit',
      argumentsDelta: full1
    })
    await flushStreamPatches()
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-cum',
      name: 'edit',
      argumentsDelta: full2
    })
    await flushStreamPatches()
    const row = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-cum')
    expect(row?.kind).toBe('tool')
    if (row?.kind !== 'tool') return
    expect(row.tool.argsPreview).toBe(full2)
    expect(parseDiffPreview(row.tool).some((l) => l.text === 'LIVE')).toBe(true)
  })

  it('paints contents when a complete path-only JSON is replaced by path+contents', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-snap',
      name: 'edit',
      argumentsDelta: '{"path":"plan.md"}'
    })
    await flushStreamPatches()
    const pathOnly = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-snap')
    expect(pathOnly?.kind).toBe('tool')
    if (pathOnly?.kind !== 'tool') return
    expect(parseDiffPreview(pathOnly.tool)).toEqual([])

    controller.handleEvent({
      type: 'tool_call_delta',
      runId: 'r1',
      toolCallId: 'edit-snap',
      name: 'edit',
      argumentsDelta: '{"path":"plan.md","contents":"# Plan\\nLIVE_LINE"}'
    })
    await flushStreamPatches()
    const withBody = controller.items.find((item) => item.kind === 'tool' && item.id === 'edit-snap')
    expect(withBody?.kind).toBe('tool')
    if (withBody?.kind !== 'tool') return
    expect(withBody.tool.argsPreview).toContain('LIVE_LINE')
    expect(parseDiffPreview(withBody.tool).some((l) => l.text === 'LIVE_LINE')).toBe(true)
  })

  it('demotes in-progress todo markers when the run reaches a terminal status', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({
      type: 'tool_start',
      runId: 'r1',
      toolCallId: 'todo1',
      name: 'todo_write'
    })
    controller.handleEvent({
      type: 'tool_result',
      runId: 'r1',
      toolCallId: 'todo1',
      name: 'todo_write',
      ok: true,
      summary: '1 task',
      content: '0/1 complete\n[~] (1) Ship'
    })
    await flushStreamPatches()

    controller.handleEvent({ type: 'status', runId: 'r1', status: 'done', invokeId: 1 })
    await flushStreamPatches()

    const todo = controller.items.find((item) => item.kind === 'tool' && item.id === 'todo1')
    expect(todo?.kind).toBe('tool')
    if (todo?.kind !== 'tool') return
    expect(todo.tool.content).toContain('[ ] (1) Ship')
    expect(todo.tool.content).not.toContain('[~]')
  })

  it('replaces streamed thinking with thinking_done snapshot instead of concatenating', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.handleEvent({ type: 'status', runId: 'r1', status: 'running', invokeId: 1 })
    controller.handleEvent({ type: 'thinking_delta', runId: 'r1', text: 'AB', invokeId: 1 })
    await flushStreamPatches()
    controller.handleEvent({ type: 'thinking_done', runId: 'r1', text: 'ABC', invokeId: 1 })
    await flushStreamPatches()

    const message = controller.items.find((item) => item.kind === 'message')
    expect(message?.kind).toBe('message')
    if (message?.kind !== 'message') return
    expect(message.thinking).toBe('ABC')
    expect(message.thinking).not.toContain('AB\n\nABC')
    expect(message.thinkingStreaming).toBe(false)
  })
})
