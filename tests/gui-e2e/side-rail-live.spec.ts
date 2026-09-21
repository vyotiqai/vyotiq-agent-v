import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The rail's live markers against a real run: the replay fixture streams an
 * `edit` call in six paced deltas, so the Files button is genuinely mid-write
 * while this asserts on it.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-rail-live-ws-'))
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
    // The rail only shows while no dock panel is open.
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
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

test('Files pulses with the file the run is writing, and stops when it lands', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-chat-side-rail]')).toBeVisible()
  await expect(window.locator('[data-rail-row="files"][data-rail-active]')).toHaveCount(0)

  await composer.fill('Stream a live edit diff')
  await window.getByRole('button', { name: /^send$/i }).click()

  // Mid-write: the rail says which file, without the Files panel being open.
  await expect(window.locator('[data-rail-row="files"][data-rail-active]')).toBeVisible({
    timeout: 20_000
  })
  await expect(
    window.getByRole('button', { name: /Show files panel · Editing src\/live-stream\.ts/ })
  ).toBeVisible()
  await expect(window.locator('#dock-panel-files')).toHaveCount(0)

  // The call lands, the run ends, and the marker goes with it.
  await expect(window.getByText('Live edit stream fixture done.')).toBeVisible({
    timeout: 30_000
  })
  await expect(window.locator('[data-rail-row="files"][data-rail-active]')).toHaveCount(0)
})
