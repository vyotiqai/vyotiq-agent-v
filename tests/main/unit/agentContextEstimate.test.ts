import { describe, expect, it } from 'vitest'

import {
  estimateMessagesTokensAsync,
  shouldTriggerAutoCompact
} from '../../../src/main/agent/context/estimate'
import type { ChatMessage } from '../../../src/shared/ipc'

// Words, as reasoning is: one letter repeated is BPE's worst case, ~30x slower
// under coverage, and it put this file at the 30s test timeout on CI runners.
const replayText = 'Weigh the cache drift against the token budget first. '.repeat(900)

/**
 * RC1 fixture: an assistant turn whose reasoning is stored for the UI
 * (reasoningState) but stripped from the wire by the provider (mirrors the
 * strip decision in providers/openai.ts createOpenAiCompatProvider).
 */
function contentOnly(): ChatMessage[] {
  return [
    { role: 'user', content: 'Summarize the design doc and list the open risks.' },
    { role: 'assistant', content: 'Key risks are cache drift and token accounting.' }
  ] as unknown as ChatMessage[]
}

function withReplay(): ChatMessage[] {
  return [
    { role: 'user', content: 'Summarize the design doc and list the open risks.' },
    {
      role: 'assistant',
      content: 'Key risks are cache drift and token accounting.',
      reasoningState: { kind: 'openai_compat', text: replayText }
    }
  ] as unknown as ChatMessage[]
}

describe('agent context estimate (reasoning replay)', () => {
  it('stops counting reasoning replay that is not sent on the wire', async () => {
    const plain = await estimateMessagesTokensAsync(contentOnly())
    const inflated = await estimateMessagesTokensAsync(withReplay())
    const onWire = await estimateMessagesTokensAsync(withReplay(), undefined, {
      countReasoningReplay: false
    })

    expect(inflated).toBeGreaterThan(plain * 2)
    expect(onWire).toBeGreaterThan(0)
    expect(onWire).toBeLessThan(inflated / 2)
  })

  it('keeps replay totals isolated per flag across the shared caches', async () => {
    const messages = withReplay()
    const inflated = await estimateMessagesTokensAsync(messages)
    const stripped = await estimateMessagesTokensAsync(messages, undefined, {
      countReasoningReplay: false
    })

    expect(stripped).toBeLessThan(inflated / 2)
    // Flipping the flag back must not serve the stripped prefix total.
    expect(await estimateMessagesTokensAsync(messages)).toBe(inflated)
  })

  it('post-compaction estimate matches the compacted context scale, not replay', async () => {
    // compactRun.ts records the compacted context at content-only scale;
    // the next assemble must not regress to the replay-inflated figure.
    const compactedScale = await estimateMessagesTokensAsync(contentOnly())
    const assembled = await estimateMessagesTokensAsync(withReplay(), undefined, {
      countReasoningReplay: false
    })

    expect(assembled).toBeLessThanOrEqual(compactedScale * 1.5)
  })
})

describe('agent context estimate (history rewritten in place)', () => {
  /**
   * Mirrors `trimToolResults`: same length, tail returned by identity, an older
   * body replaced. The cache used to key on (length, tail identity) and would
   * serve the pre-rewrite total for exactly this shape.
   */
  it('re-counts a same-length array whose middle changed and whose tail is the same object', async () => {
    const tail: ChatMessage = {
      role: 'tool',
      toolName: 'read',
      toolCallId: 'keep',
      content: 'kept body'
    } as unknown as ChatMessage
    const fat: ChatMessage = {
      role: 'tool',
      toolName: 'read',
      toolCallId: 'old',
      content: 'A long tool result body, since cleared from the wire. '.repeat(370)
    } as unknown as ChatMessage

    const before = [{ role: 'user', content: 'go' }, fat, tail] as unknown as ChatMessage[]
    const full = await estimateMessagesTokensAsync(before)

    const after = before.map((m) => (m === fat ? { ...m, content: '[cleared]' } : m))
    expect(after).toHaveLength(before.length)
    expect(after[after.length - 1]).toBe(tail)

    const cleared = await estimateMessagesTokensAsync(after)
    expect(cleared).toBeLessThan(full / 2)
  })

  it('still serves the memo for the identical array', async () => {
    const messages = [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: 'done' }
    ] as unknown as ChatMessage[]
    const first = await estimateMessagesTokensAsync(messages)
    expect(await estimateMessagesTokensAsync(messages)).toBe(first)
  })
})

describe('agent context estimate (resume anchor)', () => {
  it('anchors the compaction decision on the provider figure across resume', () => {
    // Resumed run before the first usage report arrives: the replay-inflated
    // local estimate (709k) must not fire compaction while the checkpoint
    // restored the last provider-reported input tokens (46k).
    expect(shouldTriggerAutoCompact(709_000, 150_000, 46_000)).toEqual({
      trigger: false,
      source: 'provider'
    })
  })

  it('still triggers proactively when no provider figure exists yet', () => {
    expect(shouldTriggerAutoCompact(160_000, 150_000, null)).toEqual({
      trigger: true,
      source: 'estimate'
    })
    expect(shouldTriggerAutoCompact(10_000, 150_000, null)).toEqual({
      trigger: false,
      source: 'estimate'
    })
  })
})

/**
 * Every part kind a message can carry, in one object. Counting used to be walked by
 * two separately-maintained branch sets — a synchronous incremental path and the
 * batched worker path — which is how they drifted. There is one walk now
 * (`messageParts`), and these tests are what keeps every branch of it counted.
 */
function richMessages(): ChatMessage[] {
  return [
    { role: 'user', content: 'plain string content' },
    {
      role: 'user',
      content: [
        { type: 'text', text: 'a text part' },
        { type: 'image_url', url: 'https://example.com/photo.jpg' },
        { type: 'audio', url: 'data:audio/wav;base64,' + 'A'.repeat(4000) },
        { type: 'file_native', name: 'a.pdf', mime: 'application/pdf', data: 'B'.repeat(4000) },
        { type: 'file', name: 'notes.md', mime: 'text/markdown', text: 'file part text' }
      ]
    },
    {
      role: 'assistant',
      content: 'calling a tool',
      thinking: 'ui-only thinking',
      reasoningState: { kind: 'openai_compat', text: 'wire replay reasoning' },
      toolCalls: [{ id: 'c1', name: 'read', arguments: '{"path":"src/index.ts"}' }]
    },
    { role: 'tool', toolName: 'read', toolCallId: 'c1', content: 'file body' }
  ] as unknown as ChatMessage[]
}

describe('agent context estimate (one walk)', () => {
  it('reaches the same total whether history arrives whole or one message at a time', async () => {
    // Fresh objects each time: the per-message cache is a WeakMap keyed by
    // identity, so distinct objects force a real re-count down each path.
    const cold = await estimateMessagesTokensAsync(richMessages())

    const growing = richMessages()
    let incremental = 0
    for (let n = 1; n <= growing.length; n++) {
      incremental = await estimateMessagesTokensAsync(growing.slice(0, n))
    }
    expect(incremental).toBe(cold)
  })

  it('reaches the same total either way with reasoning replay switched off', async () => {
    const opts = { countReasoningReplay: false }
    const cold = await estimateMessagesTokensAsync(richMessages(), undefined, opts)

    const growing = richMessages()
    let incremental = 0
    for (let n = 1; n <= growing.length; n++) {
      incremental = await estimateMessagesTokensAsync(growing.slice(0, n), undefined, opts)
    }
    expect(incremental).toBe(cold)
    expect(cold).toBeLessThan(await estimateMessagesTokensAsync(richMessages()))
  })

  it('counts every part kind — dropping any one lowers the total', async () => {
    const full = await estimateMessagesTokensAsync(richMessages())
    const partKinds = ['text', 'image_url', 'audio', 'file_native', 'file'] as const

    for (const kind of partKinds) {
      const without = richMessages()
      const rich = without[1] as unknown as { content: { type: string }[] }
      rich.content = rich.content.filter((part) => part.type !== kind)
      expect(await estimateMessagesTokensAsync(without)).toBeLessThan(full)
    }

    const withoutToolCalls = richMessages()
    delete (withoutToolCalls[2] as unknown as { toolCalls?: unknown }).toolCalls
    expect(await estimateMessagesTokensAsync(withoutToolCalls)).toBeLessThan(full)

    const withoutToolName = richMessages()
    ;(withoutToolName[3] as unknown as { toolName?: string }).toolName = ''
    expect(await estimateMessagesTokensAsync(withoutToolName)).toBeLessThan(full)
  })

  it('prefers wire reasoning replay over the UI thinking field', async () => {
    const both = richMessages()
    const replayOnly = richMessages()
    delete (replayOnly[2] as unknown as { thinking?: string }).thinking
    // Counting both would double-count the same reasoning and compact early.
    expect(await estimateMessagesTokensAsync(both)).toBe(
      await estimateMessagesTokensAsync(replayOnly)
    )
  })
})
