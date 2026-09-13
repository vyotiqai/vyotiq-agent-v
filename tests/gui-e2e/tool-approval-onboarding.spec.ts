import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

const FIXTURE_ASSISTANT_TEXT = 'E2E fixture response.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-approval-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = addRes.data.activePath
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: false })
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

test('first send opens tool approval onboarding then streams fixture', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('First send with onboarding')

  const send = window.getByRole('button', { name: /^send$/i })
  await send.click()

  await expect(window.getByRole('heading', { name: 'Tool approval' })).toBeVisible({
    timeout: 10_000
  })
  await window.getByRole('button', { name: /mutating tools/i }).click()

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.toolApprovalOnboardingDone).toBe(true)
  expect(settings?.toolApproval?.mode).toBe('mutating')
})
