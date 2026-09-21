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
/** Privileged fields main is withholding, per workspace then profile id. */
let unaccepted: Record<string, Record<string, string[]>> = {}
let accepts: { workspacePath: string; profileId: string }[] = []
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
  unaccepted = {}
  accepts = []
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
      data: {
        workspacePath,
        overrides: stored[workspacePath] ?? {},
        unaccepted: unaccepted[workspacePath] ?? {}
      }
    })),
    agentProfileOverrideAccept: vi.fn(
      async (req: { workspacePath: string; profileId: string }) => {
        accepts.push(req)
        // Main re-reads the file and answers with the refreshed listing.
        const remaining = { ...(unaccepted[req.workspacePath] ?? {}) }
        delete remaining[req.profileId]
        unaccepted[req.workspacePath] = remaining
        return {
          ok: true as const,
          data: {
            workspacePath: req.workspacePath,
            overrides: stored[req.workspacePath] ?? {},
            unaccepted: remaining
          }
        }
      }
    ),
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

  it('switches the model override on for a teammate with no global pin', async () => {
    // Regression: the switched-on set used to be inferred from
    // `draft[key] !== undefined`, and the model row seeds from
    // `profile.model` — `undefined` here. So the switch read back as off and
    // flipped itself straight down again, leaving the row permanently dead.
    // Every other field seeds to a defined value, which is why only this one
    // broke and why no test caught it.
    expect(profile.model).toBeUndefined()
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Edit override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))

    fireEvent.click(screen.getByLabelText('Override Pinned model'))

    expect(screen.getByLabelText('Override Pinned model').getAttribute('aria-checked')).toBe('true')
    // The switch being on has to actually reveal the editor it gates.
    expect(screen.getByLabelText('Pinned provider')).toBeTruthy()
  })

  it('does not write a pin that names a provider but no model', async () => {
    // `TeammateModelPin` says such a pin is ignored ("Pick a model, or the pin
    // is ignored"), but AgentProfileModelSchema requires a non-empty model, so
    // sending one fails the whole save on a Zod error. A hand-authored file can
    // carry one too, which is how this reaches the form.
    stored['/ws-a'] = { scout: { model: { provider: 'openai', model: '' } } }
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Edit override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Edit override for ws-a'))
    fireEvent.click(screen.getByRole('button', { name: 'Save override' }))

    await waitFor(() => expect(writes).toHaveLength(1))
    // Nothing usable was overridden, so the file goes rather than being
    // rewritten as `{}` — the old gate counted the undefined-valued key.
    expect(writes[0].override).toBeNull()
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
    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByLabelText('Override Tone')).toBeTruthy()
    // Asserting only the ABSENCE of a success toast locked in the silence: the
    // store published this reason and nothing rendered it. The banner belongs
    // inside the dialog, because that is what is on screen when a save fails.
    expect(within(dialog).getByText('Workspace is not open')).toBeTruthy()
  })

  it('surfaces a refused accept on the row, where the click happened', async () => {
    stored['/ws-a'] = { scout: { autonomousMode: 'on' } }
    unaccepted['/ws-a'] = { scout: ['autonomousMode'] }
    window.vyotiq.agentProfileOverrideAccept = vi.fn(async () => ({
      ok: false as const,
      error: 'Override file changed while you were reading it'
    }))
    renderOverrides()
    await waitFor(() => expect(screen.getByLabelText('Accept override for ws-a')).toBeTruthy())
    fireEvent.click(screen.getByLabelText('Accept override for ws-a'))
    const confirmDialog = await screen.findByRole('dialog')
    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Accept' }))

    // No dialog is open on this path, so the banner belongs above the group.
    await waitFor(() =>
      expect(screen.getByText('Override file changed while you were reading it')).toBeTruthy()
    )
  })
})

describe('override trust', () => {
  it('says a project change is not applied, and names it', async () => {
    // These files arrive over git, so the row has to distinguish "this project
    // retunes the teammate" from "this project is ASKING to, and we said no".
    stored['/ws-a'] = { scout: { tone: 'Workspace tone.', autonomousMode: 'on' } }
    unaccepted['/ws-a'] = { scout: ['autonomousMode'] }
    renderOverrides()

    await waitFor(() => expect(screen.getByText('1 change not applied')).toBeTruthy())
    expect(screen.getByText(/asking to change tool approvals/)).toBeTruthy()
  })

  it('accepts the file behind a confirmation', async () => {
    stored['/ws-a'] = { scout: { autonomousMode: 'on' } }
    unaccepted['/ws-a'] = { scout: ['autonomousMode'] }
    renderOverrides()

    await waitFor(() =>
      expect(screen.getByLabelText('Accept override for ws-a')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Accept override for ws-a'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }))

    await waitFor(() => expect(accepts).toHaveLength(1))
    expect(accepts[0]).toEqual({ workspacePath: '/ws-a', profileId: 'scout' })
    // The warning clears once main answers with the refreshed listing.
    await waitFor(() => expect(screen.queryByText('1 change not applied')).toBeNull())
  })

  it('accepts nothing when the confirmation is declined', async () => {
    stored['/ws-a'] = { scout: { autonomousMode: 'on' } }
    unaccepted['/ws-a'] = { scout: ['autonomousMode'] }
    renderOverrides()

    await waitFor(() =>
      expect(screen.getByLabelText('Accept override for ws-a')).toBeTruthy()
    )
    fireEvent.click(screen.getByLabelText('Accept override for ws-a'))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(accepts).toHaveLength(0)
  })

  it('offers nothing to accept for an ordinary override', async () => {
    // A persona-only file is the common case and must never look like a
    // pending security decision.
    stored['/ws-a'] = { scout: { tone: 'Workspace tone.' } }
    renderOverrides()

    await waitFor(() => expect(screen.getByText('1 field overridden')).toBeTruthy())
    expect(screen.queryByLabelText('Accept override for ws-a')).toBeNull()
  })
})
