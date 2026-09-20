/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentProfile, AgentProfileOverride } from '@shared/ipc'

const pushToastMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))

import { TeammateOverrides } from '@renderer/features/teammates/TeammateOverrides'
import { resetWorkspaceProfileOverridesForTests } from '@renderer/lib/hooks/useWorkspaceProfileOverrides'

/**
 * Per-workspace overrides. `resolveAgentProfile` has merged this file into
 * every run for a long time; nothing in the app could write one.
 */

const profile: AgentProfile = {
  id: 'scout',
  name: 'Scout',
  scope: 'global',
  persona: 'Global persona.',
  tone: 'Global tone.',
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T00:00:00.000Z'
} as AgentProfile

let stored: Record<string, Record<string, AgentProfileOverride>> = {}
let writes: { workspacePath: string; profileId: string; override: AgentProfileOverride | null }[] =
  []

function renderOverrides(): ReturnType<typeof render> {
  return render(
    <TeammateOverrides
      profile={profile}
      openWorkspaces={['/ws-a', '/ws-b']}
      secrets={{ openai: true } as never}
    />
  )
}

beforeEach(() => {
  resetWorkspaceProfileOverridesForTests()
  stored = { '/ws-a': {}, '/ws-b': {} }
  writes = []
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentProfileOverridesList: vi.fn(async ({ workspacePath }: { workspacePath: string }) => ({
      ok: true as const,
      data: { workspacePath, overrides: stored[workspacePath] ?? {} }
    })),
    agentProfileOverrideSet: vi.fn(async (req: (typeof writes)[number]) => {
      writes.push(req)
      return { ok: true as const, data: req.override }
    }),
    onAgentProfileOverridesChanged: vi.fn(() => () => {}),
    listModels: vi.fn(async () => ({ ok: true as const, data: { models: [] } }))
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('workspace overrides', () => {
  it('lists every open workspace and says which ones differ', async () => {
    stored['/ws-b'] = { scout: { tone: 'Workspace tone.' } }
    renderOverrides()

    await waitFor(() => expect(screen.getByText('1 field overridden')).toBeTruthy())
    expect(screen.getByLabelText('Edit override for ws-a').textContent).toBe('Add override')
    expect(screen.getByLabelText('Edit override for ws-b').textContent).toBe('Edit')
  })

  it('seeds a newly switched-on field from the global value', async () => {
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Edit override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))

    fireEvent.click(screen.getByLabelText('Override Tone'))

    // Switching an override on must not silently blank the field for that
    // workspace — it starts from what the teammate already does.
    expect((screen.getByLabelText('Tone override') as HTMLInputElement).value).toBe('Global tone.')
  })

  it('writes only the fields that were switched on', async () => {
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Edit override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByLabelText('Override Tone'))
    fireEvent.change(screen.getByLabelText('Tone override'), {
      target: { value: 'Terse here.' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0]).toEqual({
      workspacePath: '/ws-a',
      profileId: 'scout',
      override: { tone: 'Terse here.' }
    })
  })

  it('preserves a field the form does not edit', async () => {
    // The write REPLACES the file. A hand-authored `avatar` that this form has
    // no control for must survive a save, or editing the tone silently
    // destroys part of a file someone committed.
    stored['/ws-a'] = { scout: { avatar: 'sparkles', tone: 'Old tone.' } }
    renderOverrides()
    await waitFor(() => expect(screen.getByText('2 fields overridden')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.change(screen.getByLabelText('Tone override'), { target: { value: 'New tone.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].override).toEqual({ avatar: 'sparkles', tone: 'New tone.' })
  })

  it('switching a field off drops it from the written override', async () => {
    stored['/ws-a'] = { scout: { tone: 'Old tone.', persona: 'Old persona.' } }
    renderOverrides()
    await waitFor(() => expect(screen.getByText('2 fields overridden')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByLabelText('Override Persona'))
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].override).toEqual({ tone: 'Old tone.' })
  })

  it('clearing every field removes the file rather than writing an empty one', async () => {
    stored['/ws-a'] = { scout: { tone: 'Old tone.' } }
    renderOverrides()
    await waitFor(() => expect(screen.getByText('1 field overridden')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByLabelText('Override Tone'))
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].override).toBeNull()
  })

  it('removes the whole override in one action', async () => {
    stored['/ws-a'] = { scout: { tone: 'Old tone.', persona: 'Old persona.' } }
    renderOverrides()
    await waitFor(() => expect(screen.getByText('2 fields overridden')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByRole('button', { name: 'Remove override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    expect(writes[0].override).toBeNull()
    expect(pushToastMock).toHaveBeenCalledWith('Override cleared for ws-a')
  })

  it('surfaces a refusal from main instead of claiming success', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.agentProfileOverrideSet = vi.fn(async () => ({
      ok: false as const,
      error: 'Workspace is not open'
    }))
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Edit override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByLabelText('Override Tone'))
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() =>
      expect(pushToastMock).not.toHaveBeenCalledWith(expect.stringContaining('Override saved'))
    )
    // The dialog stays open so the edit is not lost with the failure.
    expect(within(screen.getByRole('dialog')).getByLabelText('Override Tone')).toBeTruthy()
  })
})
