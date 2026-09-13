/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings } from '@shared/ipc'
import { DEFAULT_AGENT_PERSONA, DEFAULT_AGENT_TONE } from '@shared/agentPersona'

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

  it('shows the built-in default persona/tone as placeholder when fields are empty', () => {
    const onUpdate = vi.fn<Parameters<Update>, ReturnType<Update>>(
      async () => ({ ok: true })
    )
    renderAgentSettings(DEFAULT_SETTINGS, onUpdate)

    const persona = screen.getByLabelText('Persona') as HTMLTextAreaElement
    expect(persona.value).toBe('')
    expect(persona.placeholder).toBe(DEFAULT_AGENT_PERSONA)

    const tone = screen.getByLabelText('Tone') as HTMLTextAreaElement
    expect(tone.value).toBe('')
    expect(tone.placeholder).toBe(DEFAULT_AGENT_TONE)
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
    expect(persona.placeholder).toBe(DEFAULT_AGENT_PERSONA)

    const tone = screen.getByLabelText('Tone') as HTMLTextAreaElement
    expect(tone.value).toBe('Blunt, warm')
    expect(tone.placeholder).toBe(DEFAULT_AGENT_TONE)
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
