/**
 * Deleting a task from the navigator, end to end in the real shell.
 *
 * Whether the hover actions and the inline confirm own their hit tests is a
 * cascade question — which of two equal-specificity utilities Tailwind emits
 * last — so it survives every jsdom assertion and only shows up against a real
 * stylesheet and a real hit test. A shipped build once rendered confirm buttons
 * fully visible while the row underneath swallowed the click.
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
        { runId: 'run-key', goal: 'Delete me with the Delete key' },
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

const rowFor = (text: string) => launched.window.locator('[data-nav-row]').filter({ hasText: text })

test('the overflow menu deletes the task through the inline confirm', async () => {
  const { window } = launched
  const row = rowFor('overflow menu')
  await row.waitFor({ timeout: 20_000 })
  await row.hover()

  await window.getByRole('button', { name: /^Actions for Delete me from the overflow menu/ }).click()
  await window.getByRole('menuitem', { name: 'Delete' }).click()

  // Nothing is hovering the row by now — the pointer is where the menu was —
  // so the confirm has to stand on its own and win its own hit test.
  await window.getByRole('button', { name: /^Delete Delete me from the overflow menu/ }).click({ timeout: 5_000 })

  await expect(rowFor('overflow menu')).toHaveCount(0)
  await expect(rowFor('Keep me')).toHaveCount(1)
})

test('the Delete key asks, then deletes', async () => {
  const { window } = launched
  const row = rowFor('Delete key')
  await row.waitFor({ timeout: 20_000 })
  await row.focus()
  await window.keyboard.press('Delete')
  await window.getByRole('button', { name: /^Delete Delete me with the Delete key/ }).click({ timeout: 5_000 })
  await expect(rowFor('Delete key')).toHaveCount(0)
})

test('keeping it cancels the confirm', async () => {
  const { window } = launched
  const row = rowFor('Keep me')
  await row.focus()
  await window.keyboard.press('Delete')
  await window.getByRole('button', { name: 'Keep it' }).click({ timeout: 5_000 })
  await expect(rowFor('Keep me')).toHaveCount(1)
})
