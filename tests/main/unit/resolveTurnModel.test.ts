import { describe, expect, it } from 'vitest'
import { resolveTurnModel } from '@main/agent/loop'

const fallback = { provider: 'openai' as const, model: 'gpt-default' }

describe('resolveTurnModel', () => {
  it('runs a renderer turn on the model its session sent, over the run memory', () => {
    // A model switched mid-chat must take effect; with teammate pins gone
    // nothing outranks the session's own selection.
    expect(
      resolveTurnModel({
        requested: { provider: 'anthropic', model: 'switched' },
        recalled: { provider: 'openai', model: 'first-turn' },
        fallback
      })
    ).toEqual({ provider: 'anthropic', model: 'switched' })
  })

  it('recalls the run selection for a main-originated invoke that sends none', () => {
    expect(
      resolveTurnModel({
        requested: { provider: undefined, model: undefined },
        recalled: { provider: 'anthropic', model: 'first-turn' },
        fallback
      })
    ).toEqual({ provider: 'anthropic', model: 'first-turn' })
  })

  it('falls back to the workspace/global chain when neither is known', () => {
    expect(resolveTurnModel({ requested: {}, recalled: null, fallback })).toEqual(fallback)
  })
})
