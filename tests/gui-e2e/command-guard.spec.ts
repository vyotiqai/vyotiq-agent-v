import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The command guard, end to end through the real gate and the real card:
 * "Always allow git push" is on record, yet `git push --force` still asks,
 * says what it would do, and offers no standing grant; a plain `git push`
 * then runs on that allow without asking.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-guard-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/command-guard.json' })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  const saved = await launched.window.evaluate(async () => {
    const current = await window.vyotiq.getSettings()
    if (!current.ok) return current
    return window.vyotiq.setSettings({
      toolApprovalOnboardingDone: true,
      toolApproval: { ...current.data.toolApproval, allowlist: ['terminal:git push'] }
    })
  })
  if (!saved.ok) throw new Error(saved.error)
  await launched.window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('a force push asks past a standing allow, with only Allow once and Deny', async () => {
  const page = launched.window
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Push the branch')
  await brief.press('Control+Enter')

  const danger = page.locator('[data-approval-danger]')
  await expect(danger).toHaveText(
    'Force-pushes, which rewrites history on the remote. Asks whatever the approval settings say.',
    { timeout: 30_000 }
  )
  await expect(page.getByText('git push --force origin main').first()).toBeVisible()
  await expect(page.getByRole('button', { name: 'Allow for this task' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Always allow/ })).toHaveCount(0)
  // The record's card; the navigator row offers the same answer.
  await page.locator('[data-needs-you]').getByRole('button', { name: 'Deny' }).click()

  // The plain push runs on the standing allow — no second card.
  await expect(page.getByText('Pushed without forcing.')).toBeVisible({ timeout: 30_000 })
  await expect(page.locator('[data-tool-approval]')).toHaveCount(0)

  // Nothing was remembered for the guarded command.
  const allowlist = await page.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data.toolApproval.allowlist : null
  })
  expect(allowlist).toEqual(['terminal:git push'])
})
