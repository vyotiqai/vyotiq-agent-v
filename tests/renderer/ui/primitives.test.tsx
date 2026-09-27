/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Badge, FormCard, FormRow } from '@renderer/lib/ui'
import { SettingsField } from '@renderer/features/settings/components/SettingsField'

afterEach(cleanup)

describe('Badge', () => {
  it('maps a tone onto theme tokens rather than a fixed colour', () => {
    render(<Badge tone="danger">Failed</Badge>)
    const badge = screen.getByText('Failed')
    expect(badge.className).toContain('text-danger')
    expect(badge.className).not.toMatch(/text-(red|green|amber|zinc)-\d/)
  })

  it('adds a leading marker only when asked', () => {
    const { container, rerender } = render(<Badge tone="accent">Running</Badge>)
    expect(container.querySelectorAll('span').length).toBe(1)
    rerender(
      <Badge tone="accent" dot>
        Running
      </Badge>
    )
    expect(container.querySelectorAll('span').length).toBe(2)
  })
})

describe('FormRow', () => {
  it('marks the row with a caller-chosen attribute', () => {
    const { container } = render(
      <FormRow id="pinned-model" title="Model">
        <span>child</span>
      </FormRow>
    )
    expect(container.querySelector('[data-form-row="pinned-model"]')).toBeTruthy()
  })

  it('exposes long help as a labelled control, not a bare title', () => {
    render(
      <FormRow id="scope" title="Scope" help="Where this teammate is available.">
        <span>child</span>
      </FormRow>
    )
    expect(screen.getByRole('button', { name: 'About Scope' })).toBeTruthy()
  })

  it('renders a bare card without a row id', () => {
    const { container } = render(
      <FormCard>
        <span>child</span>
      </FormCard>
    )
    expect(container.querySelector('[data-form-card]')).toBeTruthy()
  })
})

describe('Settings shim over the shared form grammar', () => {
  // The settings search index scrolls and highlights by querying
  // `[data-settings-field="<id>"]`. Moving the layout into lib/ui must not
  // rename that attribute, or search breaks with no visible markup change.
  it('keeps the attribute the settings search index queries', () => {
    const { container } = render(
      <SettingsField id="agent-persona" title="Persona">
        <span>child</span>
      </SettingsField>
    )
    expect(container.querySelector('[data-settings-field="agent-persona"]')).toBeTruthy()
    expect(container.querySelector('[data-form-row]')).toBeNull()
  })

  it('still renders the title and hint it always did', () => {
    render(
      <SettingsField id="agent-tone" title="Tone" hint="How it responds.">
        <span>child</span>
      </SettingsField>
    )
    expect(screen.getByText('Tone')).toBeTruthy()
    expect(screen.getByText('How it responds.')).toBeTruthy()
  })
})
