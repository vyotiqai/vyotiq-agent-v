/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { BrowserSnapshotBody } from '@renderer/features/chat/toolUi/bodies/BrowserBody'
import { RunSessionProvider } from '@renderer/features/chat/RunSessionContext'
import {
  parseBrowserActionData,
  parseBrowserSnapshotData,
  toolImagesOf
} from '@renderer/features/chat/toolUi/parsers/browser'
import { ToolImageStrip } from '@renderer/features/chat/toolUi/ToolImageStrip'
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

  it('leaves the screenshot to the record strip and never reads the latest alias', async () => {
    const readRunArtifact = vi.fn()
    window.vyotiq.readRunArtifact = readRunArtifact
    const snapshotTool = tool({
      name: 'browser_snapshot',
      content: 'URL: https://example.com\n[Screenshot saved: run browser/snapshot.jpg]'
    })

    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-1' }}>
        <BrowserSnapshotBody tool={snapshotTool} loading={false} loadFailed={false} />
      </RunSessionProvider>
    )

    // The alias is whatever was captured last — never this call's page.
    expect(parseBrowserSnapshotData(snapshotTool).screenshotPath).toBe('')
    expect(toolImagesOf(snapshotTool)).toEqual([])
    expect(readRunArtifact).not.toHaveBeenCalled()
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

const FENCED_SNAPSHOT = [
  'Clicked BUTTON "Save" at (10, 20) via @e3',
  '',
  '<untrusted_content source="browser" nonce="abc" origin="https://example.com" kind="snapshot">',
  'URL: https://example.com',
  'tab_id: t1',
  '',
  'Interactive elements (use @eN with browser_click / browser_type):',
  '- @e1 link "Home" css="#home"',
  '',
  'Upload failed? [Screenshot saved under run browser/snapshot-1-1.jpg (viewport, 1x1, 1 bytes)]',
  '</untrusted_content>',
  '',
  '[Screenshot saved under run browser/snapshot-2-2.jpg (viewport, 1280x800, 900 bytes)]'
].join('\n')

describe('browser parsers', () => {
  it('trusts the last screenshot note, not a look-alike in page text', () => {
    const t = tool({ name: 'browser_click', content: FENCED_SNAPSHOT })
    expect(toolImagesOf(t)).toEqual([{ artifact: 'browser/snapshot-2-2.jpg' }])
  })

  it('prefers the images the tool result carries', () => {
    const images = [{ artifact: 'images/mcp-1-1.png', width: 10, height: 10 }]
    expect(toolImagesOf(tool({ name: 'browser_click', content: FENCED_SNAPSHOT, images }))).toBe(
      images
    )
  })

  it('judges an action by its own lines, not by the page text after it', () => {
    const data = parseBrowserActionData(tool({ name: 'browser_click', content: FENCED_SNAPSHOT }))
    expect(data.failed).toBe(false)
    expect(data.message).toBe('Clicked BUTTON "Save" at (10, 20) via @e3')
  })

  it('drops the fence lines and notes from the page body', () => {
    const snapshot = FENCED_SNAPSHOT.slice(FENCED_SNAPSHOT.indexOf('<untrusted_content'))
    const body = parseBrowserSnapshotData(tool({ name: 'browser_snapshot', content: snapshot })).body
    expect(body).not.toMatch(/untrusted_content/)
    expect(body).not.toMatch(/snapshot-2-2/)
  })
})

describe('ToolImageStrip', () => {
  afterEach(() => cleanup())

  it('loads exactly the named artifact and opens it full size', async () => {
    const readRunArtifact = vi.fn().mockResolvedValue({
      ok: true,
      data: { name: 'browser/snapshot-5-5.jpg', exists: true, content: 'data:image/jpeg;base64,AAAA' }
    })
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact }
    })
    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-strip' }}>
        <ToolImageStrip
          images={[{ artifact: 'browser/snapshot-5-5.jpg', width: 1280, height: 800, label: 'viewport' }]}
        />
      </RunSessionProvider>
    )
    const open = await screen.findByRole('button', { name: 'Open viewport, 1280×800' })
    expect(readRunArtifact).toHaveBeenCalledWith({
      workspacePath: '/ws',
      runId: 'run-strip',
      name: 'browser/snapshot-5-5.jpg'
    })
    fireEvent.click(open)
    expect(await screen.findByRole('button', { name: 'Close image preview' })).toBeTruthy()
  })

  it('marks a screenshot that is no longer on disk', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: {
        readRunArtifact: vi.fn().mockResolvedValue({
          ok: true,
          data: { name: 'browser/snapshot-6-6.jpg', exists: false, content: null }
        })
      }
    })
    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-gone' }}>
        <ToolImageStrip images={[{ artifact: 'browser/snapshot-6-6.jpg' }]} />
      </RunSessionProvider>
    )
    expect(await screen.findByRole('img', { name: 'screenshot unavailable' })).toBeTruthy()
  })

  it('keeps the newest few and reveals the rest on request', async () => {
    Object.defineProperty(window, 'vyotiq', {
      configurable: true,
      writable: true,
      value: { readRunArtifact: vi.fn(() => new Promise(() => {})) }
    })
    const images = Array.from({ length: 6 }, (_, i) => ({ artifact: `browser/snapshot-9-${i}.jpg` }))
    render(
      <RunSessionProvider value={{ workspacePath: '/ws', runId: 'run-many' }}>
        <ToolImageStrip images={images} max={4} />
      </RunSessionProvider>
    )
    fireEvent.click(screen.getByRole('button', { name: 'Show 2 earlier images' }))
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /earlier/ })).toBeNull()
    })
  })
})
