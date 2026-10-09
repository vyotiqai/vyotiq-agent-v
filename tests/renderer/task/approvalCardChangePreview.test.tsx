/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { ApprovalCard } from '@renderer/features/task/record/ApprovalCard'

afterEach(() => {
  cleanup()
  window.vyotiq = undefined as unknown as typeof window.vyotiq
})

const base = { requestId: 'req-1', toolName: 'str_replace', summary: 'src/math.js', mutating: true }

describe('ApprovalCard — the change an edit asks for', () => {
  it('shows −/+ rows with signs and counts instead of the bare path', () => {
    // Seen 2026-10-09: "Needs you — change a file? src/math.js" and nothing more.
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const { container } = render(
      <ApprovalCard
        approval={{
          ...base,
          argsPreview: '{"path":"src/math.js","old_string":"return a - b","new_string":"return a + b"}',
          changePreview: {
            path: 'src/math.js',
            action: 'modify',
            add: 1,
            del: 1,
            hiddenLines: 0,
            lines: [
              { kind: '-', text: 'return a - b' },
              { kind: '+', text: 'return a + b' }
            ]
          }
        }}
        requestedAt={null}
      />
    )
    const block = container.querySelector('[data-approval-change]') as HTMLElement
    expect(block).toBeTruthy()
    expect(block.textContent).toContain('src/math.js')
    expect(block.textContent).toContain('+1')
    expect(block.textContent).toContain('−1')
    const rows = [...block.querySelectorAll('.diff-row-del, .diff-row-add')]
    expect(rows.map((r) => r.className.includes('diff-row-add') ? '+' : '-')).toEqual(['-', '+'])
    // Never hue alone: each changed row carries its sign.
    expect(rows[0]?.textContent).toContain('−')
    expect(rows[1]?.textContent).toContain('+')
  })

  it('names a new file and the rows it left out', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const { container } = render(
      <ApprovalCard
        approval={{
          ...base,
          toolName: 'edit',
          argsPreview: '{"path":"notes.md"}',
          changePreview: {
            path: 'notes.md',
            action: 'create',
            add: 230,
            del: 0,
            hiddenLines: 30,
            lines: [{ kind: '+', text: '# Notes' }]
          }
        }}
        requestedAt={null}
      />
    )
    const block = container.querySelector('[data-approval-change]') as HTMLElement
    expect(block.textContent).toContain('new file')
    expect(block.textContent).toContain('30 more lines not shown')
    // All additions: no wash on every row.
    expect(block.querySelector('.diff-row-add')).toBeNull()
  })

  it('keeps the path alone for an edit request from before previews', () => {
    window.vyotiq = { platform: 'win32' } as unknown as typeof window.vyotiq
    const { container } = render(
      <ApprovalCard approval={{ ...base, toolName: 'edit', argsPreview: '{"path":"a.ts"}' }} requestedAt={null} />
    )
    expect(container.querySelector('[data-approval-change]')).toBeNull()
    expect(container.querySelector('pre')?.textContent).toBe('a.ts')
  })
})
