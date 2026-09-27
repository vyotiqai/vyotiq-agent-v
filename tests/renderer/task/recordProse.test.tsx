/**
 * @vitest-environment jsdom
 */
import { StrictMode, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { RunSessionProvider, type RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import { WorkItemView } from '@renderer/features/task/record/WorkItems'
import { RecordProse } from '@renderer/features/task/record/RecordProse'
import { MarkdownContent } from '@renderer/lib/ui'
import type { WorkItem } from '@renderer/features/task/recordModel'

afterEach(cleanup)

function withSession(node: ReactNode, onOpenWorkspaceFile?: RunSessionValue['onOpenWorkspaceFile']) {
  return (
    <RunSessionProvider value={{ workspacePath: '/ws', runId: 'r1', onOpenWorkspaceFile }}>{node}</RunSessionProvider>
  )
}

function note(text: string): WorkItem {
  return {
    kind: 'note',
    id: 'n1',
    text,
    item: { kind: 'message', id: 'n1', role: 'assistant', content: text }
  } as WorkItem
}

describe('workspace paths in record prose', () => {
  it('opens a bare path with a line in the Files tab, at that line', () => {
    const open = vi.fn()
    render(withSession(<WorkItemView item={note('The bug is in src/main/watch.ts:42 — fixing it.')} />, open))
    fireEvent.click(screen.getByRole('button', { name: 'src/main/watch.ts:42' }))
    expect(open).toHaveBeenCalledWith('src/main/watch.ts', { line: 42 })
  })

  it('opens a backticked path in a Result without a line', () => {
    const open = vi.fn()
    render(withSession(<RecordProse text={'Changed `src/renderer/App.tsx`.'} size="md" tone="strong" />, open))
    fireEvent.click(screen.getByRole('button', { name: 'src/renderer/App.tsx' }))
    expect(open).toHaveBeenCalledWith('src/renderer/App.tsx', undefined)
  })

  it('leaves paths as text when nothing can open them', () => {
    render(withSession(<RecordProse text="See src/main/watch.ts:42." />))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('link')).toBeNull()
    expect(document.body.textContent).toContain('src/main/watch.ts:42')
  })
})

describe('heading anchors in record prose', () => {
  const toc = '- [Risks](#risks)\n\n## Summary\n\nDone.\n\n## Risks\n\nNone.'

  it('gives headings ids only when the text links to one of its own sections', () => {
    const { container: plain } = render(withSession(<RecordProse text={'## Summary\n\nDone.'} />))
    expect(plain.querySelector('h2')!.id).toBe('')
    cleanup()
    const { container } = render(withSession(<RecordProse text={toc} />))
    expect(container.querySelector('h2')!.id).not.toBe('')
  })

  it('scopes ids per body, so two notes with the same heading never collide', () => {
    const { container } = render(
      withSession(
        <>
          <RecordProse text={toc} />
          <RecordProse text={toc} />
        </>
      )
    )
    const ids = Array.from(container.querySelectorAll('h2')).map((h) => h.id)
    expect(ids).toHaveLength(4)
    expect(new Set(ids).size).toBe(4)
    expect(ids.every((id) => id.endsWith('-summary') || id.endsWith('-risks'))).toBe(true)
  })

  it('scrolls a table-of-contents link to the heading in its own body', () => {
    const scrolled: HTMLElement[] = []
    // jsdom has no scrollIntoView; stand one in for the test.
    const original = HTMLElement.prototype.scrollIntoView
    HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolled.push(this)
    }
    try {
      // A second body with the same heading must not be the one that answers.
      render(
        withSession(
          <>
            <RecordProse text={'## Risks\n\nOther note.\n\n[x](#risks)'} />
            <RecordProse text={toc} />
          </>
        )
      )
      const link = screen.getByRole('link', { name: 'Risks' })
      expect(link.getAttribute('target')).toBeNull()
      fireEvent.click(link)
      const tocBody = document.querySelectorAll('.markdown-body')[1]!
      expect(scrolled).toHaveLength(1)
      expect(scrolled[0]!.tagName).toBe('H2')
      expect(scrolled[0]!.textContent).toBe('Risks')
      expect(tocBody.contains(scrolled[0]!)).toBe(true)
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  it('keeps an id stable across StrictMode double renders', () => {
    const { container } = render(
      <StrictMode>
        <MarkdownContent content={'## Risks\n\n## Risks'} headingIds />
      </StrictMode>
    )
    expect(Array.from(container.querySelectorAll('h2')).map((h) => h.id)).toEqual(['risks', 'risks-1'])
  })
})
