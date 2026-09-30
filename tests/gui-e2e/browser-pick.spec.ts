import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData, seedWorkspacesRegistry } from './helpers/seedWorkspace'

/**
 * The Browser tab's element picker: pick a button on a real page with the
 * mouse and with the keyboard, and find it as a chip in the task's composer.
 * The page is a native view Playwright cannot drive, so input reaches it the
 * way a user's does — through its WebContents — from the main process.
 */

let launched: LaunchedApp
let workspacePath: string
let server: Server
let pageUrl = ''

const RUN_ID = 'browser-pick-run'

const PAGE = `<!doctype html><html><head><title>Pick fixture</title>
<style>body{margin:0;font:16px sans-serif} #signin{position:absolute;left:40px;top:40px;width:160px;height:48px}</style>
</head><body><main><button id="signin" aria-label="Sign in">Sign in</button><p id="copy">Plans start free</p></main></body></html>`

async function pageContents(window: Page): Promise<void> {
  await expect
    .poll(
      () =>
        launched.app.evaluate(
          ({ webContents }, url) => webContents.getAllWebContents().some((wc) => wc.getURL() === url),
          pageUrl
        ),
      { timeout: 20_000 }
    )
    .toBe(true)
  await expect(window.locator('[data-agent-browser-panel] [data-browser-address]')).toBeVisible()
}

/** Input to the browsed page, as the OS would deliver it. */
async function sendToPage(events: Array<Record<string, unknown>>): Promise<void> {
  await launched.app.evaluate(
    async ({ webContents }, { url, events }) => {
      const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
      if (!wc) throw new Error('page not found')
      for (const event of events) {
        wc.sendInputEvent(event as unknown as Parameters<typeof wc.sendInputEvent>[0])
        await new Promise((r) => setTimeout(r, 40))
      }
    },
    { url: pageUrl, events }
  )
}

test.beforeAll(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  pageUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-browser-pick-gui-'))
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, workspacePath, [{ runId: RUN_ID, goal: 'Check the login page' }])
      seedWorkspacesRegistry(userDataDir, workspacePath, null)
    }
  })
  const { window } = launched
  await window.getByRole('button', { name: 'Check the login page', exact: true }).click({ timeout: 20_000 })
  await expect(window.locator('[data-inspector]')).toBeVisible({ timeout: 20_000 })
  await window.keyboard.press('Alt+4')
  await expect(window.locator('#dock-panel-browser')).toBeVisible({ timeout: 20_000 })
  const address = window.getByRole('textbox', { name: 'Search or enter URL' })
  await address.fill(pageUrl)
  await address.press('Enter')
  await pageContents(window)
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

test('a clicked element lands in the composer as a chip; Esc stops picking', async () => {
  const { window } = launched
  const pick = window.locator('[data-browser-pick]')
  await expect(pick).toHaveAccessibleName('Pick an element to ask about')
  await pick.click()
  await expect(window.locator('[data-browser-picking]')).toBeVisible()
  await expect(pick).toHaveAttribute('aria-pressed', 'true')

  await sendToPage([
    { type: 'mouseMove', x: 100, y: 60 },
    { type: 'mouseDown', x: 100, y: 60, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 100, y: 60, button: 'left', clickCount: 1 }
  ])

  const chip = window.locator('[data-mention-kind="element"]').first()
  await expect(chip).toHaveText('<button> "Sign in"', { timeout: 10_000 })
  await expect(window.locator('[data-browser-picking]')).toContainText('Added <button> "Sign in"')
  // The inspect overlay took the click: the page never saw it.
  const clicked = await launched.app.evaluate(async ({ webContents }, url) => {
    const wc = webContents.getAllWebContents().find((c) => c.getURL() === url)
    return wc?.executeJavaScript('document.activeElement && document.activeElement.id')
  }, pageUrl)
  expect(clicked).not.toBe('signin')

  await sendToPage([{ type: 'keyDown', keyCode: 'Escape' }, { type: 'keyUp', keyCode: 'Escape' }])
  await expect(window.locator('[data-browser-picking]')).toHaveCount(0)
  await expect(pick).toHaveAccessibleName('Pick an element to ask about')
})

test('the keyboard walks the page and Enter picks', async () => {
  const { window } = launched
  const pick = window.locator('[data-browser-pick]')
  await pick.focus()
  await window.keyboard.press('Enter')
  await expect(window.locator('[data-browser-picking]')).toBeVisible()

  // Tab moves the page's focus to the button and the outline follows it;
  // Up walks to <main>, Enter adds it.
  await sendToPage([
    { type: 'keyDown', keyCode: 'Tab' },
    { type: 'keyUp', keyCode: 'Tab' },
    { type: 'keyDown', keyCode: 'Up' },
    { type: 'keyUp', keyCode: 'Up' },
    { type: 'keyDown', keyCode: 'Return' },
    { type: 'keyUp', keyCode: 'Return' }
  ])
  await expect(window.locator('[data-mention-kind="element"]').filter({ hasText: '<main>' })).toHaveCount(1, {
    timeout: 10_000
  })

  // The toolbar button stops it too.
  await pick.click()
  await expect(window.locator('[data-browser-picking]')).toHaveCount(0)
})
