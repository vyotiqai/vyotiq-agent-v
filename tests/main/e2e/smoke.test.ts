import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyUnifiedDiff } from '@main/agent/tools/edit'
import { toolSearch } from '@main/agent/tools/search'
import { assertInsideWorkspace } from '@shared/workspacePath'
import {
  appendAssistantWithTools,
  appendToolResult,
  messagesForNextTurn
} from '@shared/chatHistory'
import type { ChatMessage } from '@shared/ipc'
import { applyEventTimestamps, messagesToUiItems } from '@shared/transcript'
import {
  registerRunAbort,
  cancelRun,
  clearRunAbort,
  chatCancelResult
} from '@main/agent/runRegistry'

describe('e2e smoke (no Electron GUI)', () => {
  it('cancels mid-flight via AbortController', async () => {
    const runId = 'smoke-cancel'
    const { controller, invokeId } = registerRunAbort(runId, '/ws')
    expect(cancelRun(runId)).toBe(true)
    expect(controller.signal.aborted).toBe(true)
    clearRunAbort(runId, invokeId)
  })

  it('diff apply + sandbox + search honesty', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-smoke-'))
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'note.md'), 'alpha beta gamma\n', 'utf8')

    const next = applyUnifiedDiff('a\nb\nc\n', '@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n')
    expect(next).toBe('a\nB\nc\n')

    expect(() => assertInsideWorkspace(dir, '../x')).toThrow(/escapes workspace/)
    expect(assertInsideWorkspace(dir, 'src/note.md')).toContain('note.md')

    const found = await toolSearch(dir, 'beta', 10)
    expect(found).toMatch(/note\.md/)
    expect(await toolSearch(dir, 'bet.*', 10)).toMatch(/No matches/i)
  })

  it('multi-turn tool role order for next chatStart', () => {
    let msgs: ChatMessage[] = [{ role: 'user', content: 'read a' }]
    msgs = appendAssistantWithTools(msgs, '', [
      { id: 't1', name: 'read', arguments: '{"path":"a.ts"}' }
    ])
    msgs = appendToolResult(msgs, 't1', 'read', 'file body')
    msgs = appendAssistantWithTools(msgs, 'done reading')
    msgs = [...msgs, { role: 'user', content: 'again' }]

    const payload = messagesForNextTurn(msgs)
    const roles = payload.map((m) => m.role)
    expect(roles).toEqual(['user', 'assistant', 'tool', 'assistant', 'user'])
  })

  it('cancel missing run returns not found', () => {
    expect(chatCancelResult('nope-nope')).toEqual({
      ok: false,
      error: 'Run not found'
    })
  })

  it('replays transcript timestamps from persisted events by toolCallId', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
      },
      { role: 'tool', toolCallId: 'c1', toolName: 'read', content: 'ok' }
    ]
    const items = applyEventTimestamps(messagesToUiItems(messages), [
      {
        at: '2026-07-24T12:00:00.000Z',
        event: {
          type: 'tool_start',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts'
        }
      },
      {
        at: '2026-07-24T12:00:01.000Z',
        event: {
          type: 'tool_result',
          runId: 'r1',
          toolCallId: 'c1',
          name: 'read',
          summary: 'a.ts',
          ok: true,
          content: 'ok'
        }
      }
    ])
    const tool = items.find((i) => i.kind === 'tool')
    expect(tool?.kind).toBe('tool')
    if (tool?.kind === 'tool') {
      expect(tool.at).toBe('2026-07-24T12:00:00.000Z')
      expect(tool.tool.status).toBe('done')
    }
  })
})
