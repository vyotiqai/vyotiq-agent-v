import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Plan mode merged into Agent. Two surfaces let a user pick a mode — the
 * composer pill and the slash menu — and both are assembled from separate
 * lists (MODES in ModePicker, BUILTIN_COMMANDS in main). A unit test on either
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

test('the composer mode pill cycles Agent and Ask only', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  await expect(window.getByRole('combobox', { name: 'Message' })).toBeVisible({
    timeout: 20_000
  })

  // The pill's accessible name states the current mode and the next one, so a
  // full cycle is observable without reading component state.
  const pill = window.getByRole('button', { name: /mode\. Click for/i })
  await expect(pill).toBeVisible({ timeout: 20_000 })

  const seen: string[] = []
  for (let i = 0; i < 4; i += 1) {
    const label = (await pill.getAttribute('aria-label')) ?? ''
    seen.push(label.split(' mode.')[0]!.trim())
    await pill.click()
  }

  expect(seen).toEqual(['Agent', 'Ask', 'Agent', 'Ask'])
  expect(seen).not.toContain('Plan')
})

test('the slash menu offers /ask and /agent but no /plan', async () => {
  const { window } = launched

  const composer = window.getByRole('combobox', { name: 'Message' })
  await expect(composer).toBeVisible({ timeout: 20_000 })

  // Mode commands are hidden from the idle list and surface on search, so the
  // query has to be typed rather than just opening the menu.
  await composer.fill('')
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
