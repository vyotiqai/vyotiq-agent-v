import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * A command in the record while it runs, against a real run: the card counts
 * up, opens the Terminal tab, and once the run is stopped its last line offers
 * Resume, which carries the task on in a new turn.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-command-card-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/command-card.json' })
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.inspectorOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('a running command counts up, opens Terminal, and a stopped run resumes', async () => {
  const page = launched.window
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Run the parser tests')
  await brief.press('Control+Enter')

  const card = page.locator('[data-record-command]').filter({ hasText: 'pnpm vitest run parser' })
  await expect(card).toContainText('Running', { timeout: 20_000 })
  // The time sits where the finished one will, and moves.
  const time = card.locator('.w-12')
  await expect(time).toHaveText(/^\d+s$/, { timeout: 10_000 })
  const first = Number((await time.textContent())!.replace('s', ''))
  await expect.poll(async () => Number((await time.textContent())!.replace('s', '')), { timeout: 10_000 }).toBeGreaterThan(first)

  await card.getByRole('button', { name: 'Open in Terminal' }).click()
  const terminalTab = page.getByRole('tablist', { name: 'Inspector' }).getByRole('tab', { name: /^Terminal/ })
  await expect(terminalTab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
  await expect(page.locator('#dock-panel-terminal')).toBeVisible()

  await page.locator('[data-task-header]').getByRole('button', { name: /^stop$/i }).click()
  const receipt = page.locator('[data-receipt]').last()
  await expect(receipt.locator('[data-receipt-outcome="stopped"]')).toBeVisible({ timeout: 20_000 })
  // Nothing was written, so there is nothing to undo — only the way on.
  await expect(receipt.getByRole('button', { name: 'Undo its changes' })).toHaveCount(0)
  await expect(card.getByRole('button', { name: 'Open in Terminal' })).toHaveCount(0)

  await receipt.getByRole('button', { name: 'Resume' }).click()
  await expect(page.getByText('Continue from where you stopped.')).toBeVisible({ timeout: 20_000 })
  await expect(page.locator('[data-task-header] [data-task-state]')).toHaveAttribute('data-task-state', 'running', {
    timeout: 20_000
  })
})
