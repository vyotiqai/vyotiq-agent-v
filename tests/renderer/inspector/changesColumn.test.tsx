/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ChangesColumn } from '@renderer/features/inspector/ChangesColumn'
import type { ChangesListFile } from '@renderer/features/inspector/ChangesList'

afterEach(cleanup)

const FILES: ChangesListFile[] = [
  { path: 'src/a.ts', status: 'M', added: 1, removed: 0 },
  { path: 'src/b.ts', status: 'M', added: 2, removed: 1 }
]

function Column({ reveal }: { reveal: { path: string; token: number } }) {
  const [selected, setSelected] = useState<string | null>(reveal.path)
  return (
    <ChangesColumn
      files={FILES}
      selectedPath={selected}
      revealToken={reveal.token}
      onSelect={setSelected}
      source={() => ({ lines: [] })}
      layout="unified"
      wordWrap={false}
      findQuery=""
    />
  )
}

const header = (path: string): HTMLElement => screen.getByRole('button', { name: `${path}, modified` })

describe('ChangesColumn', () => {
  it('opens the file a reveal was for, and leaves a later click on another file to fold it', () => {
    const { rerender } = render(<Column reveal={{ path: 'src/a.ts', token: 0 }} />)
    fireEvent.click(header('src/a.ts'))
    expect(header('src/a.ts').getAttribute('aria-expanded')).toBe('false')
    // Open in Changes, for a: it unfolds again.
    rerender(<Column reveal={{ path: 'src/a.ts', token: 1 }} />)
    expect(header('src/a.ts').getAttribute('aria-expanded')).toBe('true')
    // Folding b selects it; the reveal was a's, so b stays folded.
    fireEvent.click(header('src/b.ts'))
    expect(header('src/b.ts').getAttribute('aria-expanded')).toBe('false')
  })
})

describe('a file with no diff to show', () => {
  it('says why on its row instead of opening onto an empty body', async () => {
    render(
      <ChangesColumn
        files={[{ path: 'shots/f1.png', status: 'A' }]}
        selectedPath={null}
        revealToken={0}
        onSelect={() => undefined}
        source={() => ({ fetchDiff: async () => ({ error: 'Binary or too large to diff' }) })}
        layout="unified"
        wordWrap={false}
        findQuery=""
      />
    )
    await waitFor(() => expect(document.querySelector('[data-change-flat]')?.textContent).toBe('Binary or large'))
    expect(document.querySelector('[data-change-diff="shots/f1.png"]')).toBeNull()
    expect(screen.getByRole('button', { name: 'shots/f1.png, added' }).getAttribute('aria-expanded')).toBeNull()
  })
})
