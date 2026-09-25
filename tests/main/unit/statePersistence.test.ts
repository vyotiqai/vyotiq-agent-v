import { describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ensureUserMessageAt, syncMessages } from '@main/agent/state'
import { buildRunReceipt } from '@main/agent/runReceipt'
import type { ChatMessage, RunStatus } from '@shared/ipc'

/**
 * Invariants verified by the W7 persistence-anomaly audit (2026-09-22).
 *
 * The audit classified all five anomaly classes as detector artifacts of the
 * read-only sweep scripts. These tests pin the app-side invariants those
 * classifications rest on, so a real regression in state.ts / runReceipt.ts
 * surfaces here instead of hiding behind a miscounting detector.
 */
describe('state persistence invariants (W7 audit)', () => {
  it('stamps `at` only on user messages — assistant tool-call turns stay at-less', () => {
    const at = '2026-09-22T00:00:00.000Z'
    const user: ChatMessage = { role: 'user', content: 'go' }
    const assistant: ChatMessage = {
      role: 'assistant',
      content: '',
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"a.ts"}' }]
    }
    expect(ensureUserMessageAt(user, at).at).toBe(at)
    expect(ensureUserMessageAt(assistant, at)).toBe(assistant)
    expect(ensureUserMessageAt(assistant, at).at).toBeUndefined()
  })

  it('duplicate-message sweep key collides at-less empty-content assistant turns while records stay distinct', () => {
    // Root cause of the duplicateMessages=1203 class: the sweep key is
    // `role|at|toolCallId|contentJSON.slice(0,200)` and omits toolCalls, so two
    // distinct assistant tool-call turns both keyed `assistant|||""`. The records
    // themselves are distinct (0 full-record duplicates corpus-wide).
    const mk = (id: string): ChatMessage => ({
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read', arguments: '{}' }]
    })
    const sweepKey = (m: ChatMessage): string =>
      `${m.role}|${m.at || ''}|${(m as { toolCallId?: string }).toolCallId || ''}|${JSON.stringify(m.content).slice(0, 200)}`
    const a = mk('call_a')
    const b = mk('call_b')
    expect(sweepKey(a)).toBe(sweepKey(b))
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b))
  })

  it('syncMessages rewrite keeps history intact and drops archives (rewind cannot duplicate)', () => {
    // Pins the syncMessages contract (state.ts:236-243): the rewritten live file is
    // authoritative and stale archive heads are removed so stitched readers never
    // re-prepend duplicated history after a rewind/compaction rewrite.
    const dir = mkdtempSync(join(tmpdir(), 'w7-state-'))
    try {
      const archiveName = 'messages.archive.2026-09-22T00-00-00-000Z.jsonl'
      writeFileSync(
        join(dir, archiveName),
        `${JSON.stringify({ role: 'user', content: 'first', at: '2026-09-22T00:00:00.000Z' })}\n`
      )
      writeFileSync(
        join(dir, 'messages.jsonl'),
        `${JSON.stringify({ role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] })}\n`
      )
      const stitched: ChatMessage[] = [
        { role: 'user', content: 'first', at: '2026-09-22T00:00:00.000Z' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read', arguments: '{}' }] },
        { role: 'tool', toolCallId: 'c1', toolName: 'read', ok: true, content: 'ok' }
      ]
      syncMessages(dir, stitched)
      expect(existsSync(join(dir, archiveName))).toBe(false)
      const lines = readFileSync(join(dir, 'messages.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as ChatMessage)
      expect(lines).toHaveLength(3)
      expect(new Set(lines.map((line) => JSON.stringify(line))).size).toBe(3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('toolStats.byName sums equal top-level ok/failed/totalCalls, stubs and gate refusals excluded', () => {
    // Pins the receipt/usage invariant the buggy sweep sum failed to read:
    // the per-tool `byName` entries always sum to the top-level counters, and
    // never-executed calls (abort stubs, gate refusals) are usage-not-failures
    // (runReceipt.ts:385-403).
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'r1', name: 'read', arguments: '{"path":"a.ts"}' },
          { id: 'e1', name: 'edit', arguments: '{"path":"b.ts"}' }
        ]
      },
      { role: 'tool', toolCallId: 'r1', toolName: 'read', ok: true, content: 'ok' },
      { role: 'tool', toolCallId: 'e1', toolName: 'edit', ok: false, content: 'ENOENT' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 's1', name: 'terminal', arguments: '{"command":"dir"}' }]
      },
      { role: 'tool', toolCallId: 's1', toolName: 'terminal', ok: false, content: 'Cancelled' },
      {
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'g1', name: 'str_replace', arguments: '{"path":"c.ts"}' }]
      },
      {
        role: 'tool',
        toolCallId: 'g1',
        toolName: 'str_replace',
        ok: false,
        content:
          'The user denied permission to run str_replace. Do not retry it; ask what to do instead or continue without it.'
      }
    ]
    const status: RunStatus = { status: 'done', step: 3, updatedAt: '2026-09-22T00:00:00.000Z' }
    const receipt = buildRunReceipt({
      runId: 'w7-consistency',
      status,
      messages,
      events: [],
      contract: '## Goal\n\ntest\n'
    })
    const { byName, ok, failed, totalCalls } = receipt.toolStats
    const okSum = Object.values(byName).reduce((n, v) => n + v.ok, 0)
    const failSum = Object.values(byName).reduce((n, v) => n + v.failed, 0)
    expect(okSum).toBe(ok)
    expect(failSum).toBe(failed)
    expect(ok + failed).toBe(totalCalls)
    // Stub + gate refusal excluded from execution stats (BY-DESIGN pinned).
    expect(byName.terminal).toBeUndefined()
    expect(byName.str_replace).toBeUndefined()
    expect(byName).toEqual({ read: { ok: 1, failed: 0 }, edit: { ok: 0, failed: 1 } })
    expect(totalCalls).toBe(2)
  })
})
