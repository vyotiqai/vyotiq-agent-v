/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type { ChartSpec } from '@shared/chartSpec'
import { ChartBlock } from '@renderer/lib/ui/ChartBlock'

afterEach(cleanup)

describe('ChartBlock', () => {
  it('renders bar charts with per-bar tooltips and honest gaps', () => {
    const spec: ChartSpec = {
      type: 'bar',
      title: 'Builds per day',
      labels: ['Mon', 'Tue', 'Wed'],
      values: [3, null, 5]
    }
    const { container } = render(<ChartBlock spec={spec} />)
    expect(screen.getByText('Builds per day')).toBeTruthy()
    expect(screen.getByTitle('Mon — 3')).toBeTruthy()
    expect(screen.getByTitle('Wed — 5')).toBeTruthy()
    // The missing day is a gap — no bar, no fake zero, no tooltip.
    expect(screen.queryByTitle('Tue — 0')).toBeNull()
    expect(container.querySelectorAll('[data-chart-block]')).toHaveLength(1)
  })

  it('renders a zero as a baseline stub, not a bar', () => {
    const spec: ChartSpec = { type: 'bar', labels: ['A', 'B'], values: [0, 4] }
    render(<ChartBlock spec={spec} />)
    expect(screen.queryByTitle('A — 0')).toBeNull()
    expect(screen.getByTitle('B — 4')).toBeTruthy()
  })

  it('renders donut legends with value and share', () => {
    const spec: ChartSpec = { type: 'donut', labels: ['Alpha', 'Beta'], values: [2, 1] }
    render(<ChartBlock spec={spec} />)
    expect(screen.getByText('Alpha')).toBeTruthy()
    expect(screen.getByText('2 · 67%')).toBeTruthy()
    expect(screen.getByText('1 · 33%')).toBeTruthy()
  })

  it('renders line charts as an svg with a labeled axis', () => {
    const spec: ChartSpec = { type: 'line', labels: ['Mon', 'Tue'], values: [1, 2] }
    const { container } = render(<ChartBlock spec={spec} />)
    expect(screen.getByRole('img', { name: 'Line chart with 2 points' })).toBeTruthy()
    expect(container.querySelector('svg')).toBeTruthy()
    expect(screen.getByTitle('Tue — 2')).toBeTruthy()
  })

  it('renders sparklines without an axis', () => {
    const spec: ChartSpec = { type: 'sparkline', values: [1, 2, null, 4] }
    const { container } = render(<ChartBlock spec={spec} />)
    expect(screen.getByRole('img', { name: 'Sparkline' })).toBeTruthy()
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('shows a quiet note when a spec carries no measurable data', () => {
    const spec: ChartSpec = { type: 'line', labels: ['Mon'], values: [null] }
    render(<ChartBlock spec={spec} />)
    expect(screen.getByText('No data points in this chart.')).toBeTruthy()
  })
})
