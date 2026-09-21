/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const emptySecrets = emptySecretStatus()

type Update = (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>

function renderAgentSettings(settings: Settings, onUpdate: Update) {
  return render(
    <SettingsView
      settings={settings}
      secrets={emptySecrets}
      onClose={vi.fn()}
      onUpdate={onUpdate}
      onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
      onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      section="agent"
    />
  )
}

describe('Agent section — Persona & style fields', () => {
  it('seeds drafts from persisted settings', () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(
      { ...DEFAULT_SETTINGS, agentPersona: 'Nova', agentTone: 'blunt', responseLanguage: 'Spanish' },
      onUpdate
    )
    expect((screen.getByLabelText('Persona') as HTMLTextAreaElement).value).toBe('Nova')
    expect((screen.getByLabelText('Tone') as HTMLTextAreaElement).value).toBe('blunt')
    expect((screen.getByLabelText('Response language') as HTMLInputElement).value).toBe('Spanish')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('persists trimmed persona/tone/language on blur and skips no-change blurs', async () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)

    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement
    fireEvent.change(persona, { target: { value: '  Nova Prime  ' } })
    expect(screen.getByText('Unsaved — saved when you leave the field')).toBeTruthy()
    fireEvent.blur(persona)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentPersona: 'Nova Prime' }))
    )
    await waitFor(() => expect((screen.getByLabelText('Persona') as HTMLTextAreaElement).value).toBe('Nova Prime'))

    const tone = screen.getByLabelText('Tone') as HTMLTextAreaElement
    fireEvent.change(tone, { target: { value: 'Blunt, warm ' } })
    fireEvent.blur(tone)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentTone: 'Blunt, warm' }))
    )

    const language = screen.getByLabelText('Response language') as HTMLInputElement
    fireEvent.change(language, { target: { value: ' German ' } })
    fireEvent.blur(language)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ responseLanguage: 'German' })
      )
    )

    fireEvent.blur(screen.getByLabelText('Persona'))
    fireEvent.blur(tone)
    fireEvent.blur(language)
    expect(onUpdate).toHaveBeenCalledTimes(3)
  })

  it('flushes an uncommitted draft when Settings unmounts (no silent text loss)', async () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    const { unmount } = renderAgentSettings(DEFAULT_SETTINGS, onUpdate)
    fireEvent.change(screen.getByLabelText('Persona'), {
      target: { value: '  Never blurred  ' }
    })
    unmount()
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ agentPersona: 'Never blurred' })
      )
    )
  })

  it('leaves persona/tone empty with an example placeholder, not a built-in default', () => {
    // The placeholder is an example of what the user could type. It must not
    // name or describe an assistant the app ships with — there is none.
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)

    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement
    expect(persona.value).toBe('')
    expect(persona.placeholder).toMatch(/^e\.g\. /)
    expect(persona.placeholder).not.toContain('Agent V')

    const tone = screen.getByLabelText('Tone') as HTMLTextAreaElement
    expect(tone.value).toBe('')
    expect(tone.placeholder).toMatch(/^e\.g\. /)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('shows the saved persona/tone instead of the placeholder when set', () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(
      { ...DEFAULT_SETTINGS, agentPersona: 'Nova', agentTone: 'Blunt, warm' },
      onUpdate
    )

    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement
    expect(persona.value).toBe('Nova')

    const tone = screen.getByLabelText('Tone') as HTMLTextAreaElement
    expect(tone.value).toBe('Blunt, warm')
  })

  it('leaves identity empty with an example placeholder, and shows the saved identity when set', () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)

    const identity = screen.getByLabelText('Identity') as HTMLTextAreaElement
    expect(identity.value).toBe('')
    expect(identity.placeholder).toMatch(/^e\.g\. /)
    expect(identity.placeholder).not.toContain('Agent V')
    expect(onUpdate).not.toHaveBeenCalled()

    cleanup()
    renderAgentSettings(
      { ...DEFAULT_SETTINGS, agentIdentity: 'Verified first, claims second' } as Settings,
      onUpdate
    )
    const saved = screen.getByLabelText('Identity') as HTMLTextAreaElement
    expect(saved.value).toBe('Verified first, claims second')
  })

  it('persists trimmed identity on blur and skips no-change blurs', async () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)

    const identity = screen.getByLabelText('Identity') as HTMLTextAreaElement
    fireEvent.change(identity, { target: { value: '  Reads code before acting  ' } })
    fireEvent.blur(identity)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ agentIdentity: 'Reads code before acting' })
      )
    )
    await waitFor(() =>
      expect((screen.getByLabelText('Identity') as HTMLTextAreaElement).value).toBe(
        'Reads code before acting'
      )
    )

    fireEvent.blur(identity)
    expect(onUpdate).toHaveBeenCalledTimes(1)
  })

  it('flushes an unblurred identity draft when Settings unmounts', async () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    const { unmount } = renderAgentSettings(DEFAULT_SETTINGS, onUpdate)
    fireEvent.change(screen.getByLabelText('Identity'), {
      target: { value: '  Never blurred either  ' }
    })
    unmount()
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ agentIdentity: 'Never blurred either' })
      )
    )
  })

  it('shows the live character counter for persona', () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)
    fireEvent.change(screen.getByLabelText('Persona'), { target: { value: 'Nova Prime' } })
    expect(screen.getByText('10/1000')).toBeTruthy()
  })
})
