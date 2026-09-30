import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * A task's navigator row says what it is doing and what it asks, against a
 * real run: main's live-run list carries the tool the run is in, the approval
 * its gate holds reaches the row as the command, and Allow once from the row
 * goes through that gate — the run carries on and finishes.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-navigator-live-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/navigator-live.json' })
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
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

test('a running row says what the task is doing, and a waiting one is answered from the row', async () => {
  const page = launched.window
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Run the suite and build')
  await brief.press('Control+Enter')

  const nav = page.locator('[data-navigator]')
  const row = nav.getByRole('button', { name: /^Run the suite and build/ })
  await expect(row.locator('[data-nav-activity]')).toHaveText('Running pnpm test --run', { timeout: 20_000 })

  // Waiting, the row says the command it would run and takes the answer.
  await expect(nav.locator('[data-nav-section="needs"]')).toContainText('Run the suite and build', { timeout: 30_000 })
  await expect(row.locator('[data-nav-ask]')).toContainText('pnpm build --filter nav-live', { timeout: 20_000 })
  await expect(row.locator('[data-nav-activity]')).toHaveCount(0)
  const decision = nav.getByRole('group', { name: /^Answer Run the suite and build/ })
  await decision.getByRole('button', { name: 'Allow once' }).click()

  await expect(page.getByText('NAV_LIVE_DONE the build passes.').first()).toBeVisible({ timeout: 20_000 })
  await expect(nav.locator('[data-nav-section="needs"]')).toHaveCount(0, { timeout: 20_000 })
  await expect(decision).toHaveCount(0)
  await expect(page.locator('[data-tool-approval]')).toHaveCount(0)
})
