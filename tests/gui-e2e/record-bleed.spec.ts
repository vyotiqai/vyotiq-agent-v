import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The Work fold's disclosure must not cut the record's right side.
 *
 * The work rows inside it bleed 8px into the column's gutter on each side
 * (`-mx-2` against the column's `px-4`), so a row's hover fill and card
 * borders end on the same edge the fold's own header does. The disclosure that
 * animates the fold's height used to clip both axes with its box sitting
 * exactly on the column's *content* edge: it squared off every row inside it
 * and cut the trailing 8px off the whole record — the right side of the
 * timeline ran short of the left. Only the animated axis may clip.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-record-bleed-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/record-polish.json' })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ skinId: 'default', theme: 'dark', showThinking: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** Run one replayed run, with the inspector out of the way, and open the work. */
async function driveRun(page: Page): Promise<void> {
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Run the suite and report')
  await brief.press('Control+Enter')
  // Step rows appear inside the fold while the run works.
  await expect(page.locator('[data-record-command]').first()).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-steps-run] > li').first()).toBeVisible({ timeout: 30_000 })
  const hide = page.getByRole('button', { name: /hide inspector|hide panel/i })
  if (await hide.count()) await hide.first().click()
}

test('the work fold lets its rows keep their gutter, on both sides', async () => {
  test.setTimeout(120_000)
  const page = launched.window

  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1440, height: 900 })
  })
  await driveRun(page)

  const geometry = await page.evaluate(() => {
    const column = document.querySelector('[data-record-scroll]')!.firstElementChild as HTMLElement
    const fold = document.querySelector('[data-work-fold]')
    const disclosure = fold?.querySelector('.tool-expand-inner') as HTMLElement | null
    const header = fold?.firstElementChild?.querySelector('button') as HTMLElement | null
    // A work row is the widest thing in the fold: it carries the 8px gutter bleed.
    const row = fold?.querySelector('[data-steps-run] > li') as HTMLElement | null
    if (!disclosure || !header || !row) return null
    const box = (el: HTMLElement) => {
      const b = el.getBoundingClientRect()
      return { left: Math.round(b.left), right: Math.round(b.right) }
    }
    const columnBox = box(column)
    return {
      column: columnBox,
      content: { left: columnBox.left + 16, right: columnBox.right - 16 },
      disclosure: box(disclosure),
      row: box(row),
      header: box(header),
      headerRightBleed: Math.round(header.getBoundingClientRect().right - (columnBox.right - 16)),
      rowRightBleed: Math.round(row.getBoundingClientRect().right - (columnBox.right - 16)),
      rowLeftBleed: Math.round(columnBox.left + 16 - row.getBoundingClientRect().left),
      overflowX: getComputedStyle(disclosure).overflowX,
      // The fold still hides its own height while closed.
      overflowY: getComputedStyle(disclosure).overflowY
    }
  })

  expect(geometry, 'the work fold rendered').not.toBeNull()
  const g = geometry!

  // The row does bleed past the column's content edge, on both sides alike.
  expect(g.rowLeftBleed).toBeGreaterThan(0)
  expect(g.rowRightBleed).toBeGreaterThan(0)
  // The fold's own header is the reference for that edge.
  expect(g.headerRightBleed).toBeGreaterThan(0)

  // The disclosure clips only the animated axis: it must not clip the gutter.
  expect(g.overflowX, 'the disclosure clipped the row gutter').not.toBe('hidden')
  expect(g.overflowX).not.toBe('clip')
  expect(g.overflowY).toBe('clip')

  // So every row still reaches the column's edge: nothing is cut off the right.
  expect(g.row.right).toBeLessThanOrEqual(g.column.right)
  expect(g.row.right).toBeGreaterThan(g.content.right)

  // And the fold's rows share one trailing edge with its header.
  expect(Math.abs(g.row.right - g.header.right)).toBeLessThanOrEqual(1)

  // The record must not become horizontally scrollable to show the gutter.
  const scroll = await page.evaluate(() => {
    const el = document.querySelector('[data-record-scroll]') as HTMLElement
    const pane = document.querySelector('[data-chat-pane-host]') as HTMLElement | null
    return {
      record: el.scrollWidth - el.clientWidth,
      pane: pane ? pane.scrollWidth - pane.clientWidth : 0,
      doc: document.documentElement.scrollWidth - document.documentElement.clientWidth
    }
  })
  expect(scroll.record).toBe(0)
  expect(scroll.pane).toBe(0)
  expect(scroll.doc).toBe(0)

  await page.screenshot({ path: test.info().outputPath('record-bleed.png') })
})

test('the fold still folds: closing it hides the work', async () => {
  test.setTimeout(120_000)
  const page = launched.window
  const fold = page.locator('[data-work-fold]')
  const header = fold.locator('div').first().locator('button').first()
  await expect(header).toBeVisible({ timeout: 30_000 })

  if ((await header.getAttribute('aria-expanded')) === 'true') {
    await header.click()
    // The work leaves the layout at once; the disclosure's closed state is
    // removed outright once the height has collapsed (useExpandMotion), so the
    // check is that nothing of it is left measuring.
    await expect(fold.locator('[data-steps-run] > li').first()).toBeHidden({ timeout: 10_000 })
    const closed = await page.evaluate(() => {
      const f = document.querySelector('[data-work-fold]')
      const wrap = f?.querySelector('.tool-expand') as HTMLElement | undefined
      return wrap ? Math.round(wrap.getBoundingClientRect().height) : 'unmounted'
    })
    expect(['unmounted', 0], `the closed fold collapses its disclosure, got ${closed}`).toContain(closed)

    await header.click()
    await expect(fold.locator('[data-steps-run] > li').first()).toBeVisible({ timeout: 10_000 })
  }
})
