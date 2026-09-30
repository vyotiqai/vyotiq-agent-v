/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
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
