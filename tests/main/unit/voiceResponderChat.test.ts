import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ModelInfo } from '@shared/ipc'

const streamChat = vi.fn()
const resolveModelInfo = vi.fn()

vi.mock('@main/agent/providers', () => ({ getProvider: () => ({ streamChat }) }))
vi.mock('@main/agent/modelResolve', () => ({ resolveModelInfo: (...args: unknown[]) => resolveModelInfo(...args) }))
vi.mock('@main/settings/secrets', () => ({ getSecret: () => 'sk-or-test' }))
vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ voice: { responder: { provider: 'openrouter', model: 'z-ai/glm-5.3-flash' } } })
}))

const { makeResponderChat, responderThinking, resetResponderModelInfoForTests } = await import('@main/voice/responderChat')

const info = (over: Partial<ModelInfo>): ModelInfo => ({ id: 'm', displayName: 'm', contextWindow: 1000, ...over }) as ModelInfo

async function drain(chat: NonNullable<ReturnType<typeof makeResponderChat>>): Promise<void> {
  for await (const _ of chat({ system: 's', status: 'idle', messages: [{ role: 'user', content: 'hi' }], tools: [], signal: new AbortController().signal })) {
    /* drain */
  }
}

describe('how much the voice model thinks', () => {
  it('turns thinking off where the model allows it', () => {
    expect(responderThinking(undefined)).toEqual({ enabled: false })
    expect(responderThinking(info({ supportsThinking: false }))).toEqual({ enabled: false })
    expect(responderThinking(info({ supportsThinking: true, thinkingCanDisable: true }))).toEqual({ enabled: false })
    // Unknown whether it can be turned off: off is asked for, as before.
    expect(responderThinking(info({ supportsThinking: true }))).toEqual({ enabled: false })
  })

  it('asks for the lowest listed effort where thinking is mandatory (glm-5.3-flash defaults to max)', () => {
    expect(
      responderThinking(info({ supportsThinking: true, thinkingCanDisable: false, supportedThinkingEfforts: ['max', 'high', 'low'] }))
    ).toEqual({ enabled: true, effort: 'low', display: 'omitted' })
    expect(
      responderThinking(info({ supportsThinking: true, thinkingCanDisable: false, supportedThinkingEfforts: ['high', 'minimal'] }))
    ).toMatchObject({ effort: 'minimal' })
    expect(responderThinking(info({ supportsThinking: true, thinkingCanDisable: false }))).toMatchObject({ effort: 'low' })
  })
})

describe('the voice model call', () => {
  beforeEach(() => {
    resetResponderModelInfoForTests()
    streamChat.mockReset()
    resolveModelInfo.mockReset()
    streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'Hi.' }
      yield { type: 'done' }
    })
  })

  it('sends the model’s details and the effort it can run at', async () => {
    const glm = info({ id: 'z-ai/glm-5.3-flash', supportsThinking: true, thinkingCanDisable: false, supportedThinkingEfforts: ['low', 'high', 'max'] })
    resolveModelInfo.mockResolvedValue(glm)
    await drain(makeResponderChat()!)
    expect(streamChat).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'z-ai/glm-5.3-flash',
        modelInfo: glm,
        thinking: { enabled: true, effort: 'low', display: 'omitted' },
        routing: 'latency'
      })
    )
  })

  it('looks the model up once, not every turn', async () => {
    resolveModelInfo.mockResolvedValue(info({ supportsThinking: true, thinkingCanDisable: true }))
    await drain(makeResponderChat()!)
    await drain(makeResponderChat()!)
    expect(resolveModelInfo).toHaveBeenCalledTimes(1)
  })

  it('goes on without the details when the lookup fails, and tries again next turn', async () => {
    resolveModelInfo.mockRejectedValueOnce(new Error('catalog offline'))
    await drain(makeResponderChat()!)
    expect(streamChat.mock.calls[0]![0]).toMatchObject({ thinking: { enabled: false } })
    expect(streamChat.mock.calls[0]![0].modelInfo).toBeUndefined()
    resolveModelInfo.mockResolvedValue(info({ supportsThinking: false }))
    await drain(makeResponderChat()!)
    expect(resolveModelInfo).toHaveBeenCalledTimes(2)
  })

  it('doesn’t hold the turn for a slow catalog', async () => {
    vi.useFakeTimers()
    try {
      resolveModelInfo.mockReturnValue(new Promise(() => {}))
      const done = drain(makeResponderChat()!)
      await vi.advanceTimersByTimeAsync(1500)
      await done
      expect(streamChat.mock.calls[0]![0]).toMatchObject({ thinking: { enabled: false } })
    } finally {
      vi.useRealTimers()
    }
  })
})
