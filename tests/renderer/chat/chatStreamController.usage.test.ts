/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'
import { parseDiffPreview, parseEditCardData } from '@renderer/features/chat/toolUi'

async function flushStreamPatches(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 150))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
}

describe('createChatStreamController', () => {
  it('hydrates per-turn usage and starts a new slot on follow_up_applied', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript(
      [
        { role: 'user', content: 'one', at: '2026-08-18T10:00:00.000Z' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'two', at: '2026-08-18T10:01:00.000Z' }
      ],
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10,
            billedCost: 0.01
          }
        },
        {
          at: '2026-08-18T10:01:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 2,
            inputTokens: 80,
            outputTokens: 8
          }
        }
      ]
    )
    expect(controller.turnUsage).toHaveLength(2)
    expect(controller.turnUsage[0]?.billedInputTokens).toBe(100)
    expect(controller.turnUsage[0]?.stepsWithCostReport).toBe(1)
    expect(controller.turnUsage[1]?.billedInputTokens).toBe(80)
    expect(controller.turnUsage[1]?.stepsWithCostReport).toBe(0)

    controller.handleEvent({
      type: 'follow_up_applied',
      runId: 'r1',
      ids: ['fu-1'],
      messages: [{ role: 'user', content: 'three', at: '2026-08-18T10:02:00.000Z' }]
    })
    expect(controller.turnUsage).toHaveLength(3)

    controller.handleEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 3,
      inputTokens: 15,
      outputTokens: 1
    })
    expect(controller.turnUsage[2]?.billedInputTokens).toBe(15)
    expect(controller.turnUsage[1]?.billedInputTokens).toBe(80)
  })

  it('does not render a synthetic protocol turn from follow_up_applied', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript([{ role: 'user', content: 'one' }], [])
    expect(controller.items.some((i) => i.kind === 'message' && i.role === 'user')).toBe(true)

    controller.handleEvent({
      type: 'follow_up_applied',
      runId: 'r1',
      ids: ['fu-goal'],
      messages: [
        {
          role: 'user',
          content: '[Goal continue] Continue the active goal until it is complete.',
          synthetic: true
        }
      ]
    })
    // The protocol turn joins model history but never renders as a user bubble.
    expect(
      controller.items.some(
        (i) => i.kind === 'message' && String(i.content).includes('Goal continue')
      )
    ).toBe(false)
    expect(controller.messages.some((m) => String(m.content).includes('Goal continue'))).toBe(true)
  })

  it('keeps hydrated run step totals when a later step_usage arrives', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    controller.hydrateTranscript(
      [
        { role: 'user', content: 'one', at: '2026-08-18T10:00:00.000Z' },
        { role: 'assistant', content: 'a1' }
      ],
      [
        {
          at: '2026-08-18T10:00:05.000Z',
          event: {
            type: 'step_usage',
            runId: 'r1',
            step: 1,
            inputTokens: 100,
            outputTokens: 10
          }
        }
      ]
    )
    expect(controller.getContextUsage()?.stepUsage.billedInputTokens ?? 0).toBe(0)

    controller.handleEvent({
      type: 'step_usage',
      runId: 'r1',
      step: 2,
      inputTokens: 15,
      outputTokens: 1
    })
    expect(controller.turnUsage[0]?.billedInputTokens).toBe(115)
    expect(controller.getContextUsage()?.stepUsage.billedInputTokens).toBe(115)
  })
})
