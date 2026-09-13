/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ToolGroup } from '@renderer/features/chat/components/ToolGroup'
import { ReadBody } from '@renderer/features/chat/toolUi/bodies/ReadBody'
import { READ_BODY_PREVIEW_LINES, TOOL_BODY_CLAMP_PX } from '@renderer/lib/utils/layout'
import type { UiItem } from '@shared/transcript'

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {}
    })
  })
})

afterEach(() => {
  cleanup()
})

function longFileContent(lines: number): string {
  return Array.from({ length: lines }, (_, i) => `line-${i + 1}-content`).join('\n')
}

describe('read tool transcript presentation', () => {
  it('does not dump file source for a live lone read', () => {
    const tools: Extract<UiItem, { kind: 'tool' }>[] = [
      {
        kind: 'tool',
        id: 'r1',
        tool: {
          id: 'r1',
          name: 'read',
          summary: 'big.ts',
          status: 'done',
          content: longFileContent(40)
        }
      }
    ]
    render(<ToolGroup tools={tools} live />)
    expect(screen.getByText(/big\.ts/)).toBeTruthy()
    expect(screen.queryByText('line-1-content')).toBeNull()
    expect(screen.queryByText('line-40-content')).toBeNull()
    expect(screen.getByRole('button', { name: /Expand Read/i }).getAttribute('aria-expanded')).toBe(
      'false'
    )
  })

  it('clamps an expanded read to a short preview', () => {
    const content = longFileContent(40)
    render(
      <ReadBody
        tool={{
          id: 'r1',
          name: 'read',
          summary: 'big.ts',
          status: 'done',
          content
        }}
      />
    )

    expect(
      screen.getByText((_, el) => {
        return el?.tagName === 'SPAN' && el.textContent === `40 lines · showing ${READ_BODY_PREVIEW_LINES} · L1-40`
      })
    ).toBeTruthy()
    expect(screen.getByText('line-1-content')).toBeTruthy()
    expect(screen.getByText(`line-${READ_BODY_PREVIEW_LINES}-content`)).toBeTruthy()
    expect(screen.queryByText(`line-${READ_BODY_PREVIEW_LINES + 1}-content`)).toBeNull()
    expect(screen.queryByText('line-40-content')).toBeNull()

    const clamp = screen.getByTestId('read-body-clamp')
    expect(clamp.className).toMatch(/mask-fade-bottom/)
    expect(clamp.style.maxHeight).toBe(`${TOOL_BODY_CLAMP_PX}px`)
  })

  it('shows a failed read as an error caption, not a 1-line file slice', () => {
    const error = 'offset: offset/limit cannot be combined with startLine/endLine'
    const tools: Extract<UiItem, { kind: 'tool' }>[] = [
      {
        kind: 'tool',
        id: 'r1',
        tool: {
          id: 'r1',
          name: 'read',
          summary: 'package.json',
          status: 'fail',
          argsPreview: JSON.stringify({
            path: 'package.json',
            startLine: 1,
            endLine: 240,
            offset: 1,
            limit: 240
          }),
          content: error
        }
      }
    ]
    render(<ToolGroup tools={tools} />)
    expect(screen.getByText(error)).toBeTruthy()
    expect(screen.queryByText(/1 line/)).toBeNull()
    expect(screen.queryByText(/L1-240/)).toBeNull()
    expect(screen.queryByTestId('read-body-clamp')).toBeNull()
  })
})
