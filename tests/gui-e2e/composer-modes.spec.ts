import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Plan mode merged into Agent. Two surfaces let a user pick a mode — the
 * task options' Mode control and the slash menu — and both are assembled from
 * separate lists (MODES in ModePicker, BUILTIN_COMMANDS in main). A unit test on either
 * one passes while the other still offers a mode the gate no longer honours,
 * so this checks the shipped app.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-composer-modes-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
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

test('the mode control offers Agent and Ask only', async () => {
  const { window } = launched

  await expect(window.locator('[data-composer-input]').first()).toBeVisible({ timeout: 20_000 })

  // Mode sits with the model and effort in the task options.
  await window.locator('[data-task-options]').first().click()
  const options = window.getByRole('dialog', { name: 'Mode, model and effort' })
  await expect(options).toBeVisible({ timeout: 10_000 })
  const mode = options.getByRole('radiogroup', { name: 'Mode' })
  await expect(mode.getByRole('radio')).toHaveText(['Ask', 'Agent'])
  await expect(mode.getByRole('radio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true')

  await mode.getByRole('radio', { name: 'Ask' }).click()
  await expect(mode.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true')
  await mode.getByRole('radio', { name: 'Agent' }).click()
  await expect(mode.getByRole('radio', { name: 'Agent' })).toHaveAttribute('aria-checked', 'true')
  await window.keyboard.press('Escape')
  await expect(options).toHaveCount(0)
})

test('the slash menu offers /ask and /agent but no /plan', async () => {
  const { window } = launched

  const composer = window.locator('[data-composer-input]').first()
  await expect(composer).toBeVisible({ timeout: 20_000 })

  // Mode commands are hidden from the idle list and surface on search, so the
  // query has to be typed rather than just opening the menu.
  await composer.click()
  await composer.pressSequentially('/a')
  const menu = window.getByRole('listbox', { name: 'Slash commands' })
  await expect(menu).toBeVisible({ timeout: 15_000 })
  await expect(menu.getByRole('option', { name: /Agent mode/ })).toBeVisible()
  await expect(menu.getByRole('option', { name: /Ask mode/ })).toBeVisible()
  await expect(menu.getByRole('option', { name: /Plan mode/ })).toHaveCount(0)

  await composer.fill('')
  await composer.pressSequentially('/plan')
  // Either the menu closes with no match, or it opens without a Plan entry —
  // both are "no /plan"; what must never appear is a Plan mode command.
  await expect(
    window.getByRole('listbox', { name: 'Slash commands' }).getByRole('option', {
      name: /Plan mode/
    })
  ).toHaveCount(0)

  await composer.fill('')
})
