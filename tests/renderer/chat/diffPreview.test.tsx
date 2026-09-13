/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  DIFF_MAX_EXPANDED_LINES,
  DiffPreview
} from '@renderer/features/chat/components/DiffPreview'
import type { DiffLine } from '@renderer/features/chat/toolUi'

const highlightToLines = vi.hoisted(() => vi.fn())

vi.mock('@renderer/lib/markdown/markdownHighlight', () => ({
  highlightToLines,
  languageFromPath: (path: string) => (path.endsWith('.ts') ? 'typescript' : null)
}))

/** Colour every line's whole text, so we can see which lines were sent where. */
function colorEachLine(source: string) {
  return source.split('\n').map((text) => [{ text, color: '#ff0000' }])
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

function line(kind: DiffLine['kind'], text: string, lineNumber: number | null = null): DiffLine {
  return { kind, text, lineNumber }
}

describe('DiffPreview', () => {
  it('renders the change without colour when no grammar matches the file', async () => {
    render(<DiffPreview lines={[line('add', 'hello', 1)]} path="notes.unknown" expanded />)

    expect(screen.getByText('hello')).toBeTruthy()
    await waitFor(() => expect(highlightToLines).not.toHaveBeenCalled())
  })

  it('colours lines once the grammar answers', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )
    render(<DiffPreview lines={[line('add', 'const a = 1', 1)]} path="a.ts" expanded />)

    await waitFor(() => {
      expect(screen.getByText('const a = 1')).toHaveProperty('style.color', 'rgb(255, 0, 0)')
    })
  })

  it('highlights each side of the change as its own document', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )

    render(
      <DiffPreview
        lines={[
          line('context', 'before', 1),
          line('del', 'gone'),
          line('add', 'added', 2),
          line('context', 'after', 3)
        ]}
        path="a.ts"
        expanded
      />
    )

    await waitFor(() => expect(highlightToLines).toHaveBeenCalledTimes(2))
    const documents = highlightToLines.mock.calls.map((call) => call[0])

    // The removed line never shares a document with the added one, so an
    // unbalanced quote on one side cannot bleed into the other.
    expect(documents).toContain('before\nadded\nafter')
    expect(documents).toContain('before\ngone\nafter')
  })

  it('only highlights the lines it renders while collapsed', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )
    const lines = Array.from({ length: 40 }, (_, index) =>
      line('add', `line ${index + 1}`, index + 1)
    )

    render(<DiffPreview lines={lines} path="a.ts" />)

    await waitFor(() => expect(highlightToLines).toHaveBeenCalled())
    const sent = highlightToLines.mock.calls[0]![0] as string
    expect(sent.split('\n')).toHaveLength(14)
    expect(sent.startsWith('line 1\n')).toBe(true)
    expect(screen.getByText('26 more lines')).toBeTruthy()
  })

  it('caps expanded rendering so huge diffs cannot flood the DOM', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )
    const lines = Array.from({ length: DIFF_MAX_EXPANDED_LINES + 100 }, (_, index) =>
      line('add', `line ${index + 1}`, index + 1)
    )

    render(<DiffPreview lines={lines} path="a.ts" expanded />)

    await waitFor(() => expect(highlightToLines).toHaveBeenCalled())
    expect(screen.getByText('line 1')).toBeTruthy()
    expect(screen.getByText(`line ${DIFF_MAX_EXPANDED_LINES}`)).toBeTruthy()
    expect(screen.queryByText(`line ${DIFF_MAX_EXPANDED_LINES + 1}`)).toBeNull()
    expect(screen.getByText('100 more lines')).toBeTruthy()
    // Highlight only the first chunk of visible lines.
    const sent = highlightToLines.mock.calls[0]![0] as string
    expect(sent.split('\n').length).toBeLessThanOrEqual(64)
  })

  it('renders expanded diffs without a nested scroll viewport', () => {
    const { container } = render(
      <DiffPreview
        lines={[line('add', 'hello', 1)]}
        path="notes.md"
        expanded
      />
    )
    expect(container.querySelector('[data-diff-preview="scroll"]')).toBeNull()
    expect(screen.getByText('hello')).toBeTruthy()
  })

  it('leaves gaps between hunks uncoloured and out of the document', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )

    render(
      <DiffPreview
        lines={[line('add', 'first', 1), line('gap', ''), line('add', 'second', 50)]}
        path="a.ts"
        expanded
      />
    )

    await waitFor(() => expect(highlightToLines).toHaveBeenCalled())
    expect(highlightToLines.mock.calls[0]![0]).toBe('first\nsecond')
  })

  it('marks add/del rows with a gutter sign so state is not hue-only', () => {
    const { container } = render(
      <DiffPreview
        lines={[line('add', 'added', 12), line('del', 'removed'), line('context', 'same', 13)]}
        path="notes.md"
        expanded
      />
    )

    // Sign + number render as one text node per row ("+12", "−", "13").
    expect(screen.getByText('+12')).toBeTruthy()
    expect(screen.getByText('13')).toBeTruthy()
    expect(container.querySelector('.diff-row-add')).toBeTruthy()
    expect(container.querySelector('.diff-row-del')).toBeTruthy()
    const gutter = screen.getByText('+12')
    expect(gutter.style.width).toMatch(/^\d+ch$/)
    // 2ch for digits + 1ch reserved for the add/del sign.
    expect(Number.parseInt(gutter.style.width, 10)).toBeGreaterThanOrEqual(3)
  })

  it('skips syntax highlight while followEnd is streaming, then highlights when settled', async () => {
    highlightToLines.mockImplementation((source: string) =>
      Promise.resolve(colorEachLine(source))
    )
    const lines = [line('add', 'const a = 1', 1)]
    const { rerender } = render(<DiffPreview lines={lines} path="a.ts" followEnd />)

    expect(screen.getByText('const a = 1')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(highlightToLines).not.toHaveBeenCalled()

    rerender(<DiffPreview lines={lines} path="a.ts" />)
    await waitFor(() => expect(highlightToLines).toHaveBeenCalled())
  })
})
