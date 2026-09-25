import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

const FIXTURE_ASSISTANT_TEXT = 'E2E fixture response.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-chat-send-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = requireActivePath(addRes.data.activePath)
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

test('send message streams fixture assistant text and can stop', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Brief' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Hello from gui e2e')

  // The brief has no Send button: Start task, or Ctrl+Enter.
  await expect(window.getByRole('button', { name: /^send$/i })).toHaveCount(0)
  await composer.press('Control+Enter')

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })

  // While the run streams the task header offers Stop; once it ends, Stop goes
  // and the header reads the run's outcome.
  const stop = window.locator('[data-task-header]').getByRole('button', { name: /^stop$/i })
  if (await stop.isVisible().catch(() => false)) {
    await stop.click()
    await expect(stop).toBeHidden({ timeout: 10_000 })
  } else {
    await expect(window.locator('[data-task-header] [data-task-state]')).not.toHaveAttribute('data-task-state', 'running', {
      timeout: 10_000
    })
  }
})
