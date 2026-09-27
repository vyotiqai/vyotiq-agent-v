/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { UiItem } from '@shared/transcript'
import { MarkdownContent } from '@renderer/lib/ui'
import { WorkItemView } from '@renderer/features/task/record/WorkItems'
import { CompactSummaryBlock } from '@renderer/features/chat/components/CompactSummaryBlock'
import type { WorkItem } from '@renderer/features/task/recordModel'

afterEach(cleanup)

type ToolItem = Extract<UiItem, { kind: 'tool' }>

function tool(name: string, status: 'ok' | 'fail', content: string, summary = ''): ToolItem {
  return { kind: 'tool', id: `t-${name}`, tool: { id: `t-${name}`, name, status, summary, content } } as ToolItem
}

describe('MarkdownContent size and tone', () => {
  it('puts exactly one size and one colour class on its root', () => {
    const { container } = render(<MarkdownContent content="Done." size="md" tone="strong" />)
    const root = container.querySelector('.markdown-body')!
    expect(root.classList.contains('text-md')).toBe(true)
    expect(root.classList.contains('text-fg-strong')).toBe(true)
    // cn() has no merge: the defaults must not ride along.
    expect(root.classList.contains('text-sm')).toBe(false)
    expect(root.classList.contains('text-fg')).toBe(false)
  })

  it('defaults to body size in the foreground colour', () => {
    const { container } = render(<MarkdownContent content="Note" />)
    const root = container.querySelector('.markdown-body')!
    expect(root.classList.contains('text-sm')).toBe(true)
    expect(root.classList.contains('text-fg')).toBe(true)
  })

  it('draws fenced code in the sunken well at a scale size', () => {
    const { container } = render(<MarkdownContent content={'```ts\nconst a = 1\n```'} />)
    // The copy chip also takes the well's colour; the shell is the one that scrolls.
    const shell = container.querySelector('.bg-sunken.overflow-x-auto')
    expect(shell).not.toBeNull()
    expect(shell!.classList.contains('text-xs')).toBe(true)
  })

  it('gives links a focus ring', () => {
    render(<MarkdownContent content="[docs](https://example.com)" />)
    expect(screen.getByRole('link', { name: 'docs' }).className).toContain('focus-visible:vy-focus-ring')
  })
})

describe('record notes', () => {
  it('render in the secondary tone on the markdown root itself', () => {
    const note = {
      kind: 'note',
      id: 'n1',
      text: 'Looking at the watcher next.',
      item: { kind: 'message', id: 'n1', role: 'assistant', content: 'Looking at the watcher next.' }
    } as WorkItem
    const { container } = render(<WorkItemView item={note} />)
    const root = container.querySelector('.markdown-body')!
    expect(root.classList.contains('text-secondary')).toBe(true)
    expect(root.classList.contains('text-fg')).toBe(false)
  })
})

describe('failed lookups', () => {
  it('say why they failed instead of "No matches"', () => {
    const failed = tool('grep', 'fail', 'Error: invalid regex "("\nat line 1', '(')
    const item = { kind: 'explore', id: 'e1', tools: [failed] } as WorkItem
    render(<WorkItemView item={item} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByText('Error: invalid regex "("')).toBeTruthy()
    expect(screen.queryByText('No matches')).toBeNull()
  })
})

describe('terminal card', () => {
  it('marks a failed exit with an icon, not a text glyph', () => {
    const run = tool('terminal', 'fail', 'boom', 'pnpm test')
    const item = { kind: 'card', id: 'c1', tool: run } as WorkItem
    const { container } = render(<WorkItemView item={item} />)
    expect(container.textContent).toContain('exit')
    expect(container.textContent).not.toContain('✕')
  })
})

describe('CompactSummaryBlock', () => {
  it('opens closed: only the live step is open in the record', () => {
    render(<CompactSummaryBlock summary={'Folded the first ten turns.'} tokenEstimate={1200} />)
    const toggle = screen.getByRole('button')
    expect(toggle.getAttribute('aria-expanded')).toBe('false')
    expect(toggle.className).toContain('focus-visible:vy-focus-ring')
    expect(toggle.className).not.toContain('hover:opacity')
    fireEvent.click(toggle)
    expect(toggle.getAttribute('aria-expanded')).toBe('true')
    const root = document.querySelector('[data-compact-summary] .markdown-body')!
    expect(root.classList.contains('text-secondary')).toBe(true)
  })
})
