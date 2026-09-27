/**
 * @vitest-environment jsdom
 */
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { act, render, waitFor, type RenderResult } from '@testing-library/react'
import { AgentInstancePane } from '@renderer/features/chat/components/AgentInstancePane'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'

/** Every controller made in this file, the pane's own included, in creation order. */
const created = vi.hoisted(() => [] as ChatStreamController[])
vi.mock('@renderer/lib/hooks/createChatStreamController', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/lib/hooks/createChatStreamController')>()
  return {
    ...actual,
    createChatStreamController: (...args: Parameters<typeof actual.createChatStreamController>) => {
      const controller = actual.createChatStreamController(...args)
      created.push(controller)
      return controller
    }
  }
})

type PaneProps = {
  workspacePath: string
  instanceRunId: string
  getController: (runId: string, workspacePath: string) => ChatStreamController | null
}

function PaneUnderTest(props: PaneProps): ReactElement {
  return (
    <AgentInstancePane
      workspacePath={props.workspacePath}
      instanceRunId={props.instanceRunId}
      getController={props.getController}
      onClose={() => {}}
    />
  )
}

function usageEvent(runId: string, step: number, tokens: number) {
  return {
    type: 'context_usage' as const,
    runId,
    step,
    estimatedTokens: tokens,
    inputTokens: tokens,
    contextWindow: 128_000,
    contentWindow: 85_000,
    compactionTrigger: 80_000,
    source: 'estimate' as const,
    layers: { system: 0, history: 0, tools: 0, buffer: 0 }
  }
}

/** The pane header's context meter — it reads whichever controller the pane holds. */
function meterLabel(view: RenderResult): string | null {
  return view.queryByRole('button', { name: /Context window/ })?.getAttribute('aria-label') ?? null
}

describe('AgentInstancePane controller identity churn', () => {
  it('keeps the first live controller when getController churns identity per render', async () => {
    // The WM map can hand back a NEW live controller each render. The pre-guard
    // pane adopted every identity flip and re-ran its catch-up IPC each time —
    // the React #185 cascade.
    const handed: ChatStreamController[] = []
    const getController = (runId: string, workspacePath: string): ChatStreamController => {
      const controller = createChatStreamController({ workspacePath, runId })
      handed.push(controller)
      return controller
    }

    const view = render(
      <PaneUnderTest workspacePath="/ws" instanceRunId="churn-1" getController={getController} />
    )
    act(() =>
      view.rerender(
        <PaneUnderTest workspacePath="/ws" instanceRunId="churn-1" getController={getController} />
      )
    )
    expect(handed.length).toBeGreaterThan(1)

    // A later flip is not the one on screen …
    act(() => handed.at(-1)!.handleEvent(usageEvent('churn-1', 1, 90_000)))
    expect(meterLabel(view)).toBeNull()
    // … the first one handed over still is.
    act(() => handed[0]!.handleEvent(usageEvent('churn-1', 1, 90_000)))
    await waitFor(() => expect(meterLabel(view)).toMatch(/^Context window \d+% full/))

    act(() => view.unmount())
    for (const controller of handed) controller.dispose()
  })

  it('adopts a late-arriving shared controller once and disposes the pane-owned one', async () => {
    created.length = 0
    let shared: ChatStreamController | null = null
    const getController = (): ChatStreamController | null => shared

    const view = render(
      <PaneUnderTest workspacePath="/ws" instanceRunId="late-1" getController={getController} />
    )
    // Nothing shared yet: the pane made its own.
    expect(created).toHaveLength(1)
    const owned = created[0]!
    expect(owned.disposed).toBe(false)

    // The WM map gains a shared controller for this run mid-flight.
    shared = createChatStreamController({ workspacePath: '/ws', runId: 'late-1' })
    act(() => {
      view.rerender(
        <PaneUnderTest workspacePath="/ws" instanceRunId="late-1" getController={getController} />
      )
    })

    expect(owned.disposed).toBe(true)
    act(() => shared!.handleEvent(usageEvent('late-1', 1, 90_000)))
    await waitFor(() => expect(meterLabel(view)).toMatch(/^Context window \d+% full/))
    act(() => view.unmount())
    shared.dispose()
  })

  it('falls back to a live pane-owned controller when the shared one is disposed', () => {
    created.length = 0
    const live: ChatStreamController = createChatStreamController({
      workspacePath: '/ws',
      runId: 'gone-1'
    })
    const getController = (): ChatStreamController | null => live

    const view = render(
      <PaneUnderTest workspacePath="/ws" instanceRunId="gone-1" getController={getController} />
    )
    // The shared controller is live, so the pane made none of its own.
    expect(created).toEqual([live])

    // forgetRunRouting disposes before the map delete — the held controller is
    // dead, so the pane must fall back to its own live instance.
    act(() => {
      live.dispose()
    })
    act(() => {
      view.rerender(
        <PaneUnderTest workspacePath="/ws" instanceRunId="gone-1" getController={getController} />
      )
    })

    const fallback = created.at(-1)!
    expect(fallback).not.toBe(live)
    expect(fallback.disposed).toBe(false)
    act(() => view.unmount())
    // The pane owns the fallback, so it goes with the pane.
    expect(fallback.disposed).toBe(true)
  })
})

describe('AgentInstancePane context meter', () => {
  it('renders the run context meter once usage arrives and updates live', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'meter-1' })
    const getController = (): ChatStreamController | null => controller

    const view = render(
      <PaneUnderTest workspacePath="/ws" instanceRunId="meter-1" getController={getController} />
    )
    // Before the first usage event the meter renders nothing — ContextMeter
    // returns null for a missing usage state, and must not crash the header.
    expect(view.queryByRole('button', { name: /Context window/ })).toBeNull()

    act(() => {
      controller.handleEvent({
        type: 'context_usage',
        runId: 'meter-1',
        step: 1,
        estimatedTokens: 90_000,
        inputTokens: 90_000,
        contextWindow: 128_000,
        contentWindow: 85_000,
        compactionTrigger: 80_000,
        source: 'estimate',
        layers: { system: 0, history: 0, tools: 0, buffer: 0 }
      })
    })
    // The pane header renders the live usage meter.
    await waitFor(() =>
      expect(view.getByRole('button', { name: /Context window/ }).getAttribute('aria-label')).toMatch(
        /^Context window \d+% full/
      )
    )
    const firstLabel = view.getByRole('button', { name: /Context window/ }).getAttribute('aria-label')

    // A later usage event updates the meter in place.
    act(() => {
      controller.handleEvent({
        type: 'context_usage',
        runId: 'meter-1',
        step: 2,
        estimatedTokens: 120_000,
        inputTokens: 120_000,
        contextWindow: 128_000,
        contentWindow: 85_000,
        compactionTrigger: 80_000,
        source: 'estimate',
        layers: { system: 0, history: 0, tools: 0, buffer: 0 }
      })
    })
    await waitFor(() =>
      expect(view.getByRole('button', { name: /Context window/ }).getAttribute('aria-label')).not.toBe(
        firstLabel
      )
    )

    act(() => view.unmount())
    controller.dispose()
  })
})
