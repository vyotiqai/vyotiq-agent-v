/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { QuestionField } from '@renderer/features/chat/components/askQuestion/QuestionFields'
import type { UiAgentQuestionItem } from '@shared/transcript'

afterEach(cleanup)

function field(item: UiAgentQuestionItem, values: string[] = []) {
  return render(
    <QuestionField item={item} values={values} customText="" promptId="p" onChange={vi.fn()} />
  )
}

describe('question fields', () => {
  it('marks the chosen option with the one selected fill, and no ring of its own', () => {
    field({ id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask', 'Agent'], allowCustom: true }, ['Agent'])
    const on = screen.getByRole('radio', { name: 'Agent' })
    const off = screen.getByRole('radio', { name: 'Ask' })
    expect(on.classList.contains('bg-surface-2')).toBe(true)
    expect(on.classList.contains('text-fg-strong')).toBe(true)
    expect(on.className).not.toMatch(/ring-border/)
    // cn() has no merge: the idle colour must not ride along with the selected one.
    expect(on.classList.contains('text-secondary')).toBe(false)
    expect(off.classList.contains('text-secondary')).toBe(true)
    // Inset ring: survives the gate's overflow-hidden.
    expect(on.className).toContain('focus-visible:ring-inset')
    expect(on.className).toContain('focus-visible:ring-focus')
  })

  it('draws Other with the Input field chrome', () => {
    field({ id: 'a', prompt: 'Mode?', type: 'single', options: ['Ask'], allowCustom: true })
    const other = screen.getByRole('textbox', { name: 'Other answer' })
    expect(other.hasAttribute('data-vy-text-entry')).toBe(true)
  })

  it('draws the free-text answer with field chrome and a focus ring', () => {
    field({ id: 'a', prompt: 'Notes', type: 'text' })
    const box = screen.getByPlaceholderText('Your answer…')
    expect(box.className).toContain('focus-visible:vy-focus-ring')
    expect(box.className).toContain('hover:border-border-strong')
  })

  it('ticks a multi-choice option with the checkbox box', () => {
    const { container } = field({ id: 'a', prompt: 'Which?', type: 'multi', options: ['One', 'Two'] }, ['One'])
    const on = screen.getByRole('checkbox', { name: 'One' })
    expect(on.querySelector('svg')).not.toBeNull()
    expect(container.querySelector('.opacity-90')).toBeNull()
  })
})
