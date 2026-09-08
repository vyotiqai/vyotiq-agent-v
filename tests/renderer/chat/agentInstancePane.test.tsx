/**
 * @vitest-environment jsdom
 */
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
