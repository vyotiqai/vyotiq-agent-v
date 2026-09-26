import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { ChatMessage } from '@shared/ipc'
import { resetJsonlForTests } from '@main/harness/store/jsonl'
import {
  appendMessage,
  readToolResult,
  readTranscript,
  readTranscriptWindow,
  rewriteTranscript,
  withUserSendTime
} from '@main/harness/store/transcript'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vy-transcript-'))
  resetJsonlForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const line = (m: ChatMessage): string => `${JSON.stringify(m)}\n`
const ARCHIVE = 'messages.archive.2026-01-01T00-00-00-000Z.jsonl'

describe('transcript', () => {
  it('stamps a send time on user messages only', async () => {
    await appendMessage(dir, { role: 'user', content: 'go' })
    await appendMessage(dir, { role: 'assistant', content: 'ok' })
    const [user, assistant] = await readTranscript(dir)
    expect(typeof user!.at).toBe('string')
    expect(assistant!.at).toBeUndefined()
    const stamped = withUserSendTime({ role: 'user', content: 'x', at: 'kept' })
    expect(stamped.at).toBe('kept')
  })

  it('stitches legacy archives in front of the live file', async () => {
    writeFileSync(join(dir, ARCHIVE), line({ role: 'user', content: 'one' }))
    writeFileSync(join(dir, 'messages.jsonl'), line({ role: 'assistant', content: 'two' }))
    expect((await readTranscript(dir)).map((m) => m.content)).toEqual(['one', 'two'])
    expect((await readTranscript(dir, { skip: 1 })).map((m) => m.content)).toEqual(['two'])
  })

  it('reads a run without a transcript as empty', async () => {
    expect(await readTranscript(join(dir, 'missing'))).toEqual([])
  })

  it('throws on a read error instead of returning an empty history', async () => {
    // A directory where the file should be: EISDIR, not ENOENT.
    mkdirSync(join(dir, 'messages.jsonl'))
    await expect(readTranscript(dir)).rejects.toThrow()
  })

  it('pages backwards through archive and live file with stable cursors', async () => {
    const archived = Array.from({ length: 3 }, (_, i) => line({ role: 'user', content: `a${i}` })).join('')
    const live = Array.from({ length: 4 }, (_, i) => line({ role: 'assistant', content: `l${i}` })).join('')
    writeFileSync(join(dir, ARCHIVE), archived)
    writeFileSync(join(dir, 'messages.jsonl'), live)
    const first = await readTranscriptWindow(dir, { limit: 3 })
    expect(first.messages.map((m) => m.content)).toEqual(['l1', 'l2', 'l3'])
    expect(first.hasEarlier).toBe(true)
    const second = await readTranscriptWindow(dir, { limit: 3, cursor: first.earlierCursor })
    expect(second.messages.map((m) => m.content)).toEqual(['a1', 'a2', 'l0'])
    const third = await readTranscriptWindow(dir, { limit: 3, cursor: second.earlierCursor })
    expect(third.messages.map((m) => m.content)).toEqual(['a0'])
    expect(third.hasEarlier).toBe(false)
    expect(third.earlierCursor).toBeNull()
    const stale = await readTranscriptWindow(dir, { cursor: '9:10' })
    expect(stale).toEqual({ messages: [], hasEarlier: false, earlierCursor: null })
  })

  it('finds a tool result in the live file, across scan windows', async () => {
    const big = 'x'.repeat(300 * 1024)
    const lines = [
      line({ role: 'tool', toolCallId: 'target', toolName: 'read', content: big, ok: true }),
      ...Array.from({ length: 5 }, (_, i) => line({ role: 'assistant', content: 'y'.repeat(100 * 1024) + i }))
    ]
    writeFileSync(join(dir, 'messages.jsonl'), lines.join(''))
    expect(await readToolResult(dir, 'target')).toBe(big)
    expect(await readToolResult(dir, 'absent')).toBeNull()
  })

  it('finds a tool result that only a legacy archive still holds', async () => {
    writeFileSync(join(dir, ARCHIVE), line({ role: 'tool', toolCallId: 'old"id', toolName: 'grep', content: 'hit', ok: true }))
    writeFileSync(join(dir, 'messages.jsonl'), line({ role: 'assistant', content: 'later' }))
    expect(await readToolResult(dir, 'old"id')).toBe('hit')
  })

  it('rewrites behind pending appends and drops the archives it absorbed', async () => {
    writeFileSync(join(dir, ARCHIVE), line({ role: 'user', content: 'head' }))
    void appendMessage(dir, { role: 'assistant', content: 'queued' })
    const all = await readTranscript(dir)
    expect(all.map((m) => m.content)).toEqual(['head', 'queued'])
    await rewriteTranscript(dir, all.slice(0, 1))
    await appendMessage(dir, { role: 'assistant', content: 'after' })
    expect(readdirSync(dir).some((n) => n.startsWith('messages.archive.'))).toBe(false)
    expect(readFileSync(join(dir, 'messages.jsonl'), 'utf8')).toBe(
      line({ role: 'user', content: 'head' }) + line({ role: 'assistant', content: 'after' })
    )
  })
})
