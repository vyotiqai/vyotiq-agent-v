import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Locator } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The Work record keeps a run's work where and when it happened, in the real
 * window: each step holds its own calls after the run ends (they used to pile
 * up above the step list once the run-end pass rewrote the plan snapshots),
 * a step's words head the call they streamed after, and work done between two
 * steps sits between them.
 */

/** A lookup's row names its file in the open-file button's title. */
const fileRow = (scope: Locator, path: string): Locator => scope.locator(`button[title$="${path}"]`)

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-record-order-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/record-order.json' })

  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
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

test('a finished run keeps every step’s work in its step, in order', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const composer = window.getByRole('combobox', { name: 'Brief' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('Check the config and the tests')
  await composer.press('Control+Enter')

  // The run ends with its answer as the record's result.
  const result = window.locator('section[aria-label="Result"]')
  await expect(result).toContainText('RECORD_ORDER_DONE', { timeout: 30_000 })
  // The run is over: the composer offers no Stop.
  await expect(window.locator('[data-composer-line]').getByRole('button', { name: /^stop$/i })).toHaveCount(0, {
    timeout: 15_000
  })

  const step1 = window.locator('[data-step="1"]')
  const step2 = window.locator('[data-step="2"]')
  await expect(step1).toHaveAttribute('data-step-state', 'done')
  await expect(step2).toHaveAttribute('data-step-state', 'done')

  // Work between the steps sits after step 1, outside it (visible with step 1
  // folded), before step 2.
  const between = window.locator('[data-step-between="1"]')
  await expect(between).toBeVisible()
  expect((await between.boundingBox())!.y).toBeLessThan((await step2.boundingBox())!.y)
  await between.getByRole('button', { name: /Read/ }).click()
  await expect(fileRow(between, 'between-steps.md')).toBeVisible()

  // Step 1 still holds its words and then its call — not the list above the steps.
  await step1.getByRole('button', { name: 'Read the config' }).click()
  const words = step1.getByText('STEP_ONE_WORDS reading the config.')
  await expect(words).toBeVisible()
  // The step's own lookup line comes before the between-steps work in its item;
  // one lookup names what it read.
  const lookup = step1.getByRole('button', { name: /^Read config.json/ }).first()
  expect((await words.boundingBox())!.y).toBeLessThan((await lookup.boundingBox())!.y)
  await lookup.click()
  await expect(fileRow(step1, 'config.json')).toBeVisible()

  // Step 2 holds its own call.
  await step2.getByRole('button', { name: 'Read the tests' }).click()
  await step2.getByRole('button', { name: /^Read app.test.ts/ }).click()
  await expect(fileRow(step2, 'app.test.ts')).toBeVisible()
})
