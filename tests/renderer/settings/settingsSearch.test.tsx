/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { SettingsSearch } from '@renderer/features/settings/components/SettingsSearch'

vi.mock('@renderer/features/settings/settingsSearchIndex', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@renderer/features/settings/settingsSearchIndex')>()
  return {
    ...actual,
    filterSettingsSearch: (query: string) => {
      const q = query.trim().toLowerCase()
      if (!q) return []
      return [
        {
          id: 'agent-model',
          title: 'Default model',
          section: 'agent' as const,
          keywords: ['model']
        },
        {
          id: 'providers-openai',
          title: 'OpenAI API key',
          section: 'providers' as const,
          keywords: ['openai']
        }
      ]
    },
    scrollToSettingsField: vi.fn()
  }
})

afterEach(() => {
  cleanup()
})

describe('SettingsSearch', () => {
  it('moves active option with arrow keys', () => {
    render(<SettingsSearch section="agent" onSectionChange={vi.fn()} />)
    const input = screen.getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(input, { target: { value: 'model' } })
    expect(screen.getByRole('listbox', { name: 'Settings search results' })).toBeTruthy()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input.getAttribute('aria-activedescendant')).toMatch(/providers-openai/)
  })

  it('reveals the target field before scrolling', () => {
    const onRevealField = vi.fn()
    const onSectionChange = vi.fn()
    render(
      <SettingsSearch
        section="agent"
        onSectionChange={onSectionChange}
        onRevealField={onRevealField}
      />
    )
    fireEvent.change(screen.getByRole('textbox', { name: 'Search settings' }), {
      target: { value: 'openai' }
    })
    fireEvent.click(screen.getByRole('option', { name: /OpenAI API key/i }))
    expect(onRevealField).toHaveBeenCalledWith('providers-openai')
    expect(onSectionChange).toHaveBeenCalledWith('providers')
  })

  it('clears a query on Escape, then closes on the next Escape', () => {
    const onClose = vi.fn()
    render(<SettingsSearch section="agent" onSectionChange={vi.fn()} onClose={onClose} />)
    const input = screen.getByRole('textbox', { name: 'Search settings' })
    fireEvent.change(input, { target: { value: 'model' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).not.toHaveBeenCalled()
    expect((input as HTMLInputElement).value).toBe('')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
