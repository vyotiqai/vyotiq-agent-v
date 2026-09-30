import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Below the desktop breakpoint the navigator is a drawer and a 56px rail
 * stands in its column: one glyph per task still in play, named for what it
 * is doing, and the places. Against a real run in a 900px window.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-navigator-rail-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/navigator-live.json' })
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 900, height: 760 })
  })
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('the rail holds the live task and the places, and the drawer the full list', async () => {
  const page = launched.window
  const rail = page.locator('[data-navigator-rail]')
  await expect(rail).toBeVisible({ timeout: 30_000 })
  expect((await rail.boundingBox())?.width).toBe(56)
  await expect(page.locator('[data-navigator]')).toHaveCount(0)

  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Run the suite and build')
  await brief.press('Control+Enter')

  const task = rail.getByRole('button', { name: 'Run the suite and build, Running pnpm test --run' })
  await expect(task).toBeVisible({ timeout: 20_000 })
  await expect(task).toHaveAttribute('aria-current', 'page')

  // A place, then back to the task from its glyph.
  await rail.getByRole('button', { name: 'Usage' }).click()
  await expect(rail.getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
  await expect(task).not.toHaveAttribute('aria-current', 'page')
  await task.click()
  await expect(page.getByRole('heading', { name: 'Run the suite and build', level: 1 })).toBeVisible({ timeout: 20_000 })

  // Waiting on you, the glyph moves to that group and says so.
  await expect(rail.locator('[data-rail-section="needs"]')).toBeVisible({ timeout: 30_000 })

  // The full list is the drawer.
  await page.locator('[data-navigator-toggle]').click()
  const drawer = page.getByRole('dialog', { name: 'Navigator' })
  await expect(drawer).toBeVisible()
  await expect(drawer.locator('[data-nav-section="needs"]')).toContainText('Run the suite and build')
  await page.keyboard.press('Escape')
  await expect(drawer).toBeHidden()
})
