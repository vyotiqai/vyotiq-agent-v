import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Save as draft, end to end: the brief, its check, main's drafts.json, the
 * navigator's Drafts group after a reload, continuing it on New task, and the
 * draft gone — from the navigator and from disk — once its task starts.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-drafts-ws-'))
  launched = await launchApp({ e2eFixture: true })
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

test('a draft is saved, survives a reload, continues on New task and is spent by starting', async () => {
  const page = launched.window
  const drafts = (): Promise<Array<{ brief: string; doneWhen: string[] }>> =>
    page.evaluate(async (path) => {
      const res = await window.vyotiq.listTaskDrafts(path)
      return res.ok ? res.data.drafts.map((d) => ({ brief: d.brief, doneWhen: d.doneWhen })) : []
    }, workspacePath)

  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Tidy the release notes parser')
  await page.getByRole('button', { name: 'Add a check' }).click()
  await page.getByRole('textbox', { name: 'New check' }).fill('The parser tests pass')
  await page.getByRole('textbox', { name: 'New check' }).press('Enter')
  await page.getByRole('button', { name: 'Save as draft' }).click()

  await expect(brief).toHaveText('')
  await expect.poll(drafts).toEqual([{ brief: 'Tidy the release notes parser', doneWhen: ['The parser tests pass'] }])
  const row = page.locator('[data-nav-section="drafts"]').getByRole('button', { name: 'Tidy the release notes parser' })
  await expect(row).toBeVisible()

  // Kept by main, not the window.
  await page.reload()
  await page.waitForLoadState('domcontentloaded')
  await expect(row).toBeVisible({ timeout: 30_000 })

  await row.click()
  await expect(brief).toHaveText('Tidy the release notes parser', { timeout: 20_000 })
  await expect(page.getByRole('list', { name: 'Done when' })).toContainText('The parser tests pass')
  await expect(page.getByRole('button', { name: 'Update draft' })).toBeVisible()

  await brief.press('Control+Enter')
  await expect(page.getByText('E2E fixture response.')).toBeVisible({ timeout: 20_000 })
  await expect.poll(drafts).toEqual([])
  await expect(page.locator('[data-nav-section="drafts"]')).toHaveCount(0)
})
