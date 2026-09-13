import { describe, expect, it } from 'vitest'
import {
  toolMessageForIpc,
  toolResultEventForIpc,
  toolResultEventForPersistence,
  TOOL_RESULT_IPC_PREVIEW_CHARS
} from '@shared/utils/toolResultIpc'

describe('toolResultEventForIpc', () => {
  it('passes through small tool results unchanged', () => {
    const event = {
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'read',
      summary: 'file.ts',
      ok: true,
      content: 'hello'
    }
    expect(toolResultEventForIpc(event)).toBe(event)
  })

  it('truncates large tool results for IPC', () => {
    const content = 'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS + 500)
    const event = {
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'read',
      summary: 'big.ts',
      ok: true,
      content
    }
    const trimmed = toolResultEventForIpc(event)
    expect(trimmed.type).toBe('tool_result')
    if (trimmed.type !== 'tool_result') return
    expect(trimmed.content?.length).toBeLessThan(content.length)
    expect(trimmed.content?.includes('\n…\n')).toBe(true)
    if (trimmed.type !== 'tool_result') return
    expect(trimmed.contentTruncated).toBe(true)
  })

  it('keeps the trailing exit_code footer when a large terminal result is truncated', () => {
    const body = 'Test Files 3 failed | 5 passed\n' + 'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS)
    const content = `${body}\nexit_code: 1`
    const trimmed = toolResultEventForIpc({
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'terminal',
      summary: 'pnpm test',
      ok: false,
      content
    })
    if (trimmed.type !== 'tool_result') return
    // The footer is the verdict. Dropping it made a failed run render with no
    // exit badge, and `terminalResultOk` then read it as a pass.
    expect(trimmed.content?.endsWith('exit_code: 1')).toBe(true)
  })

  it('truncates large tool results for IPC', () => {
    const content = 'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS + 500)
    const event = {
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'read',
      summary: 'investigate',
      ok: true,
      content
    }
    const trimmed = toolResultEventForIpc(event)
    expect(trimmed.type).toBe('tool_result')
    if (trimmed.type !== 'tool_result') return
    expect(trimmed.content?.length).toBeLessThan(content.length)
    expect(trimmed.contentTruncated).toBe(true)
  })

  it('does not modify non-tool events', () => {
    const event = { type: 'status' as const, runId: 'r1', status: 'done' as const }
    expect(toolResultEventForIpc(event)).toBe(event)
  })
})

describe('toolResultEventForPersistence', () => {
  it('drops large tool result bodies from events.jsonl', () => {
    const event = {
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'read',
      summary: 'big.ts',
      ok: true,
      content: 'x'.repeat(500)
    }
    const slim = toolResultEventForPersistence(event)
    expect(slim.type).toBe('tool_result')
    if (slim.type !== 'tool_result') return
    expect(slim.content).toBeUndefined()
    expect(slim.summary).toBe('big.ts')
  })

  it('keeps short error payloads in events.jsonl', () => {
    const event = {
      type: 'tool_result' as const,
      runId: 'r1',
      toolCallId: 'c1',
      name: 'read',
      summary: 'invalid',
      ok: false,
      content: 'Failed to parse tool arguments'
    }
    const slim = toolResultEventForPersistence(event)
    if (slim.type !== 'tool_result') return
    expect(slim.content).toBe('Failed to parse tool arguments')
  })
})

describe('toolMessageForIpc', () => {
  it('bounds historical tool messages and marks them for lazy loading', () => {
    const content = 'x'.repeat(TOOL_RESULT_IPC_PREVIEW_CHARS + 500)
    const trimmed = toolMessageForIpc({
      role: 'tool',
      toolCallId: 'c1',
      toolName: 'read',
      ok: true,
      content
    })
    expect(typeof trimmed.content).toBe('string')
    expect(String(trimmed.content).length).toBeLessThan(content.length)
    expect(trimmed.contentTruncated).toBe(true)
  })

  it('does not alter provider-facing non-tool history', () => {
    const message = { role: 'assistant' as const, content: 'answer' }
    expect(toolMessageForIpc(message)).toBe(message)
  })
})
