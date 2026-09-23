import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The inspector's live dots against a real run: the replay fixture streams an
 * `edit` call in six paced deltas, so the Files tab is genuinely mid-write
 * while this asserts on it.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-inspector-live-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/live-edit-stream.json'
  })

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)

  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    // Start on the default tab so the Files tab is not the one on screen.
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.inspectorOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('Files goes live with the file the run is writing, and stops when it lands', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const composer = window.getByRole('combobox', { name: 'Instruction' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  const files = window.getByRole('tablist', { name: 'Inspector' }).getByRole('tab', { name: /^Files/ })
  await expect(files).toBeVisible()
  await expect(files).not.toContainText('working now')

  await composer.fill('Stream a live edit diff')
  // The instruction line sends on Enter — it has no Send button.
  await window.getByRole('combobox', { name: 'Instruction' }).press('Enter')

  // Mid-write: the tab says which file, without the Files panel being opened.
  await expect(files).toContainText('working now', { timeout: 20_000 })
  await expect(files).toHaveAttribute('title', /^Editing src\/live-stream\.ts · /)
  await expect(window.locator('#dock-panel-files')).toHaveCount(0)

  // The call lands, the run ends, and the dot goes with it.
  await expect(window.getByText('Live edit stream fixture done.')).toBeVisible({
    timeout: 30_000
  })
  await expect(files).not.toContainText('working now')
})
