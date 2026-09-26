/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'
import { useEffect } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'

afterEach(() => {
  cleanup()
})

function ConfirmHarness({ onResult, danger = false }: { onResult: (value: boolean) => void; danger?: boolean }) {
  const { confirm, dialog } = useConfirm()
  useEffect(() => {
    void confirm('The file leaves the workspace.', { title: 'Delete notes.md?', confirmLabel: 'Delete', danger }).then(
      onResult
    )
  }, [confirm, danger, onResult])
  return dialog
}

function PromptHarness({
  onResult,
  confirmLabel
}: {
  onResult: (value: string | null) => void
  confirmLabel?: string
}) {
  const { prompt, dialog } = usePrompt()
  useEffect(() => {
    void prompt('New file name', 'draft.md', confirmLabel ? { confirmLabel } : undefined).then(onResult)
  }, [confirmLabel, onResult, prompt])
  return dialog
}

describe('useConfirm', () => {
  it('titles the dialog, describes it with the message, and puts the actions in the footer row', async () => {
    const results: boolean[] = []
    render(<ConfirmHarness onResult={(v) => results.push(v)} />)
    const dialog = await screen.findByRole('dialog', { name: 'Delete notes.md?' })
    const message = screen.getByText('The file leaves the workspace.')
    expect(dialog.getAttribute('aria-describedby')).toBe(message.id)
    const confirm = screen.getByRole('button', { name: 'Delete' })
    const row = confirm.parentElement!
    expect(row.className).toMatch(/\bborder-t\b/)
    expect(row.contains(screen.getByRole('button', { name: 'Cancel' }))).toBe(true)
    expect(row.contains(message)).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(results).toEqual([true]))
  })

  it('resolves false on cancel', async () => {
    const results: boolean[] = []
    render(<ConfirmHarness onResult={(v) => results.push(v)} danger />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(results).toEqual([false]))
  })
})

describe('usePrompt', () => {
  it('shows the question as the title and asks in a small field', async () => {
    render(<PromptHarness onResult={() => undefined} />)
    expect(await screen.findByRole('heading', { name: 'New file name' })).toBeTruthy()
    const field = screen.getByRole('textbox', { name: 'Prompt input' })
    expect(field.classList.contains('h-7')).toBe(true)
    expect(field.className).not.toMatch(/outline-none/)
    expect(document.activeElement).toBe(field)
  })

  it('submits from the footer button, which lives outside the form', async () => {
    const results: Array<string | null> = []
    render(<PromptHarness onResult={(v) => results.push(v)} />)
    const field = await screen.findByRole('textbox', { name: 'Prompt input' })
    fireEvent.change(field, { target: { value: 'renamed.md' } })
    const ok = screen.getByRole('button', { name: 'OK' })
    expect(ok.closest('form')).toBeNull()
    fireEvent.click(ok)
    await waitFor(() => expect(results).toEqual(['renamed.md']))
  })

  it('submits on Enter and takes the caller’s verb', async () => {
    const results: Array<string | null> = []
    render(<PromptHarness onResult={(v) => results.push(v)} confirmLabel="Create" />)
    const field = await screen.findByRole('textbox', { name: 'Prompt input' })
    expect(screen.getByRole('button', { name: 'Create' })).toBeTruthy()
    act(() => {
      fireEvent.submit(field.closest('form')!)
    })
    await waitFor(() => expect(results).toEqual(['draft.md']))
  })

  it('resolves null on cancel', async () => {
    const results: Array<string | null> = []
    render(<PromptHarness onResult={(v) => results.push(v)} />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(results).toEqual([null]))
  })
})
