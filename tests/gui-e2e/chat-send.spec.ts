import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

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

test('send message streams fixture assistant text and can stop', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Hello from gui e2e')

  const send = window.getByRole('button', { name: /^send$/i })
  await expect(send).toBeEnabled()
  await send.click()

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })

  // Merged primary action: while a run streams the button is Stop; once the run
  // completes with an empty composer, the mic becomes primary (Send unmounts).
  const stop = window.getByRole('button', { name: /^stop$/i })
  if (await stop.isVisible().catch(() => false)) {
    await stop.click()
    await expect(stop).toBeHidden({ timeout: 10_000 })
  } else {
    // Run already finished — the composer returned to idle (Dictate primary).
    await expect(window.getByRole('button', { name: /^dictate$/i })).toBeVisible({ timeout: 10_000 })
  }
})
