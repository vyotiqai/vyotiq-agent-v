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

import { TeammatesView } from '@renderer/features/teammates/TeammatesView'
import { resetAgentProfilesStoreForTests } from '@renderer/lib/hooks/useAgentProfiles'

/**
 * The pane is where the fields main has always honoured finally have an
 * editor: the model pin, autonomy, avatar and scope. These tests pin that they
 * reach IPC, and that the scope rules are enforced here rather than at send.
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
let updateCalls: unknown[] = []
let createdName = ''

function renderView(
  props: Partial<React.ComponentProps<typeof TeammatesView>> = {}
): ReturnType<typeof render> {
  return render(
    <TeammatesView
      secrets={{ openai: true, anthropic: false } as never}
      openWorkspaces={['/ws-a', '/ws-b']}
      activeWorkspacePath="/ws-a"
      onClose={() => {}}
      {...props}
    />
  )
}

beforeEach(() => {
  resetAgentProfilesStoreForTests()
  roster = [profile()]
  updateCalls = []
  createdName = ''
  // jsdom has no top layer; Dialog uses a native <dialog>.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.open = true
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.open = false
  }
  // @ts-expect-error test bridge
  window.vyotiq = {
    agentProfilesList: vi.fn(async () => ({ ok: true as const, data: roster })),
    agentProfilesCreate: vi.fn(async (req: { name: string }) => {
      createdName = req.name
      const created = profile({ id: 'newbie', name: req.name })
      roster = [...roster, created]
      return { ok: true as const, data: created }
    }),
    agentProfilesUpdate: vi.fn(async (payload: { id: string; patch: Partial<AgentProfile> }) => {
      updateCalls.push(payload)
      return { ok: true as const, data: { ...profile(), ...payload.patch } }
    }),
    agentProfilesDelete: vi.fn(async () => ({
      ok: true as const,
      data: { deleted: true as const, cancelledTasks: 2, cancelledRuns: 1, warnings: [] }
    })),
    onAgentProfilesChanged: vi.fn(() => () => {}),
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [{ id: 'gpt-5', inputModalities: [], outputModalities: [], supportsTools: true, supportsVision: false }] }
    }))
  }
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

async function openDetail(): Promise<void> {
  renderView()
  await waitFor(() => expect(screen.getByRole('option', { name: /Scout/ })).toBeTruthy())
}

async function deleteFromHeader(): Promise<void> {
  fireEvent.click(screen.getByRole('button', { name: 'More actions for Scout' }))
  const menu = await screen.findByRole('menu', { name: 'More actions for Scout' })
  fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete teammate' }))
}

describe('TeammatesView roster', () => {
  it('selects the first teammate so the pane is never an empty frame', async () => {
    await openDetail()
    expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy()
  })

  it('filters the roster by name and persona', async () => {
    roster = [profile(), profile({ id: 'ace', name: 'Ace', persona: 'Reviews migrations.' })]
    await openDetail()

    fireEvent.change(screen.getByLabelText('Search teammates'), {
      target: { value: 'migrations' }
    })

    expect(screen.queryByRole('option', { name: /Scout/ })).toBeNull()
    expect(screen.getByRole('option', { name: /Ace/ })).toBeTruthy()
  })

  it('lands a newly created teammate in the editor, not back on the list', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'New teammate' }))
    fireEvent.change(screen.getByPlaceholderText('Frontend Fixer'), {
      target: { value: 'Newbie' }
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create teammate' }))

    await waitFor(() => expect(createdName).toBe('Newbie'))
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Newbie' })).toBeTruthy())
  })
})

describe('TeammatesView identity editing', () => {
  it('writes identity fields through one explicit save', async () => {
    await openDetail()
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'Terse.' } })
    // Nothing reaches IPC until Save — an edit in progress must not be
    // published to every other surface keystroke by keystroke.
    expect(updateCalls).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateCalls).toHaveLength(1))
    expect(updateCalls[0]).toMatchObject({ id: 'scout', patch: { tone: 'Terse.' } })
  })

  it('clears a field rather than keeping the old value', async () => {
    roster = [profile({ persona: 'Old persona.' })]
    await openDetail()
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateCalls).toHaveLength(1))
    expect((updateCalls[0] as { patch: Record<string, unknown> }).patch.persona).toBeUndefined()
  })

  it('stores an avatar chosen from the picker beside the name', async () => {
    await openDetail()
    // Twenty-one icon squares inline made the least important field the
    // loudest control in the form; they belong behind the chip.
    expect(screen.queryByRole('group', { name: 'Avatar' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Change avatar' }))
    fireEvent.click(within(screen.getByRole('group', { name: 'Avatar' })).getByLabelText('sparkles'))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateCalls).toHaveLength(1))
    expect(updateCalls[0]).toMatchObject({ patch: { avatar: 'sparkles' } })
  })

  it('offers no save affordance at all until something actually changed', async () => {
    await openDetail()
    // A permanently docked bar with two dead buttons is chrome, and it used to
    // sit inside the scroll and paint over the last row of the form.
    expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Discard' })).toBeNull()

    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'Terse.' } })

    expect(screen.getByRole('button', { name: 'Save changes' }).hasAttribute('disabled')).toBe(
      false
    )
    expect(screen.getByText('Unsaved changes')).toBeTruthy()
  })

  it('keeps an unsaved edit and says so while the Activity tab is open', async () => {
    await openDetail()
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'Terse.' } })
    fireEvent.click(screen.getByRole('tab', { name: 'Activity' }))

    expect(screen.queryByLabelText('Tone')).toBeNull()
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy()

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }))
    expect((screen.getByLabelText('Tone') as HTMLInputElement).value).toBe('Terse.')
    expect(updateCalls).toHaveLength(0)
  })

  it('discards an edit without touching main', async () => {
    await openDetail()
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'Terse.' } })
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }))

    expect((screen.getByLabelText('Tone') as HTMLInputElement).value).toBe('')
    expect(updateCalls).toHaveLength(0)
  })
})

describe('TeammatesView model pin and autonomy', () => {
  it('offers only providers that actually have a key', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Pinned provider' }))

    const listbox = await screen.findByRole('listbox', { name: 'Pinned provider' })
    const labels = within(listbox)
      .getAllByRole('option')
      .map((o) => o.textContent)
    // anthropic has no key in this fixture; offering it would produce a pin
    // whose runs fail at send.
    expect(labels.some((l) => /anthropic/i.test(l ?? ''))).toBe(false)
    expect(labels.some((l) => /No pinned model/i.test(l ?? ''))).toBe(true)
  })

  it('saves the autonomy mode main already honours', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Tool approvals' }))
    const listbox = await screen.findByRole('listbox', { name: 'Tool approvals' })
    fireEvent.click(within(listbox).getByRole('option', { name: 'Always ask before tools' }))
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))

    await waitFor(() => expect(updateCalls).toHaveLength(1))
    expect(updateCalls[0]).toMatchObject({ patch: { autonomousMode: 'off' } })
  })
})

describe('TeammatesView scope', () => {
  it('warns that narrowing a teammate strands work elsewhere', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'Scope' }))
    const listbox = await screen.findByRole('listbox', { name: 'Scope' })
    fireEvent.click(within(listbox).getByRole('option', { name: 'One workspace only' }))

    expect(
      screen.getByText(/other workspaces will stop working/i)
    ).toBeTruthy()
  })

  it('flags a teammate that belongs to a different workspace and blocks starting a chat', async () => {
    // main returns null from resolveAgentProfile outside the owning workspace,
    // so a bound chat fails on send. The refusal belongs here instead.
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-b' })]
    renderView({ activeWorkspacePath: '/ws-a', onStartTeammateChat: vi.fn() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())

    expect(screen.getByRole('button', { name: 'New chat' }).hasAttribute('disabled')).toBe(true)
    expect(screen.getByText(/cannot run here/i)).toBeTruthy()
  })

  it('lets a workspace teammate be used in its own workspace', async () => {
    roster = [profile({ scope: 'workspace', workspacePath: '/ws-a' })]
    renderView({ activeWorkspacePath: '/ws-a', onStartTeammateChat: vi.fn() })
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy())

    expect(screen.getByRole('button', { name: 'New chat' }).hasAttribute('disabled')).toBe(false)
    expect(screen.queryByText(/cannot run here/i)).toBeNull()
  })
})

describe('TeammatesView deletion', () => {
  it('reports the work the delete actually stopped', async () => {
    await openDetail()
    // No danger-zone card at the end of the form: deleting is a header action.
    await deleteFromHeader()
    // useConfirm renders its own dialog.
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))

    await waitFor(() =>
      expect(pushToastMock).toHaveBeenCalledWith('Deleted Scout — stopped 2 tasks and 1 run')
    )
  })
})

describe('TeammatesView roster warnings', () => {
  it('shows a partial-delete warning and lets it be dismissed', async () => {
    window.vyotiq.agentProfilesDelete = vi.fn(async () => ({
      ok: true as const,
      data: {
        deleted: true as const,
        cancelledTasks: 0,
        cancelledRuns: 0,
        warnings: ['Could not remove override in /ws-a']
      }
    }))
    await openDetail()
    await deleteFromHeader()
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Delete' }))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('Could not remove override in /ws-a')

    fireEvent.click(screen.getByLabelText('Dismiss teammate warning'))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
  })
})

describe('TeammatesView navigation', () => {
  it('reaches the task inbox without giving up the selected teammate', async () => {
    await openDetail()
    fireEvent.click(screen.getByRole('button', { name: 'All tasks' }))

    // The detail pane is the inbox now...
    expect(screen.queryByRole('tab', { name: 'Settings' })).toBeNull()
    expect(screen.getByRole('heading', { name: 'All tasks' })).toBeTruthy()
    // ...but the rail still knows which teammate was open, so going back is
    // one click rather than a re-selection.
    expect(screen.getByRole('option', { name: /Scout/ }).getAttribute('aria-selected')).toBe('true')

    fireEvent.click(screen.getByRole('option', { name: /Scout/ }))
    expect(screen.getByRole('heading', { name: 'Scout' })).toBeTruthy()
  })
})
