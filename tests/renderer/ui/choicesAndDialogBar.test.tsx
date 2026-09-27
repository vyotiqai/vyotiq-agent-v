/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Dialog } from '@renderer/lib/a11y'
import { Checkbox, Count, RadioList, StepMarker } from '@renderer/lib/ui'

afterEach(cleanup)

describe('Dialog bar', () => {
  it('draws the 48px bar with its icon, title and a close button when given an icon', () => {
    const onClose = vi.fn()
    render(
      <Dialog open onClose={onClose} title="Send feedback" icon="note" padded={false}>
        <p>Body</p>
      </Dialog>
    )
    const dialog = screen.getByRole('dialog', { name: 'Send feedback' })
    const heading = screen.getByRole('heading', { name: 'Send feedback' })
    expect(heading.parentElement!.className).toMatch(/\bh-12\b/)
    expect(heading.parentElement!.className).toContain('border-b')
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(dialog).toBeTruthy()
  })

  it('keeps the plain title, with no bar or close button, for a short decision', () => {
    render(
      <Dialog open onClose={() => {}} title="Delete this task?">
        <p>Body</p>
      </Dialog>
    )
    const heading = screen.getByRole('heading', { name: 'Delete this task?' })
    expect(heading.parentElement!.className).not.toMatch(/\bh-12\b/)
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull()
  })
})

function Modes({ disabledLast = false }: { disabledLast?: boolean }) {
  const [value, setValue] = useState<'a' | 'b' | 'c'>('a')
  return (
    <RadioList
      label="Mode"
      value={value}
      onChange={setValue}
      choices={[
        { value: 'a', label: 'Alpha', description: 'First' },
        { value: 'b', label: 'Beta', disabled: disabledLast },
        { value: 'c', label: 'Gamma', disabled: disabledLast }
      ]}
    />
  )
}

describe('RadioList', () => {
  it('is a named radio group whose chosen row takes the one selected fill', () => {
    render(<Modes />)
    expect(screen.getByRole('radiogroup', { name: 'Mode' })).toBeTruthy()
    const alpha = screen.getByRole('radio', { name: /Alpha/ })
    const beta = screen.getByRole('radio', { name: /Beta/ })
    expect(alpha.getAttribute('aria-checked')).toBe('true')
    expect(alpha.className).toContain('bg-surface-2')
    // One of the two states only — cn() has no merge to settle a conflict.
    expect(beta.className).not.toContain('bg-surface-2')
    expect(beta.className).toContain('hover:bg-surface')
    expect(alpha.tabIndex).toBe(0)
    expect(beta.tabIndex).toBe(-1)
  })

  it('moves the choice and focus with the arrow keys, wrapping, Home and End', () => {
    render(<Modes />)
    const alpha = screen.getByRole('radio', { name: /Alpha/ })
    alpha.focus()
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    const beta = screen.getByRole('radio', { name: /Beta/ })
    expect(beta.getAttribute('aria-checked')).toBe('true')
    expect(document.activeElement).toBe(beta)
    fireEvent.keyDown(beta, { key: 'End' })
    expect(screen.getByRole('radio', { name: /Gamma/ }).getAttribute('aria-checked')).toBe('true')
    fireEvent.keyDown(screen.getByRole('radio', { name: /Gamma/ }), { key: 'ArrowDown' })
    expect(alpha.getAttribute('aria-checked')).toBe('true')
  })

  it('skips rows that are unavailable', () => {
    render(<Modes disabledLast />)
    const alpha = screen.getByRole('radio', { name: /Alpha/ })
    fireEvent.keyDown(alpha, { key: 'ArrowDown' })
    expect(alpha.getAttribute('aria-checked')).toBe('true')
  })
})

describe('marks', () => {
  it('draws the radio ring in the accent the checkbox uses', () => {
    render(
      <>
        <Modes />
        <Checkbox checked onCheckedChange={() => {}} aria-label="Viewed" />
      </>
    )
    const ring = screen.getByRole('radio', { name: /Alpha/ }).querySelector('[aria-hidden]')!
    expect(ring.className).toContain('border-accent')
    const box = screen.getByRole('checkbox', { name: 'Viewed' }).querySelector('[aria-hidden]')!
    expect(box.className).toContain('border-accent')
  })
})

describe('small numerals', () => {
  it('sets a count badge and a pending step number at caption size — 2xs is for keycaps', () => {
    const { container } = render(
      <>
        <Count n={3} tone="accent" />
        <StepMarker state="queued" n={4} />
      </>
    )
    for (const el of Array.from(container.querySelectorAll('span'))) {
      expect(el.className).not.toContain('text-2xs')
    }
    expect(screen.getByText('3').className).toContain('text-caption')
    expect(screen.getByText('4').className).toContain('text-caption')
  })
})
