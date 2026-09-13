import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-audit-tools-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/screenshot-audit-tools.json'
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

test('streams T1 tool cards: unknown tool not titled placeholder; ask humanized', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Replay screenshot audit tools')
  await window.getByRole('button', { name: /^send$/i }).click()

  await expect(window.getByText('Audit tools fixture done.')).toBeVisible({ timeout: 20_000 })

  // Unknown tool row must not present args.path "placeholder" as the title.
  await expect(window.getByText(/Write file check/i).first()).toBeVisible()
  const placeholderAsTitle = window.getByRole('button', { name: /^placeholder$/i })
  await expect(placeholderAsTitle).toHaveCount(0)

  // Humanized ask args error (not Zod "Expected array, received string").
  const askFailExpand = window
    .getByRole('button', { name: /expand asked|expand ask_question|collapse ask_question/i })
    .first()
  if (await askFailExpand.isVisible().catch(() => false)) {
    const label = (await askFailExpand.getAttribute('aria-label')) ?? ''
    if (/expand/i.test(label)) await askFailExpand.click()
  }
  await expect(window.getByText(/JSON array of question objects/i).first()).toBeVisible()
  await expect(window.getByText(/Expected array, received string/i)).toHaveCount(0)

  // Timeout ask keeps title as header target.
  await expect(window.getByText(/Diagnosing your empty screen/i).first()).toBeVisible()

  const timedOutExpand = window.getByRole('button', {
    name: /expand asked: diagnosing your empty screen/i
  })
  if (await timedOutExpand.isVisible().catch(() => false)) {
    await timedOutExpand.click()
  }
  await expect(window.getByText(/^Timed out$/i).first()).toBeVisible()
  await expect(window.getByText(/^Failed$/i).first()).toBeVisible()
})
