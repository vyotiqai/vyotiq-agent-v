/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import { cleanup, render } from '@testing-library/react'
import { AGENT_V_SPINNER, AgentVSpinner } from '@renderer/lib/brand/AgentVSpinner'

afterEach(() => {
  cleanup()
})

const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')

describe('AgentVSpinner', () => {
  it('draws the mark as decoration, sized by its one prop', () => {
    const { container } = render(<AgentVSpinner size={11} className="text-fg" />)
    const svg = container.querySelector('svg')!
    expect(svg.getAttribute('aria-hidden')).toBe('true')
    expect(svg.getAttribute('role')).toBeNull()
    expect(svg.getAttribute('width')).toBe('11')
    expect(svg.classList.contains('vy-agv')).toBe(true)
    expect(svg.classList.contains(`vy-agv--${AGENT_V_SPINNER}`)).toBe(true)
    expect(svg.classList.contains('text-fg')).toBe(true)
    expect(svg.querySelectorAll('.vy-agv-f')).toHaveLength(3)
  })

  it('has motion in the stylesheet for the variant it renders, and only that one', () => {
    expect(css).toContain(`.vy-agv--${AGENT_V_SPINNER} .vy-agv-f {`)
    expect(css).toContain(`@keyframes vy-agv-${AGENT_V_SPINNER}`)
    const variants = new Set(Array.from(css.matchAll(/\.vy-agv--([a-z]+)/g), (m) => m[1]))
    expect([...variants]).toEqual([AGENT_V_SPINNER])
  })
})
