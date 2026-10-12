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

describe('AgentInstancePane goal', () => {
  it('reads the parent’s goal as a reply at the brief’s size, not as raw markdown', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'goal-1' })
    const view = render(
      <AgentInstancePane
        workspacePath="/ws"
        instanceRunId="goal-1"
        instanceMeta={{ instanceRunId: 'goal-1', phase: 'started', goal: 'Fix the **flaky** checkout in `src/a.ts`.' }}
        getController={() => controller}
        onClose={() => {}}
      />
    )
    const goal = view.container.querySelector('[data-reply]')!
    expect(goal.getAttribute('data-size')).toBe('md')
    expect(goal.getAttribute('data-tone')).toBe('strong')
    expect(goal.querySelector('strong')!.textContent).toBe('flaky')
    expect(goal.textContent).not.toContain('**')
  })
})

describe('AgentInstancePane header', () => {
  const ids = ['a1111111', 'b2222222', 'c3333333', 'd4444444', 'e5555555', 'f6666666', 'g7777777'].map(
    (head) => `${head}-0000-4000-8000-000000000000`
  )
  const siblings = Object.fromEntries(
    ids.map((id, i) => [id, { instanceRunId: id, phase: 'started' as const, stepTitle: `Map area ${i + 1}` }])
  )

  function renderHeader(): RenderResult {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: ids[3]! })
    return render(
      <AgentInstancePane
        workspacePath="/ws"
        instanceRunId={ids[3]!}
        instanceMeta={siblings[ids[3]!]}
        siblings={siblings}
        onOpenInstance={() => {}}
        getController={() => controller}
        onClose={() => {}}
      />
    )
  }

  it('gives the title its width and lets the sibling chips take what is left', () => {
    const view = renderHeader()
    const header = view.container.querySelector('[data-instance-header]')!
    expect(header.querySelector('h1')!.textContent).toBe('Map area 4')
    const strip = header.querySelector<HTMLElement>('[data-instance-siblings]')!
    // flex-basis 0: the chips grow into spare room and never squeeze the title.
    expect(strip.classList.contains('basis-0')).toBe(true)
    expect(strip.classList.contains('flex-1')).toBe(true)
    expect(strip.classList.contains('overflow-x-auto')).toBe(true)
    expect(strip.classList.contains('min-w-14')).toBe(true)
    const chips = view.getAllByRole('group', { name: 'Instances of this task' })[0]!.querySelectorAll('button')
    expect(chips).toHaveLength(7)
    expect(chips[3]!.getAttribute('aria-current')).toBe('page')
    // The current chip says the id; the header does not say it again.
    expect(header.querySelector('[title="Instance id"]')).toBeNull()
  })

  it('fades the edge that hides chips', () => {
    const proto = HTMLDivElement.prototype
    const scrollWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollWidth')
    const clientWidth = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')
    Object.defineProperty(proto, 'scrollWidth', { configurable: true, get: () => 400 })
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get: () => 100 })
    try {
      const view = renderHeader()
      const strip = view.container.querySelector<HTMLElement>('[data-instance-siblings]')!
      expect(strip.classList.contains('mask-fade-end')).toBe(true)
      expect(strip.classList.contains('mask-fade-x')).toBe(false)
    } finally {
      delete (proto as unknown as Record<string, unknown>).scrollWidth
      delete (proto as unknown as Record<string, unknown>).clientWidth
      if (scrollWidth) Object.defineProperty(Element.prototype, 'scrollWidth', scrollWidth)
      if (clientWidth) Object.defineProperty(Element.prototype, 'clientWidth', clientWidth)
    }
  })

  it('keeps no chip strip floor for a lone instance', () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: ids[0]! })
    const view = render(
      <AgentInstancePane
        workspacePath="/ws"
        instanceRunId={ids[0]!}
        instanceMeta={siblings[ids[0]!]}
        getController={() => controller}
        onClose={() => {}}
      />
    )
    const strip = view.container.querySelector<HTMLElement>('[data-instance-siblings]')!
    expect(strip.classList.contains('min-w-0')).toBe(true)
    expect(strip.querySelector('button')).toBeNull()
    expect(view.container.querySelector('[title="Instance id"]')!.textContent).toBe('a1111111')
  })
})

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
