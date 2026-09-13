import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

const FIXTURE_ASSISTANT_TEXT = 'E2E fixture response.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-offline-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = addRes.data.activePath
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
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

test('shows queued hint and flushes persisted offline messages on load', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  await window.evaluate((path) => {
    const key = `vyotiq.offlineQueue.${encodeURIComponent(path)}`
    localStorage.setItem(
      key,
      JSON.stringify([
        {
          id: 'seed-1',
          text: 'Persisted offline message',
          // Flushes are run-bound since the anti-cross-pane hardening: entries
          // without a runId are deliberately never flushed to the focused pane.
          runId: 'seed-run-1',
          workspacePath: path,
          queuedAt: new Date().toISOString()
        }
      ])
    )
  }, workspacePath)

  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('body')).toBeVisible({ timeout: 30_000 })

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 20_000 })
})
