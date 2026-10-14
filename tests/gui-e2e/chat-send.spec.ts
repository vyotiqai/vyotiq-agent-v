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

  // While the run streams, the line's action reads Queue and Stop sits on the
  // run strip above it. Press the button; Escape is the same stop for the keyboard.
  const action = window.locator('[data-composer-line]').getByRole('button', { name: /^queue$/i })
  if (await action.isVisible().catch(() => false)) {
    const stop = window.locator('[data-run-strip]').getByRole('button', { name: /^stop/i })
    if (await stop.isVisible().catch(() => false)) await stop.click()
    else await window.keyboard.press('Escape')
    await expect(window.locator('[data-receipt-outcome="stopped"]').last()).toBeVisible({ timeout: 20_000 })
  } else {
    // The run ended on its own: the row reads Send again.
    await expect(window.locator('[data-composer-line]').getByRole('button', { name: /^send$/i })).toBeVisible({
      timeout: 20_000
    })
  }
})
