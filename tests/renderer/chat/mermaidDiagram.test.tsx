/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { MarkdownContent } from '@renderer/lib/ui/MarkdownContent'

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(async () => ({ svg: '<svg data-testid="rendered-svg"><g /></svg>' }))
}))

vi.mock('mermaid', () => ({ default: mermaidMock }))

const DIAGRAM_CONTENT = [
  'Plan body before.',
  '',
  '```mermaid',
  'graph TD; A[createPlan.ts] --> B[planQuality.ts];',
  '```',
  '',
  'Plan body after.'
].join('\n')

afterEach(() => {
  cleanup()
  mermaidMock.render.mockClear()
  mermaidMock.initialize.mockClear()
})

describe('MermaidDiagram in MarkdownContent', () => {
  it('renders a settled mermaid fence as an SVG diagram, not a code block', async () => {
    const { container } = render(<MarkdownContent content={DIAGRAM_CONTENT} />)
    await waitFor(() => {
      expect(container.querySelector('[data-mermaid-diagram]')).toBeTruthy()
    })
    expect(container.querySelector('[data-mermaid-failed]')).toBeNull()
    expect(container.querySelector('[data-testid="rendered-svg"]')).toBeTruthy()
    expect(container.querySelector('pre.language-mermaid')).toBeNull()
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({ securityLevel: 'strict', startOnLoad: false })
    )
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.any(String),
      'graph TD; A[createPlan.ts] --> B[planQuality.ts];'
    )
  })

  it('falls back to the plain code block when the diagram fails to parse', async () => {
    mermaidMock.render.mockRejectedValueOnce(new Error('Parse error'))
    const { container, getByText } = render(<MarkdownContent content={DIAGRAM_CONTENT} />)
    await waitFor(() => {
      expect(container.querySelector('[data-mermaid-failed]')).toBeTruthy()
    })
    expect(container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(getByText(/graph TD; A\[createPlan\.ts\]/)).toBeTruthy()
  })

  it('keeps a mid-stream (unclosed) mermaid fence as plain code', async () => {
    const unclosed = ['```mermaid', 'graph TD; A-->B;'].join('\n')
    const { container } = render(<MarkdownContent content={unclosed} streaming />)
    expect(container.querySelector('[data-mermaid-diagram]')).toBeNull()
    expect(container.querySelector('[data-mermaid-failed]')).toBeNull()
    expect(mermaidMock.render).not.toHaveBeenCalled()
    await waitFor(() => {
      expect(container.textContent).toContain('graph TD; A-->B;')
    })
  })
})
