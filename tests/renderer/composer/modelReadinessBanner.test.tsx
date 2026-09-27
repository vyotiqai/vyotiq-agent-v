/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ModelReadinessBanner } from '@renderer/features/chat/components/composer/ModelReadinessBanner'

afterEach(() => {
  cleanup()
})

describe('ModelReadinessBanner', () => {
  it('hands its buttons to the Alert, never by overriding its root', () => {
    render(
      <ModelReadinessBanner
        issue={{ kind: 'unreachable', provider: 'ollama', label: 'Ollama', detail: 'Nothing is listening on :11434' }}
        onRecheck={vi.fn()}
        onAddKey={vi.fn()}
      />
    )
    const alert = screen.getByRole('status')
    // cn() has no merge: a second flex direction on the root would fight `items-start`.
    expect(alert.classList.contains('flex-col')).toBe(false)
    expect(alert.classList.contains('items-stretch')).toBe(false)
    // The buttons sit in the Alert's own actions slot, after the text.
    const recheck = screen.getByRole('button', { name: 'Recheck' })
    expect(recheck.parentElement?.previousElementSibling?.textContent).toContain('Ollama isn’t ready')
  })

  it('offers Recheck and an outlined Add API key when the provider is unreachable', () => {
    const onRecheck = vi.fn()
    const onAddKey = vi.fn()
    render(
      <ModelReadinessBanner
        issue={{ kind: 'unreachable', provider: 'ollama', label: 'Ollama', detail: 'Nothing is listening on :11434' }}
        onRecheck={onRecheck}
        onAddKey={onAddKey}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: 'Recheck' }))
    expect(onRecheck).toHaveBeenCalledTimes(1)
    const addKey = screen.getByRole('button', { name: 'Add API key' })
    expect(addKey.className).toContain('border-border')
    fireEvent.click(addKey)
    expect(onAddKey).toHaveBeenCalledTimes(1)
  })

  it('leaves the brief one primary: its buttons are outlined when primary is off', () => {
    const { rerender } = render(
      <ModelReadinessBanner issue={{ kind: 'missing_key', provider: 'openai', label: 'OpenAI' }} onRecheck={vi.fn()} onAddKey={vi.fn()} />
    )
    expect(screen.getByRole('button', { name: 'Add API key' }).classList.contains('bg-accent')).toBe(true)
    rerender(
      <ModelReadinessBanner
        issue={{ kind: 'missing_key', provider: 'openai', label: 'OpenAI' }}
        onRecheck={vi.fn()}
        onAddKey={vi.fn()}
        primary={false}
      />
    )
    const addKey = screen.getByRole('button', { name: 'Add API key' })
    expect(addKey.classList.contains('bg-accent')).toBe(false)
    expect(addKey.classList.contains('border-border')).toBe(true)
  })
})
