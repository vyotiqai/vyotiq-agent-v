/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { ReadBody } from '@renderer/features/chat/toolUi/bodies/ReadBody'
import { READ_BODY_PREVIEW_LINES, TOOL_BODY_CLAMP_PX } from '@renderer/lib/utils/layout'

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
})
