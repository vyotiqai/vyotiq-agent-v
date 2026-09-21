/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  resetAgentProfilesStoreForTests,
  useAgentProfiles
} from '@renderer/lib/hooks/useAgentProfiles'
import type { AgentProfile } from '@shared/ipc'

/**
 * The roster is read by three surfaces at once (sidebar, composer picker, App
 * pane routing). These tests pin the property that makes that safe: they all
 * read ONE store, so no surface can show a teammate another has already lost.
 */

function profile(id: string, name: string): AgentProfile {
  return {
    id,
    name,
    persona: '',
    identity: '',
    tone: '',
    autoResumeOnLaunch: false,
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z'
  }
}

let pushHandler: ((event: { profiles: AgentProfile[] }) => void) | null = null
let listCalls = 0

beforeEach(() => {
  resetAgentProfilesStoreForTests()
  pushHandler = null
  listCalls = 0
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentProfilesList: vi.fn(async () => {
      listCalls += 1
      return { ok: true as const, data: [profile('scout', 'Scout')] }
    }),
    agentProfilesCreate: vi.fn(async (request: { name: string }) => ({
      ok: true as const,
      data: profile('newbie', request.name)
    })),
    agentProfilesDelete: vi.fn(async () => ({
      ok: true as const,
      data: { deleted: true as const, cancelledTasks: 0, cancelledRuns: 0, warnings: [] }
    })),
    onAgentProfilesChanged: vi.fn((handler: (event: { profiles: AgentProfile[] }) => void) => {
      pushHandler = handler
      return () => {
        pushHandler = null
      }
    })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('useAgentProfiles shared store', () => {
  it('loads the roster once no matter how many surfaces read it', async () => {
    const a = renderHook(() => useAgentProfiles())
    const b = renderHook(() => useAgentProfiles())
    const c = renderHook(() => useAgentProfiles())

    await waitFor(() => expect(a.result.current.ready).toBe(true))
    // Three independent useState copies meant three IPC loads and three push
    // subscriptions for one small list.
    expect(listCalls).toBe(1)
    expect(window.vyotiq.onAgentProfilesChanged).toHaveBeenCalledTimes(1)
    for (const hook of [a, b, c]) {
      expect(hook.result.current.profiles.map((p) => p.name)).toEqual(['Scout'])
    }
  })

  it('shows a mutation made through one surface to every other surface', async () => {
    const sidebar = renderHook(() => useAgentProfiles())
    const picker = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(sidebar.result.current.ready).toBe(true))

    // The composer picker can create a teammate. Before consolidation its
    // optimistic update landed only in its own copy, so until the push arrived
    // the sidebar did not know the teammate existed.
    await act(async () => {
      await picker.result.current.createProfile({ name: 'Newbie', scope: 'global' })
    })

    expect(sidebar.result.current.profiles.map((p) => p.name)).toEqual(['Scout', 'Newbie'])
    expect(picker.result.current.profiles).toBe(sidebar.result.current.profiles)
  })

  it('applies a push to every subscriber', async () => {
    const a = renderHook(() => useAgentProfiles())
    const b = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(a.result.current.ready).toBe(true))

    act(() => pushHandler?.({ profiles: [profile('ace', 'Ace')] }))

    expect(a.result.current.profiles.map((p) => p.name)).toEqual(['Ace'])
    expect(b.result.current.profiles.map((p) => p.name)).toEqual(['Ace'])
  })

  it('surfaces a partial-delete warning where the roster is actually shown', async () => {
    window.vyotiq.agentProfilesDelete = vi.fn(async () => ({
      ok: true as const,
      data: {
        deleted: true as const,
        cancelledTasks: 1,
        cancelledRuns: 0,
        warnings: ['Could not remove override in /ws-a']
      }
    }))
    const sidebar = renderHook(() => useAgentProfiles())
    const picker = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(sidebar.result.current.ready).toBe(true))

    // Deleting from the picker must not hide the warning from the sidebar:
    // the row disappears either way, so a warning only the caller can see is
    // a warning nobody reads.
    await act(async () => {
      await picker.result.current.deleteProfile('scout')
    })

    expect(sidebar.result.current.error).toBe('Could not remove override in /ws-a')
    expect(sidebar.result.current.profiles).toEqual([])
  })

  it('clears a warning once it has been read', async () => {
    const hook = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(hook.result.current.ready).toBe(true))
    window.vyotiq.agentProfilesDelete = vi.fn(async () => ({
      ok: false as const,
      error: 'Teammate is running'
    }))

    await act(async () => {
      await hook.result.current.deleteProfile('scout')
    })
    expect(hook.result.current.error).toBe('Teammate is running')

    act(() => hook.result.current.clearError())
    expect(hook.result.current.error).toBeNull()
  })

  it('retries the load if the preload bridge was not there yet', async () => {
    // Latching "started" with no bridge to call would leave the roster empty
    // for the rest of the session rather than for one render.
    const bridge = window.vyotiq
    // @ts-expect-error test bridge
    window.vyotiq = undefined
    const early = renderHook(() => useAgentProfiles())
    expect(early.result.current.ready).toBe(false)
    expect(listCalls).toBe(0)
    early.unmount()

    window.vyotiq = bridge
    const later = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(later.result.current.ready).toBe(true))
    expect(later.result.current.profiles.map((p) => p.name)).toEqual(['Scout'])
  })

  it('keeps receiving pushes after one subscriber unmounts', async () => {
    const staying = renderHook(() => useAgentProfiles())
    const leaving = renderHook(() => useAgentProfiles())
    await waitFor(() => expect(staying.result.current.ready).toBe(true))

    leaving.unmount()
    act(() => pushHandler?.({ profiles: [profile('ace', 'Ace')] }))

    // The push subscription is app-lifetime on purpose: tearing it down with
    // the last unmount would leave the next mount silently stale.
    expect(staying.result.current.profiles.map((p) => p.name)).toEqual(['Ace'])
  })
})
