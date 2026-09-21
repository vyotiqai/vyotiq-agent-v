/**
 * Deleting a chat from the sidebar, end to end in the real shell.
 *
 * The overlay strip's clickability is a cascade question — which of two
 * equal-specificity utilities Tailwind emits last — so it survives every
 * jsdom assertion and only shows up against a real stylesheet and a real hit
 * test. A shipped build once rendered the confirm buttons fully visible while
 * the row button underneath swallowed the click, and no unit test could see it.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData, seedWorkspacesRegistry } from './helpers/seedWorkspace'

let launched: LaunchedApp
const workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-row-actions-'))

test.beforeAll(async () => {
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, workspacePath, [
        { runId: 'run-trash', goal: 'Delete me with the trash button' },
        { runId: 'run-menu', goal: 'Delete me from the overflow menu' },
        { runId: 'run-keep', goal: 'Keep me' }
      ])
      seedWorkspacesRegistry(userDataDir, workspacePath, 'run-keep')
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('the trash button deletes the chat through the inline confirm', async () => {
  const { window } = launched
  const row = window.locator('[data-session-row]').filter({ hasText: 'trash button' })
  await row.waitFor({ timeout: 20_000 })
  await row.hover()

  await window.getByRole('button', { name: /^Delete Delete me with the trash button/ }).click()

  // The confirm must own its own hit test: a visible-but-dead strip lets the
  // click fall through to the row and silently selects the chat instead.
  await window
    .getByRole('button', { name: /^Confirm delete Delete me with the trash button/ })
    .click({ timeout: 5_000 })

  await expect(
    window.locator('[data-session-row]').filter({ hasText: 'trash button' })
  ).toHaveCount(0)
  await expect(window.locator('[data-session-row]').filter({ hasText: 'Keep me' })).toHaveCount(1)
})

test('the overflow menu deletes the chat through the same confirm', async () => {
  const { window } = launched
  const row = window.locator('[data-session-row]').filter({ hasText: 'overflow menu' })
  await row.waitFor({ timeout: 20_000 })
  await row.hover()

  await window
    .getByRole('button', { name: /^More actions for Delete me from the overflow menu/ })
    .click()
  await window.getByRole('menuitem', { name: 'Delete' }).click()

  // Nothing is hovering the row by now — the pointer is down where the menu
  // was — so the confirm has to stand on its own.
  await window
    .getByRole('button', { name: /^Confirm delete Delete me from the overflow menu/ })
    .click({ timeout: 5_000 })

  await expect(
    window.locator('[data-session-row]').filter({ hasText: 'overflow menu' })
  ).toHaveCount(0)
})

test('cancelling the confirm keeps the chat', async () => {
  const { window } = launched
  const row = window.locator('[data-session-row]').filter({ hasText: 'Keep me' })
  await row.hover()

  await window.getByRole('button', { name: /^Delete Keep me/ }).click()
  await window.getByRole('button', { name: /^Cancel delete Keep me/ }).click({ timeout: 5_000 })

  await expect(window.locator('[data-session-row]').filter({ hasText: 'Keep me' })).toHaveCount(1)
})
