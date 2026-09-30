import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The result says what the run changed, file by file, against a real run: the
 * replayed edit lands, the answer arrives, and its file opens in Changes.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-result-files-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/result-files.json' })
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

test('the result lists the file the run changed, and it opens in Changes', async () => {
  const page = launched.window
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Update the stream')
  await brief.press('Control+Enter')

  const files = page.getByRole('list', { name: 'Files changed' })
  await expect(files).toBeVisible({ timeout: 30_000 })
  await expect(files.getByRole('listitem')).toHaveCount(1)
  // One line removed, five added, as the diff says.
  await expect(files).toContainText('src/live-stream.ts')
  await expect(files).toContainText('+5')
  await expect(files).toContainText('−1')

  await files.getByRole('button', { name: /live-stream\.ts/ }).click()
  const changesTab = page.getByRole('tablist', { name: 'Inspector' }).getByRole('tab', { name: /^Changes/ })
  await expect(changesTab).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
})
