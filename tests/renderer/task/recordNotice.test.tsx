/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { PersistedEvent } from '@shared/ipc'
import { applyNoticeItems, type UiItem } from '@shared/transcript'
import { buildRecordModel } from '@renderer/features/task/recordModel'
import { WorkItemView } from '@renderer/features/task/record/WorkItems'
import { createChatStreamController } from '@renderer/lib/hooks/createChatStreamController'

afterEach(cleanup)

const T0 = Date.parse('2026-10-02T10:00:00.000Z')
const at = (s: number): string => new Date(T0 + s * 1000).toISOString()

const SWITCH = 'Switched to gpt-5.6-luna — Anthropic unavailable (HTTP 529)'

function fallbackEvent(s: number): PersistedEvent {
  return {
    at: at(s),
    event: {
      type: 'model_fallback',
      runId: 'r1',
      step: 1,
      provider: 'openai',
      model: 'gpt-5.6-luna',
      fromProvider: 'anthropic',
      fromModel: 'claude-sonnet-4-6',
      reason: 'HTTP 529',
      message: SWITCH
    }
  } as PersistedEvent
}

const items: UiItem[] = [
  { kind: 'message', id: 'u1', role: 'user', content: 'Fix the test', at: at(0) },
  { kind: 'message', id: 'a1', role: 'assistant', content: 'Fixed: the watcher closes first.', at: at(30) }
]

describe('model fallback notes in the record', () => {
  it('weaves the note in by time on reload and replaces a live one', () => {
    const live: UiItem = { kind: 'notice', id: 'notice:live:7:1', text: SWITCH, at: at(31) }
    const woven = applyNoticeItems([...items, live], [fallbackEvent(10)])
    expect(woven.map((i) => i.kind)).toEqual(['message', 'notice', 'message'])
    expect(woven.filter((i) => i.kind === 'notice')).toHaveLength(1)
  })

  it('is a quiet line in the run, and the answer after it is still the result', () => {
    const woven = applyNoticeItems(items, [fallbackEvent(10)])
    const [run] = buildRecordModel(woven, { running: false }).runs
    const work = [...run!.setup, ...run!.steps.flatMap((s) => s.work), ...run!.after]
    expect(work.some((w) => w.kind === 'notice')).toBe(true)
    expect(run!.result?.text).toBe('Fixed: the watcher closes first.')
  })

  it('reads as what happened, then why', () => {
    render(<WorkItemView item={{ kind: 'notice', id: 'n1', item: { kind: 'notice', id: 'n1', text: SWITCH, at: at(10) } }} />)
    expect(screen.getByText('Switched to gpt-5.6-luna').className).toContain('text-fg')
    expect(screen.getByText('Anthropic unavailable (HTTP 529)').className).toContain('text-muted')
  })

  it('shows the note live, and a reload rebuilds it from events', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    const ev = fallbackEvent(10).event as Parameters<typeof controller.handleEvent>[0]
    controller.handleEvent(ev)
    expect(controller.items.filter((i) => i.kind === 'notice').map((i) => (i.kind === 'notice' ? i.text : ''))).toEqual([
      SWITCH
    ])

    const reloaded = createChatStreamController({ workspacePath: '/ws', runId: 'r1' })
    reloaded.hydrateTranscript(
      [
        { role: 'user', content: 'Fix the test', at: at(0) },
        { role: 'assistant', content: 'Fixed.', at: at(30) }
      ],
      [fallbackEvent(10)]
    )
    expect(reloaded.items.map((i) => i.kind)).toEqual(['message', 'notice', 'message'])
  })
})
