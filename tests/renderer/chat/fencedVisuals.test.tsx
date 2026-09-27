/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { ChartBlock } from '@renderer/lib/ui/ChartBlock'
import { CodeBlockCopyButton } from '@renderer/lib/ui/CodeBlockCopyButton'
import { MarkdownContent } from '@renderer/lib/ui/MarkdownContent'
import { readMermaidThemeVariables } from '@renderer/lib/ui/MermaidDiagram'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg><g /></svg>' }))
}))
vi.mock('mermaid', () => ({ default: mermaidMock }))

afterEach(() => {
  cleanup()
  document.documentElement.style.removeProperty('--vy-surface')
  document.documentElement.style.removeProperty('--vy-muted')
})

describe('ChartBlock', () => {
  it('draws bars in the named greys with the peak in accent', () => {
    const { container } = render(
      <ChartBlock spec={{ type: 'bar', title: 'Runs', labels: ['a', 'b', 'c'], values: [2, 5, 0] }} />
    )
    const bars = [...container.querySelectorAll('[role="img"] > div > div')]
    expect(bars).toHaveLength(3)
    expect(bars[0]!.className).toContain('bg-border-strong')
    expect(bars[1]!.className).toContain('bg-accent')
    expect(bars[2]!.className).toContain('bg-border')
    expect(container.innerHTML).not.toMatch(/bg-accent\/\d/)
  })

  it('labels axes and title on the type scale', () => {
    const { container } = render(
      <ChartBlock spec={{ type: 'bar', title: 'Runs', labels: ['a', 'b'], values: [1, 2] }} />
    )
    expect(screen.getByText('Runs').className).toContain('uppercase')
    expect(container.innerHTML).not.toMatch(/text-3xs|text-2xs/)
    expect(screen.getByText('a').className).toContain('text-caption')
  })

  it('sizes donut text from the scale, not raw px', () => {
    const { container } = render(
      <ChartBlock spec={{ type: 'donut', labels: ['x', 'y'], values: [1, 3] }} />
    )
    for (const text of container.querySelectorAll('text')) {
      expect(text.getAttribute('font-size')).toBeNull()
      expect(text.getAttribute('style')).toContain('var(--text-caption)')
    }
  })
})

describe('CodeBlockCopyButton', () => {
  it('is a muted icon button on a well-coloured patch, with no shadow', () => {
    const { container } = render(<CodeBlockCopyButton text="x" />)
    const button = screen.getByRole('button', { name: 'Copy code' })
    expect(button.className).toContain('text-tertiary')
    expect(button.className).not.toMatch(/bg-bg|border-border/)
    expect(container.innerHTML).not.toContain('shadow')
    expect(container.firstElementChild!.className).toContain('bg-sunken')
  })
})

describe('MermaidDiagram theme', () => {
  it('builds mermaid colours from the active skin tokens', async () => {
    document.documentElement.style.setProperty('--vy-surface', '#123456')
    const content = ['```mermaid', 'graph TD; A-->B;', '```'].join('\n')
    const { container } = render(<MarkdownContent content={content} />)
    await waitFor(() => expect(container.querySelector('[data-mermaid-diagram]')).toBeTruthy())
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        theme: 'base',
        themeVariables: expect.objectContaining({ primaryColor: '#123456' })
      })
    )
    expect(container.querySelector('.bg-sunken')).toBeTruthy()
  })

  it('falls back when a token is not a colour mermaid can parse', () => {
    document.documentElement.style.setProperty('--vy-muted', 'color-mix(in srgb, red 50%, blue)')
    const vars = readMermaidThemeVariables(false)
    expect(String(vars.lineColor)).toMatch(/^#/)
  })
})
