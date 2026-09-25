import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { openSettings } from './helpers/settings'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * "Always allow" on a terminal approval, end to end through the real gate:
 * it remembers the command (`pnpm vitest`), not the terminal — the next
 * `pnpm vitest …` runs without asking, a chained command still asks and is
 * never offered Always, and Settings lists the command.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-allow-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/always-allow.json' })
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

test('Always allow remembers the command, and a chained command still asks', async () => {
  const page = launched.window
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Run the tests')
  await brief.press('Control+Enter')

  // The first command asks, and Always names the command it would remember.
  const always = page.getByRole('button', { name: 'Always allow pnpm vitest' })
  await expect(always).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('button', { name: 'Always allow terminal' })).toHaveCount(0)
  await always.click()

  // The second pnpm vitest runs without asking; the chained one asks — with no Always.
  const allowOnce = page.getByRole('button', { name: 'Allow once' })
  await expect(allowOnce).toBeVisible({ timeout: 30_000 })
  await expect(page.getByText('pnpm vitest run && rm -rf dist').first()).toBeVisible()
  await expect(page.getByRole('button', { name: /^Always allow/ })).toHaveCount(0)
  await allowOnce.click()
  await expect(page.getByText('All three ran.')).toBeVisible({ timeout: 30_000 })

  // Saved where a real run saves it: the command, not the tool.
  const allowlist = await page.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data.toolApproval.allowlist : null
  })
  expect(allowlist).toEqual(['terminal:pnpm vitest'])

  // Settings lists it as the command.
  await openSettings(page)
  const nav = page.getByRole('navigation', { name: 'Settings' }).first()
  await nav.getByRole('button', { name: 'Agent' }).click({ timeout: 20_000 })
  const row = page.locator('[data-settings-field="tool-approval-allowlist"]')
  await expect(row.getByRole('list', { name: 'Always allowed' })).toContainText('pnpm vitest', { timeout: 20_000 })
  await expect(row).toContainText('Commands and tools you allowed for good')
})
