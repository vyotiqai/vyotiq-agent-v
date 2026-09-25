/**
 * The 36px band across the top of the window: the mark and navigator toggle,
 * the search trigger, and the caption buttons — nothing else. Nothing portals
 * into it and no surface below claims it.
 *
 * Two separate things decide whether a click in the band lands, and class
 * assertions catch neither:
 *
 *  1. the DOM hit test — what `elementFromPoint` returns at a control's centre;
 *  2. Electron's draggable region — `-webkit-app-region: drag` is resolved at
 *     the window level, before the renderer sees the event at all.
 *
 * This spec drives the real Electron window and asks the page what is on top
 * and which region it computes, then clicks the controls for real.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData, seedWorkspacesRegistry } from './helpers/seedWorkspace'

let launched: LaunchedApp
const workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-band-'))

/** macOS keeps native traffic lights; the app draws no caption strip there. */
const NO_IN_APP_CAPTION_BUTTONS = process.platform === 'darwin'

test.beforeAll(async () => {
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, workspacePath, [{ runId: 'run-band', goal: 'Band task' }])
      seedWorkspacesRegistry(userDataDir, workspacePath, 'run-band')
    }
  })
  await launched.window.locator('[data-titlebar]').waitFor({ timeout: 20_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

async function centerOf(selector: string): Promise<{ x: number; y: number }> {
  const box = await launched.window.locator(selector).first().boundingBox()
  if (!box) throw new Error(`no box for ${selector}`)
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

/** The element a click at (x, y) reaches, and the drag region computed there. */
async function probe(x: number, y: number): Promise<{ inside: string; region: string }> {
  return launched.window.evaluate(
    ([px, py]: number[]) => {
      const el = document.elementFromPoint(px!, py!) as HTMLElement | null
      if (!el) return { inside: 'none', region: 'none' }
      const inside = el.closest('[data-titlebar-controls]')
        ? 'caption'
        : el.closest('[data-search-trigger]')
          ? 'search'
          : el.closest('[data-navigator-toggle]')
            ? 'toggle'
            : el.closest('[data-titlebar]')
              ? 'band'
              : 'content'
      let region = 'none'
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        const value = getComputedStyle(node).getPropertyValue('-webkit-app-region').trim()
        if (value === 'drag' || value === 'no-drag') {
          region = value
          break
        }
      }
      return { inside, region }
    },
    [x, y]
  )
}

test('the band spans the whole window, over the navigator too', async () => {
  const { window } = launched
  const band = await window.locator('[data-titlebar]').boundingBox()
  // Electron pages report no Playwright viewport; ask the page itself.
  const width = await window.evaluate(() => window.innerWidth)
  expect(band?.x).toBe(0)
  expect(band?.height).toBe(36)
  expect(Math.round(band?.width ?? 0)).toBe(width)
  const nav = await window.locator('[data-navigator]').boundingBox()
  expect(nav?.y ?? 0).toBeGreaterThanOrEqual(36)
})

test('its empty stretches drag the window', async () => {
  const brand = await launched.window.locator('[data-titlebar-brand]').boundingBox()
  // Between the "Agent V" label and the toggle.
  const hit = await probe((brand?.x ?? 0) + (brand?.width ?? 0) - 60, 18)
  expect(hit).toEqual({ inside: 'band', region: 'drag' })
})

test('the search trigger is on top of its own box and opens search', async () => {
  const { window } = launched
  const c = await centerOf('[data-search-trigger]')
  expect(await probe(c.x, c.y)).toEqual({ inside: 'search', region: 'no-drag' })
  await window.mouse.click(c.x, c.y)
  await expect(window.getByRole('dialog', { name: 'Search and commands' })).toBeVisible({ timeout: 5_000 })
  await window.keyboard.press('Escape')
  await expect(window.getByRole('dialog', { name: 'Search and commands' })).toHaveCount(0)
})

test('the navigator toggle is on top of its own box and hides the navigator', async () => {
  const { window } = launched
  const c = await centerOf('[data-navigator-toggle]')
  expect(await probe(c.x, c.y)).toEqual({ inside: 'toggle', region: 'no-drag' })
  await window.mouse.click(c.x, c.y)
  await expect(window.locator('[data-navigator]')).toHaveCount(0)
  const again = await centerOf('[data-navigator-toggle]')
  await window.mouse.click(again.x, again.y)
  await expect(window.locator('[data-navigator]')).toBeVisible()
})

test('the caption buttons are the topmost thing at their own coordinates', async () => {
  test.skip(NO_IN_APP_CAPTION_BUTTONS, 'macOS draws native traffic lights')
  for (const name of ['Minimize', 'Maximize', 'Close']) {
    const box = await launched.window.getByRole('button', { name, exact: true }).boundingBox()
    expect(box, name).toBeTruthy()
    expect(Math.round(box!.width)).toBe(46)
    const hit = await probe(box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(hit, name).toEqual({ inside: 'caption', region: 'no-drag' })
  }
})

test('nothing below the band reaches into it', async () => {
  const { window } = launched
  // Open the task, then a panel: neither the pane nor the panel tabs may draw
  // into the band any more.
  await window.getByRole('button', { name: 'Band task', exact: true }).click()
  const main = await window.locator('#main-content').boundingBox()
  expect(main?.y ?? 0).toBeGreaterThanOrEqual(36)
  const hit = await probe((main?.x ?? 0) + 40, 18)
  expect(hit.inside).toBe('band')
})
