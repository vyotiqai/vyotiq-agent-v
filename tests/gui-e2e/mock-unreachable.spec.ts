import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * A task that failed because Redis refused the connection: its failure names
 * Redis, from the command's own output, and offers to have the task mock it.
 * Clicking it sends that as the task's next instruction.
 */
let launched: LaunchedApp
let workspacePath: string

const INSTRUCTION = 'Mock Redis instead of connecting to it, so the work can be verified without it, then carry on.'

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-mock-unreachable-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/mock-unreachable.json' })
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.inspectorOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('a failure Redis caused offers to mock Redis, and sends it as the next instruction', async () => {
  const page = launched.window
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await brief.fill('Cache repository search results in Redis')
  await brief.press('Control+Enter')

  const record = page.locator('[data-transcript-scroll]')
  const failure = record.getByRole('alert').filter({ hasText: 'The search tests could not run.' })
  await expect(failure).toHaveCount(1, { timeout: 20_000 })
  const mock = failure.getByRole('button', { name: 'Ask it to mock Redis' })
  await expect(mock).toBeVisible()

  await mock.click()
  // Sent as the task's next instruction: it opens run 2, and run 1's failure is history.
  await expect(record.getByText(INSTRUCTION, { exact: true }).first()).toBeVisible({ timeout: 20_000 })
  await expect(record.getByRole('button', { name: /Run 1 Cache repository search results in Redis/ })).toBeVisible({
    timeout: 20_000
  })
})
