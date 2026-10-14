import { describe, expect, it } from 'vitest'
import { estimateMessagesTokensAsync } from '@main/agent/context/estimate'
import type { ChatMessage } from '@shared/ipc'

describe('estimateMessagesTokensAsync', () => {
  it('counts messages pushed onto an array it has already counted', async () => {
    const messages: ChatMessage[] = [{ role: 'user', content: 'hello there' }]
    const before = await estimateMessagesTokensAsync(messages)
    messages.push({ role: 'assistant', content: 'a considerably longer reply with many more tokens in it' })
    const after = await estimateMessagesTokensAsync(messages)
    expect(after).toBeGreaterThan(before)
    expect(after).toBe(await estimateMessagesTokensAsync([...messages]))
  })
})
