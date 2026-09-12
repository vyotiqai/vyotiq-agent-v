import { describe, expect, it } from 'vitest'

import {
  estimateMessagesTokensAsync,
  shouldTriggerAutoCompact
} from '../../../src/main/agent/context/estimate'
import type { ChatMessage } from '../../../src/shared/ipc'

const replayText = 'r'.repeat(48_000)

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
