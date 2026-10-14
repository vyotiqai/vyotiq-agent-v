import { describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@shared/logger', async (importOriginal) => {
  const real = await importOriginal<typeof import('@shared/logger')>()
  return { ...real, logger: { ...real.logger, warn } }
})

import { voiceEventPasses } from '@main/voice/sessions'
import type { VoiceEvent } from '@shared/ipc/schemas/voice'

describe('voice events the window would drop (A-18)', () => {
  it('passes a valid event without logging', () => {
    expect(voiceEventPasses({ sessionId: 's1', kind: 'reconnecting', attempt: 1 })).toBe(true)
    expect(warn).not.toHaveBeenCalled()
  })

  it('logs one that fails its schema, with where it failed, and holds it back', () => {
    const bad = { sessionId: 's1', kind: 'reconnecting', attempt: 1.5 } as unknown as VoiceEvent
    expect(voiceEventPasses(bad)).toBe(false)
    expect(warn).toHaveBeenCalledWith(
      'Voice event failed its schema',
      expect.objectContaining({ scope: 'voice', kind: 'reconnecting', reason: expect.stringContaining('attempt') })
    )
  })
})
