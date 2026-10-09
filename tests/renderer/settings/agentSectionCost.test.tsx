/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { DEFAULT_SETTINGS, emptySecretStatus, type Settings } from '@shared/ipc'

afterEach(() => cleanup())

type Update = (partial: Partial<Settings>) => Promise<{ ok: true } | { ok: false; error: string }>

function renderAgent(settings: Settings, onUpdate: Update) {
  return render(
    <SettingsView
      settings={settings}
      secrets={emptySecretStatus()}
      onClose={vi.fn()}
      onUpdate={onUpdate}
      onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
      onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      section="agent"
    />
  )
}

describe('Agent section — Cost', () => {
  it('adds a price by hand, and replaces one for the same provider and model', async () => {
    const onUpdate = vi.fn<Update>(async () => ({ ok: true }))
    renderAgent(
      {
        ...DEFAULT_SETTINGS,
        provider: 'groq',
        customModelPrices: [{ provider: 'groq', model: 'llama-4', input: 1, output: 1 }]
      },
      onUpdate
    )
    expect(screen.getByText('Groq · In $1 · Out $1 per 1M tokens')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'llama-4' } })
    fireEvent.change(screen.getByLabelText('Input price, USD per 1M tokens'), { target: { value: '0.59' } })
    fireEvent.change(screen.getByLabelText('Output price, USD per 1M tokens'), { target: { value: '$0.79' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        customModelPrices: [{ provider: 'groq', model: 'llama-4', input: 0.59, output: 0.79 }]
      })
    )
  })

  it('says what is missing instead of saving a price without rates', () => {
    const onUpdate = vi.fn<Update>(async () => ({ ok: true }))
    renderAgent(DEFAULT_SETTINGS, onUpdate)
    fireEvent.change(screen.getByLabelText('Model id'), { target: { value: 'my-model' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect(screen.getByRole('alert').textContent).toBe('Input and output need a price in dollars per 1M tokens.')
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('keeps commit messages from drafting in the background until switched on', async () => {
    const onUpdate = vi.fn<Update>(async () => ({ ok: true }))
    renderAgent(DEFAULT_SETTINGS, onUpdate)
    const toggle = screen.getByRole('switch', { name: 'Draft commit messages ahead' })
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    fireEvent.click(toggle)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ commitMessageAutoDraft: true }))
  })

  it('saves a daily budget beside the monthly one', async () => {
    const onUpdate = vi.fn<Update>(async () => ({ ok: true }))
    renderAgent({ ...DEFAULT_SETTINGS, spendBudget: { dailyUsd: 0, monthlyUsd: 200, holdAtBudget: false } }, onUpdate)
    const daily = screen.getByLabelText('Daily budget across tasks, in US dollars') as HTMLInputElement
    fireEvent.change(daily, { target: { value: '15' } })
    fireEvent.blur(daily)
    await waitFor(() => expect(onUpdate).toHaveBeenCalledWith({ spendBudget: { dailyUsd: 15, monthlyUsd: 200, holdAtBudget: false } }))
  })
})
