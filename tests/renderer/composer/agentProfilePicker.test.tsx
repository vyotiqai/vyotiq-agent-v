/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { AgentProfile } from '@shared/ipc'

const pushToastMock = vi.hoisted(() => vi.fn())
vi.mock('@renderer/lib/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@renderer/lib/ui')>()),
  pushToast: pushToastMock
}))

import { AgentProfilePicker } from '@renderer/features/chat/components/composer/AgentProfilePicker'
import { resetAgentProfilesStoreForTests } from '@renderer/lib/hooks/useAgentProfiles'

/**
 * The composer pill offers teammates for binding, so it is the surface where
 * an unusable teammate does the most damage: main refuses to resolve a
 * workspace-scoped profile outside its workspace, and the whole send fails.
 */

function profile(patch: Partial<AgentProfile> = {}): AgentProfile {
  return {
    id: 'scout',
    name: 'Scout',
    scope: 'global',
    createdAt: '2026-09-18T00:00:00.000Z',
    updatedAt: '2026-09-18T00:00:00.000Z',
    ...patch
  } as AgentProfile
}

let roster: AgentProfile[] = []
let deleted: string[] = []

function renderPicker(
  props: Partial<React.ComponentProps<typeof AgentProfilePicker>> = {}
): ReturnType<typeof render> {
  return render(
    <AgentProfilePicker
      profileId={null}
      onProfileChange={vi.fn()}
      workspacePath="/ws-a"
      {...props}
    />
  )
}

beforeEach(() => {
  resetAgentProfilesStoreForTests()
  roster = []
  deleted = []
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentProfilesList: vi.fn(async () => ({ ok: true as const, data: roster })),
    onAgentProfilesChanged: vi.fn(() => () => {}),
    agentProfilesCreate: vi.fn(async (req: { name: string }) => ({
      ok: true as const,
      data: profile({ id: 'newbie', name: req.name })
    })),
    agentProfilesDelete: vi.fn(async (req: { id: string }) => {
      deleted.push(req.id)
      return {
        ok: true as const,
        data: { deleted: true as const, cancelledTasks: 0, cancelledRuns: 0, warnings: [] }
      }
    })
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openMenu(): Promise<HTMLElement> {
  fireEvent.click(screen.getByRole('button', { name: 'Teammate' }))
  return screen.findByRole('listbox', { name: 'Teammate' })
}

describe('AgentProfilePicker scope gating', () => {
  it('does not offer a teammate that cannot run in this workspace', async () => {
    // Binding it would fail the whole send with `Unknown agent profile` — about
    // a teammate this menu had just offered.
    roster = [profile(), profile({ id: 'ace', name: 'Ace', scope: 'workspace', workspacePath: '/ws-b' })]
    renderPicker({ workspacePath: '/ws-a' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teammate' })).toBeTruthy())

    const listbox = await openMenu()
    expect(within(listbox).getByRole('option', { name: 'Scout' })).toBeTruthy()
    expect(within(listbox).queryByRole('option', { name: 'Ace' })).toBeNull()
  })

  it('offers a workspace teammate inside its own workspace', async () => {
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-a' })]
    renderPicker({ workspacePath: '/ws-a' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teammate' })).toBeTruthy())

    const listbox = await openMenu()
    expect(within(listbox).getByRole('option', { name: 'Scout' })).toBeTruthy()
  })

  it('keeps a bound teammate visible even after it stops being usable here', async () => {
    // The run is still bound to it. Dropping it from the menu would make the
    // pill read as unbound while the chat is not.
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-b' })]
    renderPicker({ workspacePath: '/ws-a', profileId: 'scout' })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teammate' })).toBeTruthy())

    const listbox = await openMenu()
    expect(within(listbox).getByRole('option', { name: 'Scout' })).toBeTruthy()
    expect(screen.getByTitle(/cannot run here/i)).toBeTruthy()
  })

  it('keeps the unbind option available', async () => {
    roster = [profile()]
    renderPicker()
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teammate' })).toBeTruthy())

    const listbox = await openMenu()
    expect(
      within(listbox).getByRole('option', { name: /No teammate \(default agent\)/i })
    ).toBeTruthy()
  })
})

describe('AgentProfilePicker deletion', () => {
  it('asks before deleting, next to a pill used constantly', async () => {
    roster = [profile()]
    renderPicker({ profileId: 'scout' })
    await waitFor(() => expect(screen.getByLabelText('Delete teammate Scout')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Delete teammate Scout'))
    // Nothing is destroyed on the first click any more.
    expect(deleted).toHaveLength(0)

    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleted).toEqual(['scout']))
  })

  it('leaves the teammate alone when the confirmation is declined', async () => {
    roster = [profile()]
    renderPicker({ profileId: 'scout' })
    await waitFor(() => expect(screen.getByLabelText('Delete teammate Scout')).toBeTruthy())

    fireEvent.click(screen.getByLabelText('Delete teammate Scout'))
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }))

    await waitFor(() => expect(deleted).toHaveLength(0))
  })
})

describe('AgentProfilePicker creation', () => {
  it('creates by name and binds it to this chat straight away', async () => {
    const onProfileChange = vi.fn()
    roster = [profile()]
    renderPicker({ onProfileChange })
    await waitFor(() => expect(screen.getByRole('button', { name: 'Teammate' })).toBeTruthy())

    const listbox = await openMenu()
    fireEvent.click(within(listbox).getByRole('option', { name: 'New teammate…' }))
    fireEvent.change(await screen.findByPlaceholderText('Frontend Fixer'), {
      target: { value: 'Newbie' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create teammate' }))

    await waitFor(() => expect(onProfileChange).toHaveBeenCalledWith('newbie'))
    expect(pushToastMock).toHaveBeenCalledWith('Teammate "Newbie" created')
  })
})
