/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react'
import {
  RewindDialog,
  rewindRestoreCount,
  rewindSummary,
  rewoundToastText,
  useRewindDialog,
  type RewindFile
} from '@renderer/features/task/RewindDialog'

afterEach(cleanup)

const FILES: RewindFile[] = [
  { path: 'src/renderer/src/features/settings/sections/ShortcutsSection.tsx', action: 'modified', undoable: true },
  { path: 'src/renderer/src/features/home/components/SectionHeading.tsx', action: 'created', undoable: true },
  { path: 'src/renderer/src/lib/utils/layout.ts', action: 'modified', undoable: true, edited: true },
  { path: 'docs/old.md', action: 'deleted', undoable: true },
  { path: 'vendor/tree', action: 'deleted', undoable: false }
]

describe('RewindDialog', () => {
  it('asks about the run by its number and says what leaves the record', () => {
    render(<RewindDialog ask={{ runN: 2, files: FILES }} onCancel={() => {}} onConfirm={() => {}} />)
    const dialog = screen.getByRole('dialog', { name: 'Rewind to before run 2?' })
    expect(dialog.textContent).toContain(
      'Everything after run 2’s instruction leaves the record, and these files go back to how they were before it. It’s kept, so you can redo it until you send a new instruction or change those files.'
    )
    // Redo is real now (main keeps the rewound record and files), and says when it ends.
    expect(dialog.textContent).toContain('until you send a new instruction or change those files')
    expect(dialog.textContent).toContain('Your own edits since then are left alone.')
  })

  it('marks each file with what the task did, and names the ones it leaves', () => {
    render(<RewindDialog ask={{ runN: 2, files: FILES }} onCancel={() => {}} onConfirm={() => {}} />)
    const rows = within(screen.getByRole('list', { name: 'Files' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Msrc/renderer/src/features/settings/sections/ShortcutsSection.tsx',
      'Asrc/renderer/src/features/home/components/SectionHeading.tsx',
      'Msrc/renderer/src/lib/utils/layout.tschanged since · left as is',
      'Ddocs/old.md',
      'Dvendor/treeno copy kept · left as is'
    ])
    expect(rows[1]!.querySelector('[title]')?.getAttribute('title')).toBe('The task added it; rewinding removes it')
  })

  it('counts only the files it will put back on the button, and focuses Cancel', async () => {
    let confirmed = 0
    let cancelled = 0
    render(
      <RewindDialog
        ask={{ runN: 2, files: FILES }}
        onCancel={() => cancelled++}
        onConfirm={() => confirmed++}
      />
    )
    expect(rewindRestoreCount(FILES)).toBe(3)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
    fireEvent.click(screen.getByRole('button', { name: 'Rewind 3 files' }))
    expect(confirmed).toBe(1)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(cancelled).toBe(1)
  })

  it('says which files go back only partway, and counts only the ones that go all the way', () => {
    const files: RewindFile[] = [
      { path: 'a.txt', action: 'modified', undoable: true, edited: true, partway: true },
      { path: 'b.txt', action: 'modified', undoable: false, partway: true },
      { path: 'c.txt', action: 'created', undoable: true }
    ]
    render(<RewindDialog ask={{ runN: 1, files }} onCancel={() => {}} onConfirm={() => {}} />)
    const rows = within(screen.getByRole('list', { name: 'Files' })).getAllByRole('listitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      'Ma.txtchanged since · back partway',
      'Mb.txtno copy kept · back partway',
      'Ac.txt'
    ])
    expect(screen.getByRole('button', { name: 'Rewind 1 file' })).toBeTruthy()
    // A file that goes back partway still changes, so never "no files change".
    expect(rewindSummary({ runN: 1, files: files.slice(0, 2) })).toBe(
      'Everything after run 1’s instruction leaves the record, and no file goes all the way back. It’s kept, so you can redo it until you send a new instruction or change those files.'
    )
  })

  it('says no files change when the run changed none', () => {
    render(<RewindDialog ask={{ runN: 3, files: [] }} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.queryByRole('list', { name: 'Files' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Rewind' })).toBeTruthy()
    expect(rewindSummary({ runN: 3, files: [] })).toBe(
      'Everything after run 3’s instruction leaves the record, and no files change. It’s kept, so you can redo it until you send a new instruction or change those files.'
    )
  })

  it('claims no list when the preview could not be read', () => {
    expect(rewindSummary({ runN: null, files: null })).toBe(
      'Everything after this instruction leaves the record, and the files the task changed after it go back to how they were. It’s kept, so you can redo it until you send a new instruction or change those files.'
    )
    render(<RewindDialog ask={{ runN: null, files: null }} onCancel={() => {}} onConfirm={() => {}} />)
    expect(screen.getByRole('dialog', { name: 'Rewind to before this instruction?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Rewind' })).toBeTruthy()
  })
})

describe('useRewindDialog', () => {
  it('resolves true on Rewind and false on Escape', async () => {
    const { result } = renderHook(() => useRewindDialog())
    const view = render(<>{result.current.dialog}</>)
    let answer: Promise<boolean> | undefined
    act(() => {
      answer = result.current.askRewind({ runN: 2, files: FILES.slice(0, 1) })
    })
    view.rerender(<>{result.current.dialog}</>)
    fireEvent.click(screen.getByRole('button', { name: 'Rewind 1 file' }))
    await expect(answer).resolves.toBe(true)

    act(() => {
      answer = result.current.askRewind({ runN: 2, files: [] })
    })
    view.rerender(<>{result.current.dialog}</>)
    fireEvent.keyDown(window, { key: 'Escape' })
    await expect(answer).resolves.toBe(false)
  })
})

describe('rewoundToastText', () => {
  it('says which run, then what happened to each kind of file', () => {
    expect(rewoundToastText(2, { restored: ['a', 'b', 'c'], edited: ['d'], skipped: [] })).toBe(
      'Rewound to before run 2 · 3 files restored · 1 file left as you changed it'
    )
    expect(rewoundToastText(null, { restored: [], edited: [], skipped: ['x', 'y'] })).toBe(
      'Rewound to before the instruction · 2 files not restored'
    )
    expect(rewoundToastText(4, { restored: [], edited: [], skipped: [] })).toBe('Rewound to before run 4')
  })
})
