import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * A call waiting on you asks where it stopped the work: inside the step that
 * made it, after that step's work, through the real approval gate — not in a
 * block above the record.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-needs-step-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/needs-in-step.json' })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('the approval sits in its step, after the step’s work, and answering it carries the run on', async () => {
  const page = launched.window
  // A short window, so the step that asks sits below the record's first screen.
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1280, height: 560 })
  })
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Apply the migration')
  await brief.press('Control+Enter')

  const step = page.locator('[data-step="2"]')
  const card = step.locator('[data-needs-you]')
  await expect(card).toBeVisible({ timeout: 30_000 })
  await expect(card).toContainText('pnpm db:migrate --env staging')
  // Its arrival brings the card itself into view, not the top of the record.
  await expect(card).toBeInViewport({ ratio: 1 })
  // The card stands in for the call: the command once, and the agent's words
  // above it in the step, not repeated inside it.
  await expect(step.getByText('--env staging', { exact: false })).toHaveCount(1)
  await expect(step).not.toContainText('Waiting for approval')
  await expect(step).toContainText('NEEDS_WHY')
  await expect(card).not.toContainText('NEEDS_WHY')
  await expect(step).toHaveAttribute('data-step-state', 'needs')
  // One card, and only there: nothing waits above the brief or in the settled step.
  await expect(page.locator('[data-needs-you]')).toHaveCount(1)
  await expect(page.locator('[data-step="1"] [data-needs-you]')).toHaveCount(0)
  // After the step's own work.
  const order = await step.evaluate((li) => {
    const text = li.textContent ?? ''
    return { read: text.indexOf('Read'), why: text.indexOf('NEEDS_WHY'), card: text.indexOf('pnpm db:migrate') }
  })
  expect(order.read).toBeGreaterThanOrEqual(0)
  expect(order.read).toBeLessThan(order.why)
  expect(order.why).toBeLessThan(order.card)

  await card.getByRole('button', { name: 'Allow once' }).click()
  await expect(page.getByText('NEEDS_DONE the migration is applied.')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-needs-you]')).toHaveCount(0)
})
