/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { Menu, Segmented, Tabs, selectTriggerClass } from '@renderer/lib/ui'

afterEach(cleanup)

const ITEMS = [
  { id: 'a', label: 'Fit' },
  { id: 'b', label: '390' }
] as const

const heights = (el: Element): string[] => [...el.classList].filter((c) => /^h-\d+$/.test(c))

describe('Segmented sizes', () => {
  it('sits in a 40px row at xs: a 24px track, 20px segments that hit at 24px', () => {
    render(<Segmented label="Viewport" value="a" items={ITEMS} size="xs" />)
    const group = screen.getByRole('radiogroup', { name: 'Viewport' })
    // cn() has no tailwind-merge: exactly one height on each, never two.
    expect(heights(group)).toEqual(['h-6'])
    const fit = screen.getByRole('radio', { name: 'Fit' })
    expect(heights(fit)).toEqual(['h-5'])
    expect(fit.classList.contains('before:-inset-y-0.5')).toBe(true)
  })

  it('keeps its 28px track by default', () => {
    render(<Segmented label="Viewport" value="a" items={ITEMS} />)
    expect(heights(screen.getByRole('radiogroup', { name: 'Viewport' }))).toEqual(['h-7'])
    expect(heights(screen.getByRole('radio', { name: 'Fit' }))).toEqual(['h-6'])
  })
})

describe('Menu trigger sizes', () => {
  it('is 24px at xs, for a 40px pane row, and 28px by default', () => {
    render(<Menu aria-label="Scope" value="a" options={[{ value: 'a', label: 'This task' }]} onChange={() => {}} size="xs" bare />)
    expect(heights(screen.getByRole('button', { name: 'Scope' }))).toEqual(['h-6'])
    expect(selectTriggerClass().split(' ').filter((c) => /^h-\d+$/.test(c))).toEqual(['h-7'])
  })
})

describe('Tabs at row size', () => {
  const tabs = [
    { id: 'a', label: 'Changes' },
    { id: 'b', label: 'Files' }
  ] as const

  it('fills the 40px row so the underline rests on its hairline, with the ring drawn inside', () => {
    render(<Tabs label="Inspector" value="a" items={tabs} size="row" />)
    const list = screen.getByRole('tablist', { name: 'Inspector' })
    expect(list.classList.contains('self-stretch')).toBe(true)
    expect(list.classList.contains('gap-2')).toBe(true)
    expect(list.classList.contains('gap-4')).toBe(false)
    const tab = screen.getByRole('tab', { name: 'Changes' })
    expect(heights(tab)).toEqual([])
    expect(tab.classList.contains('focus-visible:vy-focus-ring-inset')).toBe(true)
    expect(tab.classList.contains('focus-visible:vy-focus-ring')).toBe(false)
    const line = tab.querySelector('span[aria-hidden="true"]:last-child') as HTMLElement
    expect(line.classList.contains('bottom-0')).toBe(true)
    expect(line.classList.contains('-bottom-px')).toBe(false)
  })

  it('keeps the outside ring and 32px tabs at sm', () => {
    render(<Tabs label="PR" value="a" items={tabs} size="sm" />)
    const tab = screen.getByRole('tab', { name: 'Changes' })
    expect(heights(tab)).toEqual(['h-8'])
    expect(tab.classList.contains('focus-visible:vy-focus-ring')).toBe(true)
  })
})
