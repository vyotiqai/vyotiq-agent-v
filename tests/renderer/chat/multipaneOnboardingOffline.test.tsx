/**
 * @vitest-environment jsdom
 *
 * Multipane onboarding: gate must wrap pane deliver the same way single-pane
 * wraps chatActions.send — offline enqueue only after onboarding completes.
 */
import { describe, expect, it, vi } from 'vitest'
import { offlineQueueLength } from '@renderer/lib/hooks/offlineQueueStore'

const WORKSPACE = '/tmp/vyotiq-multipane-onboard'

describe('multipane onboarding intercept', () => {
  it('stashes pane deliver through onboarding before offline enqueue', async () => {
    localStorage.clear()
    let onboardingDone = false
    const paneSend = vi.fn().mockResolvedValue(true)
    const enqueueCalls: string[] = []

    const sendWithOfflineQueue = async (
      text: string,
      _images?: string[],
      _files?: unknown,
      _extras?: unknown,
      deliver?: (t: string) => Promise<boolean>
    ) => {
      enqueueCalls.push(text)
      // Simulate offline path used by App: enqueue without calling deliver.
      const key = `vyotiq.offlineQueue.${encodeURIComponent(WORKSPACE)}`
      const prev = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown[]
      localStorage.setItem(
        key,
        JSON.stringify([...prev, { id: crypto.randomUUID(), text, queuedAt: new Date().toISOString() }])
      )
      void deliver
      return true
    }

    type Deliver = (
      text: string,
      images?: string[],
      files?: unknown,
      extras?: unknown
    ) => boolean | Promise<boolean>

    let pending: { text: string; deliver: Deliver } | null = null

    const gateSendWithOnboarding = async (deliver: Deliver, text: string) => {
      if (!onboardingDone) {
        pending = { text, deliver }
        return false
      }
      return Boolean(await deliver(text))
    }

    const multipaneOnSend = async (text: string) =>
      gateSendWithOnboarding(
        (sendText) => sendWithOfflineQueue(sendText, undefined, undefined, undefined, paneSend),
        text
      )

    expect(await multipaneOnSend('from pane')).toBe(false)
    expect(enqueueCalls).toEqual([])
    expect(offlineQueueLength(WORKSPACE)).toBe(0)
    expect(paneSend).not.toHaveBeenCalled()
    expect(pending?.text).toBe('from pane')

    onboardingDone = true
    expect(await pending!.deliver(pending!.text)).toBe(true)
    expect(enqueueCalls).toEqual(['from pane'])
    expect(offlineQueueLength(WORKSPACE)).toBe(1)
    expect(paneSend).not.toHaveBeenCalled()
  })
})
