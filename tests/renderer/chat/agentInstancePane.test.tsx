/**
 * @vitest-environment jsdom
 */
import { useCallback, useState } from 'react'
import type { ReactElement } from 'react'
import { describe, expect, it } from 'vitest'
import { act, render, renderHook, waitFor } from '@testing-library/react'
import { AgentInstancePane } from '@renderer/features/chat/components/AgentInstancePane'
import { useControllerWriteCheckpoint } from '@renderer/features/chat/components/ChatStreamLeaves'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'

describe('AgentInstancePane controller reporting', () => {
  it('reports its controller via onControllerChange and null on unmount', () => {
    const reported: Array<ChatStreamController | null> = []
    const onControllerChange = (controller: ChatStreamController | null): void => {
      reported.push(controller)
    }
    const view = render(
      <AgentInstancePane
        workspacePath="/ws"
        instanceRunId="child-1"
        onControllerChange={onControllerChange}
        onClose={() => {}}
      />
    )
    expect(reported.length).toBeGreaterThan(0)
    expect(reported[0]).not.toBeNull()
    act(() => view.unmount())
    expect(reported[reported.length - 1]).toBeNull()
  })
})

type PaneProps = {
  workspacePath: string
  instanceRunId: string
  getController: (runId: string, workspacePath: string) => ChatStreamController | null
  onControllerChange: (controller: ChatStreamController | null) => void
}

function PaneUnderTest(props: PaneProps): ReactElement {
  return (
    <AgentInstancePane
      workspacePath={props.workspacePath}
      instanceRunId={props.instanceRunId}
      getController={props.getController}
      onControllerChange={props.onControllerChange}
      onClose={() => {}}
    />
  )
}

describe('AgentInstancePane controller identity churn', () => {
  it('does not report a new controller when getController churns identity per render', () => {
    // Emulates the ChatView parent: a child-effect report triggers a parent
    // setState re-render, and the WM map hands back a NEW live controller each
    // render. The pre-guard pane re-reported (and re-ran catch-up IPC) on every
    // identity flip — the React #185 cascade.
    const reported: Array<ChatStreamController | null> = []
    function ChurnHost(): ReactElement {
      const [, setTracked] = useState<ChatStreamController | null>(null)
      const getController = useCallback((runId: string, workspacePath: string) => {
        return createChatStreamController({ workspacePath, runId })
      }, [])
      const onControllerChange = useCallback((controller: ChatStreamController | null) => {
        reported.push(controller)
        setTracked(controller)
      }, [])
      return (
        <PaneUnderTest
          workspacePath="/ws"
          instanceRunId="churn-1"
          getController={getController}
          onControllerChange={onControllerChange}
        />
      )
    }

    const view = render(<ChurnHost />)
    // The pane reports its controller once for the mount, and the churny
    // getController must not re-arm the report loop.
    expect(reported.length).toBe(1)
    expect(reported[0]).not.toBeNull()

    act(() => view.rerender(<ChurnHost />))
    expect(reported.length).toBe(1)

    act(() => view.unmount())
    expect(reported[reported.length - 1]).toBeNull()
  })

  it('adopts a late-arriving shared controller once and disposes the pane-owned one', () => {
    const reported: Array<ChatStreamController | null> = []
    const onControllerChange = (controller: ChatStreamController | null): void => {
      reported.push(controller)
    }
    let shared: ChatStreamController | null = null
    const getController = (): ChatStreamController | null => shared

    const view = render(
      <PaneUnderTest
        workspacePath="/ws"
        instanceRunId="late-1"
        getController={getController}
        onControllerChange={onControllerChange}
      />
    )
    const owned = reported[0]!
    expect(owned).not.toBeNull()
    expect(owned.disposed).toBe(false)

    // The WM map gains a shared controller for this run mid-flight.
    shared = createChatStreamController({ workspacePath: '/ws', runId: 'late-1' })
    act(() => {
      view.rerender(
        <PaneUnderTest
          workspacePath="/ws"
          instanceRunId="late-1"
          getController={getController}
          onControllerChange={onControllerChange}
        />
      )
    })

    expect(reported.at(-1)).toBe(shared)
    expect(owned.disposed).toBe(true)
    act(() => view.unmount())
    expect(reported[reported.length - 1]).toBeNull()
    shared!.dispose()
  })

  it('falls back to a live pane-owned controller when the shared one is disposed', () => {
    const reported: Array<ChatStreamController | null> = []
    const onControllerChange = (controller: ChatStreamController | null): void => {
      reported.push(controller)
    }
    let live: ChatStreamController = createChatStreamController({
      workspacePath: '/ws',
      runId: 'gone-1'
    })
    const getController = (): ChatStreamController | null => live

    const view = render(
      <PaneUnderTest
        workspacePath="/ws"
        instanceRunId="gone-1"
        getController={getController}
        onControllerChange={onControllerChange}
      />
    )
    expect(reported[0]).toBe(live)

    // forgetRunRouting disposes before the map delete — the held controller is
    // dead, so the pane must fall back to its own live instance.
    act(() => {
      live.dispose()
    })
    act(() => {
      view.rerender(
        <PaneUnderTest
          workspacePath="/ws"
          instanceRunId="gone-1"
          getController={getController}
          onControllerChange={onControllerChange}
        />
      )
    })

    const fallback = reported.at(-1)!
    expect(fallback).not.toBeNull()
    expect(fallback).not.toBe(live)
    expect(fallback.disposed).toBe(false)
    act(() => view.unmount())
    expect(reported[reported.length - 1]).toBeNull()
    fallback.dispose()
  })
})

describe('useControllerWriteCheckpoint', () => {
  it('mirrors the controller writeCheckpoint on writes_checkpoint events', async () => {
    const controller = createChatStreamController({ workspacePath: '/ws', runId: 'child-2' })
    const { result } = renderHook(() => useControllerWriteCheckpoint(controller))
    expect(result.current).toBeNull()

    act(() => {
      controller.handleEvent({
        type: 'writes_checkpoint',
        runId: 'child-2',
        checkpointId: 'cp-1',
        files: [{ path: 'src/new.ts', action: 'created', undoable: true }]
      })
    })
    await waitFor(() => expect(result.current?.checkpointId).toBe('cp-1'))
    expect(result.current?.files.map((f) => f.path)).toEqual(['src/new.ts'])

    controller.dispose()
  })
})
