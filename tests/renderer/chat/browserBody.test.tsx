/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserSnapshotBody } from '@renderer/features/chat/toolUi/bodies/BrowserBody'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import { parseBrowserSnapshotData } from '@renderer/features/chat/toolUi/parsers/browser'
import type { UiToolRow } from '@shared/transcript'

function tool(overrides: Partial<UiToolRow> & Pick<UiToolRow, 'name'>): UiToolRow {
  return { id: 't1', summary: '', status: 'done', ...overrides }
}

describe('BrowserSnapshotBody', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        readRunArtifact: vi.fn().mockResolvedValue({ ok: false, error: 'none' })
      }
    })
  })

  afterEach(() => {
    cleanup()
  })

  it('shows capture-failed note without loading a fallback screenshot', async () => {
    const readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { exists: true, content: 'data:image/jpeg;base64,abc' }
    })
    window.vyotiq.readRunArtifact = readRunArtifact

    const snapshotTool = tool({
      name: 'browser_snapshot',
      content: 'URL: https://example.com\n[Screenshot capture failed: timeout]'
    })
    const parsed = parseBrowserSnapshotData(snapshotTool)
    expect(parsed.screenshotNote).toMatch(/capture failed/i)
    expect(parsed.screenshotPath).toBe('')

    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-1' }}>
        <BrowserSnapshotBody
          tool={snapshotTool}
          loading={false}
          loadFailed={false}
        />
      </RunSessionProvider>
    )

    await waitFor(() => {
      expect(screen.getByText(/capture failed/i)).toBeTruthy()
    })
    await waitFor(() => {
      expect(readRunArtifact).not.toHaveBeenCalled()
    })
  })

  it('replaces a broken saved screenshot with a readable fallback', async () => {
    window.vyotiq.readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { exists: true, content: 'data:image/jpeg;base64,not-a-real-image' }
    })
    const snapshotTool = tool({
      name: 'browser_snapshot',
      content: 'URL: https://example.com\n[Screenshot saved: run browser/snapshot.jpg]'
    })

    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-1' }}>
        <BrowserSnapshotBody tool={snapshotTool} loading={false} loadFailed={false} />
      </RunSessionProvider>
    )

    const image = await screen.findByAltText('Browser snapshot')
    fireEvent.error(image)

    await waitFor(() => {
      expect(screen.queryByAltText('Browser snapshot')).toBeNull()
      expect(screen.getByRole('status').textContent).toContain('Screenshot preview unavailable.')
    })
  })

  it('keeps refs and page text inside one bounded snapshot viewport', () => {
    const snapshotTool = tool({
      name: 'browser_snapshot',
      content: [
        'Interactive elements (use @eN with browser_click / browser_type):',
        '- @e1 link "Home" css="#home"',
        '',
        'Page text'
      ].join('\n')
    })

    const { container } = render(
      <RunSessionProvider value={{ workspacePath: null, runId: null }}>
        <BrowserSnapshotBody tool={snapshotTool} loading={false} loadFailed={false} />
      </RunSessionProvider>
    )

    expect(container.querySelectorAll('[data-browser-snapshot-scroll]')).toHaveLength(1)
  })

  it('does not repeat the navigation line when the URL chip already presents it', () => {
    const snapshotTool = tool({
      name: 'browser_search',
      content: [
        'Navigated to https://example.com',
        'URL: https://example.com',
        '',
        'Page text'
      ].join('\n')
    })

    render(
      <RunSessionProvider value={{ workspacePath: null, runId: null }}>
        <BrowserSnapshotBody tool={snapshotTool} loading={false} loadFailed={false} />
      </RunSessionProvider>
    )

    expect(screen.queryByText('Navigated to https://example.com')).toBeNull()
    expect(screen.getByText('Page text')).toBeTruthy()
  })
})
