/**
 * @vitest-environment jsdom
 *
 * The row label and its hover actions share one line. These pin the contract
 * that keeps them apart: the strip never grows past the gutter the row holds
 * open, so the truncated title can't end up underneath the icons.
 */
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { ChatRow } from '@renderer/app/sidebar/ChatRow'
import { SIDEBAR_ROW_ACTIONS_RESERVE } from '@renderer/lib/utils/layout'
import type { RunSummary } from '@shared/ipc'

const run: RunSummary = {
  runId: 'run-1',
  goal: 'List files',
  status: 'idle',
  createdAt: Date.now(),
  updatedAt: Date.now()
}

const noop = (): void => {}

/** Every optional action wired up — the widest the strip could ever get. */
function renderRow(overrides: Partial<Parameters<typeof ChatRow>[0]> = {}) {
  return render(
    <ChatRow
      run={run}
      workspacePath="/ws/home"
      active={false}
      onSelectRun={noop}
      onRenameRun={noop}
      onDeleteRun={noop}
      onExportRun={noop}
      onCopyRunLink={noop}
      onForkRun={noop}
      {...overrides}
    />
  )
}

/** Widest cluster the strip renders: two `size-6` buttons + `gap-px`. */
const STRIP_MAX_BUTTONS = 2

describe('ChatRow hover actions', () => {
  it('keeps the strip to two buttons however many actions are wired up', () => {
    renderRow()
    const row = screen.getByRole('button', { name: 'List files' })
    const strip = row.closest('[role="listitem"]')!.querySelector('.absolute')!
    expect(within(strip as HTMLElement).getAllByRole('button')).toHaveLength(
      STRIP_MAX_BUTTONS
    )
  })

  it('reserves the gutter the strip occupies so the title truncates clear of it', () => {
    renderRow()
    const row = screen.getByRole('button', { name: 'List files' })
    for (const cls of SIDEBAR_ROW_ACTIONS_RESERVE.split(' ')) {
      expect(row.className).toContain(cls)
    }
  })

  it('offers the overflow actions from the ⋯ menu', () => {
    const onExportRun = vi.fn()
    const onCopyRunLink = vi.fn()
    const onForkRun = vi.fn()
    renderRow({ onExportRun, onCopyRunLink, onForkRun })

    fireEvent.click(screen.getByRole('button', { name: 'More actions for List files' }))
    const menu = screen.getByRole('menu', { name: 'Actions for List files' })
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual(['Rename', 'Fork chat', 'Export as Markdown', 'Copy link', 'Delete'])

    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Export as Markdown' }))
    expect(onExportRun).toHaveBeenCalledWith('/ws/home', 'run-1')
  })

  it('omits menu items for actions the parent did not wire up', () => {
    renderRow({ onExportRun: undefined, onCopyRunLink: undefined, onForkRun: undefined })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for List files' }))
    expect(
      within(screen.getByRole('menu'))
        .getAllByRole('menuitem')
        .map((item) => item.getAttribute('aria-label'))
    ).toEqual(['Rename', 'Delete'])
  })

  it('opens the same menu on right-click without selecting the row', () => {
    const onSelectRun = vi.fn()
    renderRow({ onSelectRun })
    fireEvent.contextMenu(screen.getByRole('button', { name: 'List files' }))
    expect(screen.getByRole('menu', { name: 'Actions for List files' })).toBeTruthy()
    expect(onSelectRun).not.toHaveBeenCalled()
  })

  it('routes menu delete through the inline confirm rather than deleting outright', () => {
    const onDeleteRun = vi.fn()
    renderRow({ onDeleteRun })
    fireEvent.click(screen.getByRole('button', { name: 'More actions for List files' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }))
    expect(onDeleteRun).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Confirm delete List files' }))
    expect(onDeleteRun).toHaveBeenCalledWith('/ws/home', 'run-1')
  })
})
