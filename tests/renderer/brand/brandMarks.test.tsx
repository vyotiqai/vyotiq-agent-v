/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { VyotiqMark } from '@renderer/lib/brand'
import { VYOTIQ_MARK_PATHS, VYOTIQ_MARK_VIEW_BOX } from '@shared/brand/vyotiqMark'

describe('brand marks', () => {
  it('renders Vyotiq as an accessible image', () => {
    const { container } = render(<VyotiqMark size={24} />)
    const svg = container.querySelector('[data-brand-mark]')
    expect(svg).toBeTruthy()
    expect(svg?.getAttribute('role')).toBe('img')
    expect(svg?.getAttribute('aria-label')).toBe('Vyotiq')
    // Against the generated module, not a copy of it: this file used to pin a
    // literal, which is how the component's geometry drifted away from the kit
    // without anything failing.
    expect(svg?.getAttribute('viewBox')).toBe(VYOTIQ_MARK_VIEW_BOX)
    expect([...svg!.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual([
      ...VYOTIQ_MARK_PATHS
    ])
  })

  it('hides decorative Vyotiq from the accessibility tree', () => {
    const { container } = render(<VyotiqMark decorative />)
    const svg = container.querySelector('[data-brand-mark]')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('role')).toBeNull()
  })
})
