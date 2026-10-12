/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import {
  SETTINGS_SEARCH_INDEX,
  filterSettingsSearch
} from '@renderer/features/settings/settingsSearchIndex'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const emptySecrets = emptySecretStatus()
const baseSettings: Settings = { ...DEFAULT_SETTINGS }

function renderAppearance(
  settings: Settings = baseSettings,
  onUpdate = vi.fn(async (_partial: Partial<Settings>) => ({ ok: true as const })),
  onAppearanceChange = vi.fn()
) {
  render(
    <SettingsView
      settings={settings}
      secrets={emptySecrets}
      section="appearance"
      onClose={vi.fn()}
      onUpdate={onUpdate}
      onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
      onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      onAppearanceChange={onAppearanceChange}
    />
  )
  return { onUpdate, onAppearanceChange }
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.vyotiq = {
    platform: 'win32',
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [], warning: 'seed' }
    }))
  } as never
})

describe('appearance accessibility settings', () => {
  it('renders the accessibility group rows', () => {
    renderAppearance()
    for (const id of [
      'appearance-reduce-motion',
      'appearance-contrast',
      'appearance-focus-ring',
      'appearance-announce'
    ]) {
      expect(document.querySelector(`[data-settings-field="${id}"]`)).toBeTruthy()
    }
    expect(screen.getByRole('switch', { name: 'Always show focus ring' })).toBeTruthy()
  })

  it('renders the text scale slider with the current percentage', () => {
    renderAppearance({ ...baseSettings, fontScale: 1.52 })
    const slider = screen.getByLabelText('Text size scale') as HTMLInputElement
    expect(slider.min).toBe('0.85')
    expect(slider.max).toBe('2')
    expect(slider.step).toBe('0.08')
    expect(slider.value).toBe('1.52')
    expect(
      document.querySelector('[data-settings-field="appearance-font-scale"]')?.textContent
    ).toContain('152%')
  })

  it('shows no preset selected while a numeric scale applies', () => {
    renderAppearance({ ...baseSettings, fontScale: 1.52 })
    const group = screen.getByRole('radiogroup', { name: 'Text size preset' })
    for (const radio of within(group).getAllByRole('radio')) {
      expect(radio.getAttribute('aria-checked')).toBe('false')
    }
  })

  it('reaches 200% through the slider', () => {
    const { onAppearanceChange } = renderAppearance()
    const slider = screen.getByLabelText('Text size scale')
    fireEvent.change(slider, { target: { value: '2' } })
    expect(onAppearanceChange).toHaveBeenCalledWith({ fontScale: 2 })
  })

  it('persists reduce motion through runUpdate', async () => {
    const { onUpdate } = renderAppearance()
    fireEvent.click(screen.getByLabelText('Reduce motion'))
    fireEvent.click(await screen.findByRole('option', { name: 'On' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ reduceMotion: 'on' }))
    )
  })

  it('persists contrast through runUpdate', async () => {
    const { onUpdate } = renderAppearance()
    fireEvent.click(screen.getByLabelText('Contrast'))
    fireEvent.click(await screen.findByRole('option', { name: 'More' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ contrast: 'more' }))
    )
  })

  it('persists the sticky focus ring through runUpdate', async () => {
    const { onUpdate } = renderAppearance()
    fireEvent.click(screen.getByRole('switch', { name: 'Always show focus ring' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ alwaysShowFocusRing: true })
      )
    )
  })

  it('persists announcement verbosity through runUpdate', async () => {
    const { onUpdate } = renderAppearance()
    fireEvent.click(screen.getByLabelText('Screen reader announcements'))
    fireEvent.click(await screen.findByRole('option', { name: 'Brief' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ announceVerbosity: 'brief' })
      )
    )
  })

  it('indexes the new rows for screen reader, accessibility and a11y queries', () => {
    const ids = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.id))
    for (const id of [
      'appearance-reduce-motion',
      'appearance-contrast',
      'appearance-focus-ring',
      'appearance-announce'
    ]) {
      expect(ids.has(id)).toBe(true)
    }
    for (const query of ['screen reader', 'accessibility', 'a11y']) {
      const found = filterSettingsSearch(query).map((entry) => entry.id)
      expect(found).toContain('appearance-announce')
    }
    expect(
      filterSettingsSearch('focus ring').map((entry) => entry.id)
    ).toContain('appearance-focus-ring')
  })

  it('marks changed accessibility rows against their defaults', () => {
    renderAppearance({ ...baseSettings, reduceMotion: 'on' })
    const row = document.querySelector(
      '[data-settings-field="appearance-reduce-motion"]'
    ) as HTMLElement
    expect(row.textContent).toContain('Reduce motion')
    act(() => {})
  })
})
