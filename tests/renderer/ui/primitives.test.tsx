/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Avatar, Badge, EmptyState, FormCard, FormRow } from '@renderer/lib/ui'
import {
  SettingsCard,
  SettingsField
} from '@renderer/features/settings/components/SettingsField'

afterEach(cleanup)

describe('Avatar', () => {
  it('renders the named icon when the key resolves', () => {
    const { container } = render(<Avatar name="Scout" icon="bot" />)
    expect(container.querySelector('svg')).toBeTruthy()
    expect(container.textContent).toBe('')
  })

  it('falls back to the initial for a key this build does not have', () => {
    // `AgentProfile.avatar` is a free `z.string().max(32)`, so a roster written
    // by another build can name an icon that is not in the registry. Indexing
    // ICONS with it would render `undefined` and throw.
    const { container } = render(<Avatar name="Scout" icon="not-a-real-icon" />)
    expect(container.querySelector('svg')).toBeNull()
    expect(container.textContent).toBe('S')
  })

  it('falls back when no icon is stored at all', () => {
    const { container } = render(<Avatar name="ada" />)
    expect(container.textContent).toBe('A')
  })

  it('still renders something for a blank name', () => {
    const { container } = render(<Avatar name="   " />)
    expect(container.textContent).toBe('?')
  })
})

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

describe('EmptyState', () => {
  it('shows the title, the explanation and the action that ends it', () => {
    render(
      <EmptyState
        icon="bot"
        title="No teammates yet"
        description="A teammate keeps its own memory."
        action={<button type="button">New teammate</button>}
      />
    )
    expect(screen.getByText('No teammates yet')).toBeTruthy()
    expect(screen.getByText('A teammate keeps its own memory.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'New teammate' })).toBeTruthy()
  })

  it('omits the description and action when there are none', () => {
    const { container } = render(<EmptyState title="Nothing here" />)
    expect(container.querySelectorAll('p').length).toBe(1)
    expect(container.querySelector('button')).toBeNull()
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

  it('keeps the card attribute too', () => {
    const { container } = render(
      <SettingsCard>
        <span>child</span>
      </SettingsCard>
    )
    expect(container.querySelector('[data-settings-card]')).toBeTruthy()
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
