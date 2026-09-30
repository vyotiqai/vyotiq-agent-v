import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * New task as one brief, end to end: the done-when checks are typed inside the
 * brief's box, and each fact beside it that can be changed opens the page
 * where it is changed — Rules in Extensions, Index and Tools in Settings.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-new-task-facts-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

async function openNewTask(): Promise<void> {
  const page = launched.window
  // The navigator's button, not Ctrl+N: Extensions puts focus in its search field.
  await page.getByRole('navigation', { name: 'Tasks' }).getByRole('button', { name: 'New task' }).click({ timeout: 30_000 })
  await expect(page.getByRole('combobox', { name: 'Brief' })).toBeVisible({ timeout: 30_000 })
}

test('checks are typed inside the brief’s box, no button first', async () => {
  const page = launched.window
  await openNewTask()
  const box = page.locator('[data-brief]')
  const check = box.getByRole('textbox', { name: 'New check' })
  await expect(check).toBeVisible()
  await check.fill('The parser tests pass')
  await check.press('Enter')
  await expect(box.getByRole('list', { name: 'Done when' })).toContainText('The parser tests pass')
  await expect(check).toHaveValue('')
  // Between the brief and its control row.
  const [list, row] = await Promise.all([
    box.locator('[data-done-when]').boundingBox(),
    box.locator('[data-composer-controls]').boundingBox()
  ])
  expect(list!.y + list!.height).toBeLessThanOrEqual(row!.y + 1)
  await box.getByRole('button', { name: 'Remove “The parser tests pass”' }).click()
  await expect(box.getByRole('list', { name: 'Done when' })).toHaveCount(0)
})

test('Rules opens Extensions on its Rules tab', async () => {
  const page = launched.window
  await openNewTask()
  const sees = page.getByRole('complementary', { name: 'What the agent will see' })
  await sees.getByRole('button', { name: /^Rules\s*:.*change in Extensions$/ }).click({ timeout: 20_000 })
  await expect(page.getByRole('tab', { name: /^Rules/ })).toHaveAttribute('aria-selected', 'true', { timeout: 20_000 })
})

test('Index opens Settings on Indexing, and Tools on Tools', async () => {
  const page = launched.window
  const nav = page.getByRole('navigation', { name: 'Settings' }).first()

  await openNewTask()
  const sees = page.getByRole('complementary', { name: 'What the agent will see' })
  await sees.getByRole('button', { name: /^Index\s*:.*change in Settings$/ }).click({ timeout: 20_000 })
  await expect(nav.getByRole('button', { name: 'Indexing' })).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })

  // Settings' way back is to the brief it came from.
  await nav.getByRole('button', { name: 'Back to the task' }).click()
  await expect(page.getByRole('combobox', { name: 'Brief' })).toBeVisible({ timeout: 20_000 })
  await expect(sees).toContainText('built-in', { timeout: 20_000 })
  await sees.getByRole('button', { name: /^Tools\s*:.*change in Settings$/ }).click()
  await expect(nav.getByRole('button', { name: 'Tools' })).toHaveAttribute('aria-current', 'page', { timeout: 20_000 })
})
