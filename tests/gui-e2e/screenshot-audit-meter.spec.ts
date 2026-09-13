import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-audit-meter-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/screenshot-audit-meter.json'
  })

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

test('context meter: low fill + tipCue without warning chrome (E4/R1)', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Replay screenshot audit meter')
  await window.getByRole('button', { name: /^send$/i }).click()

  await expect(window.getByText('Audit meter fixture done.')).toBeVisible({ timeout: 20_000 })

  const meter = window.getByRole('button', { name: /context window/i })
  await expect(meter).toBeVisible({ timeout: 15_000 })
  // The meter renders a ring + sr-free label: numbers live in aria-label/title.
  const meterLabel = (await meter.getAttribute('aria-label')) ?? ''
  expect(meterLabel).toMatch(/2\.3k/i)
  expect(meterLabel).toMatch(/28k/i)
  expect(meterLabel).toMatch(/99% cached/i)

  const className = await meter.getAttribute('class')
  expect(className ?? '').not.toMatch(/bg-warning/)
  expect(className ?? '').not.toMatch(/text-warning/)
  // Low fill must not use danger chrome either (not over budget).
  expect(className ?? '').not.toMatch(/bg-danger/)
  expect(className ?? '').not.toMatch(/text-danger/)

  const aria = (await meter.getAttribute('aria-label')) ?? ''
  expect(aria).toMatch(/Long-run tip available/i)

  await meter.click()
  await expect(window.getByText(/Long run — \/clear/i)).toBeVisible()
})
