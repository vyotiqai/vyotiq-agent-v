/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { UpdateInfo } from '@shared/ipc'
import { parseReleaseNotes } from '@shared/utils/releaseNotes'
import {
  UpdatePanel,
  formatReleaseDay,
  restartLine,
  updateHeadlines
} from '@renderer/features/updates/UpdatePanel'
import { PENDING_NOTES_KEY, resetUpdaterStoreForTests, setUpdaterStateForTests } from '@renderer/features/updates/updaterStore'

afterEach(() => {
  cleanup()
  resetUpdaterStoreForTests()
  window.localStorage.clear()
  Reflect.deleteProperty(window, 'vyotiq')
})

/** The notes as main hands them over: the release body GitHub rendered, parsed. */
const notes = parseReleaseNotes(
  [
    '<p>A lede that is not an item.</p>',
    '<h2>Added</h2>',
    '<ul>',
    '<li><strong>Tasks can run instances in their own worktrees.</strong> Each gets a branch.</li>',
    '<li><strong>Agent-built tools, each call asked first.</strong> The card shows the code.</li>',
    '</ul>',
    '<h2>Fixed</h2>',
    '<ul>',
    '<li><strong>An honest record.</strong> Receipts, contracts and checks.</li>',
    '<li><strong>A fourth item.</strong> Not named in the panel.</li>',
    '</ul>'
  ].join('\n')
)

const INFO: UpdateInfo = {
  version: '1.1.0',
  releaseDate: '2026-09-22T10:00:00Z',
  releaseName: 'Vyotiq v1.1.0',
  notesText: notes.notesText,
  notesSections: notes.notesSections,
  releaseUrl: 'https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/v1.1.0'
}

function bridge(autoResumeInterruptedRuns: boolean) {
  const vyotiq = {
    getSettings: vi.fn(async () => ({ ok: true as const, data: { autoResumeInterruptedRuns } })),
    shellOpenExternal: vi.fn(async () => ({ ok: true as const, data: undefined })),
    updater: {
      download: vi.fn(async () => ({ ok: true as const, data: true })),
      install: vi.fn(async () => ({ ok: true as const, data: true }))
    }
  }
  Object.defineProperty(window, 'vyotiq', { value: vyotiq, configurable: true, writable: true })
  return vyotiq
}

describe('UpdatePanel', () => {
  it('names the version the way the app names itself, and the first three items by their lead', () => {
    bridge(true)
    render(<UpdatePanel info={INFO} status="downloaded" progress={null} />)
    expect(screen.getByText('Update ready')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Agent V 1.1.0' })).toBeTruthy()
    expect(screen.queryByText('Vyotiq v1.1.0')).toBeNull()
    expect([...document.querySelectorAll('[data-update-panel] li')].map((li) => li.textContent)).toEqual([
      '•Tasks can run instances in their own worktrees',
      '•Agent-built tools, each call asked first',
      '•An honest record'
    ])
    expect(screen.queryByText(/A fourth item/)).toBeNull()
  })

  it('offers the download, and only the download, while an update is available', () => {
    const vyotiq = bridge(true)
    render(<UpdatePanel info={INFO} status="available" progress={null} runningCount={2} />)
    expect(screen.getByText('Update available')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download update' }))
    expect(vyotiq.updater.download).toHaveBeenCalledTimes(1)
    expect(vyotiq.updater.install).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Restart and install/ })).toBeNull()
    // Nothing restarts yet, so nothing is said about running tasks.
    expect(screen.queryByText(/Running tasks/)).toBeNull()
    expect(vyotiq.getSettings).not.toHaveBeenCalled()
  })

  it('shows the download as it goes', () => {
    bridge(true)
    render(
      <UpdatePanel
        info={INFO}
        status="downloading"
        progress={{ percent: 42.4, transferred: 4.2 * 1024 * 1024, total: 10 * 1024 * 1024 }}
      />
    )
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('42')
    expect(screen.getByText('42% · 4.2 MB of 10.0 MB')).toBeTruthy()
  })

  it('restarts to install, handing the notes to What’s new', () => {
    const vyotiq = bridge(true)
    setUpdaterStateForTests({ status: 'downloaded', info: INFO })
    render(<UpdatePanel info={INFO} status="downloaded" progress={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Restart and install' }))
    expect(vyotiq.updater.install).toHaveBeenCalledTimes(1)
    expect(JSON.parse(window.localStorage.getItem(PENDING_NOTES_KEY) ?? '{}').notesSections).toEqual(INFO.notesSections)
  })

  it('says what a restart does to running tasks, as the resume setting has it', async () => {
    bridge(true)
    const { unmount } = render(<UpdatePanel info={INFO} status="downloaded" progress={null} runningCount={2} />)
    expect(await screen.findByText('Running tasks resume when you open them')).toBeTruthy()
    unmount()

    bridge(false)
    render(<UpdatePanel info={INFO} status="downloaded" progress={null} runningCount={1} />)
    expect(await screen.findByText('Running tasks can be continued after restart')).toBeTruthy()
  })

  it('says nothing about running tasks when none are running', async () => {
    const vyotiq = bridge(true)
    render(<UpdatePanel info={INFO} status="downloaded" progress={null} runningCount={0} />)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Release notes' })).toBeTruthy())
    expect(screen.queryByText(/Running tasks/)).toBeNull()
    expect(vyotiq.getSettings).not.toHaveBeenCalled()
  })

  it('opens the release page', () => {
    const vyotiq = bridge(true)
    render(<UpdatePanel info={INFO} status="available" progress={null} />)
    fireEvent.click(screen.getByRole('button', { name: 'Release notes' }))
    expect(vyotiq.shellOpenExternal).toHaveBeenCalledWith(INFO.releaseUrl)
  })

  it('shows prose notes when the release has no items', () => {
    bridge(true)
    render(
      <UpdatePanel info={{ ...INFO, notesSections: [], notesText: 'Just a paragraph.', releaseUrl: '' }} status="available" progress={null} />
    )
    expect(screen.getByText('Just a paragraph.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Release notes' })).toBeNull()
  })
})

describe('update panel helpers', () => {
  it('dates a release by day and month, with the year only when it is another year', () => {
    const now = new Date('2026-09-24T12:00:00Z')
    expect(formatReleaseDay('2026-09-22T10:00:00Z', now)).toBe(
      new Date('2026-09-22T10:00:00Z').toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
    )
    expect(formatReleaseDay('2025-12-30T10:00:00Z', now)).toContain('2025')
    expect(formatReleaseDay('not a date', now)).toBe('')
    expect(formatReleaseDay(undefined, now)).toBe('')
  })

  it('takes headlines across sections, in order', () => {
    expect(updateHeadlines(INFO, 4)).toEqual([
      'Tasks can run instances in their own worktrees',
      'Agent-built tools, each call asked first',
      'An honest record',
      'A fourth item'
    ])
  })

  it('says nothing about a restart until it knows the setting', () => {
    expect(restartLine(2, null)).toBeNull()
    expect(restartLine(0, true)).toBeNull()
  })
})
