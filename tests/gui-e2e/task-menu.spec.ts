import { expect, test } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedRunEvents, seedWorkspacesRegistry } from './helpers/seedWorkspace'
import { REWIND_CHECKPOINT_ID, REWIND_FILES, seedRewindTask } from './helpers/seedRewind'

/**
 * The task's More menu, end to end: Pin files it under Pinned (and the menu
 * then offers Unpin), and Fork makes a new task from its conversation — main's
 * forkRun, opened where you are, listed in the navigator.
 */
const runId = 'run-menu-e2e'
const TITLE = 'Regroup Settings into App, Agent and System'
let workspace: string
let launched: LaunchedApp

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-menu-e2e-'))
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
      seedRewindTask(userDataDir, workspace, runId)
      // The turn's checkpoint event, as the loop appends it: Changes offers Keep and Undo from it.
      seedRunEvents(userDataDir, workspace, runId, [
        {
          type: 'writes_checkpoint',
          runId,
          checkpointId: REWIND_CHECKPOINT_ID,
          files: [
            { path: REWIND_FILES.changed.path, action: 'modified', undoable: true },
            { path: REWIND_FILES.created.path, action: 'created', undoable: true },
            { path: REWIND_FILES.yours.path, action: 'modified', undoable: true }
          ]
        }
      ])
      seedWorkspacesRegistry(userDataDir, workspace, runId)
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspace, { recursive: true, force: true })
})

const openMenu = async (): Promise<void> => {
  await launched.window.locator('[data-task-header]').getByRole('button', { name: /^More — / }).click({ timeout: 30_000 })
}

test('Pin keeps a finished task out of Done, under Pinned, and the menu then offers Unpin', async () => {
  const { window } = launched
  await openMenu()
  await window.getByRole('menuitem', { name: 'Pin', exact: true }).click()
  await openMenu()
  await expect(window.getByRole('menuitem', { name: 'Unpin' })).toBeVisible()
  await window.keyboard.press('Escape')
  // Still waiting on Keep or Undo, it stays in Ready for review; once kept it
  // would fold into Done — pinned, it gets its own group instead.
  await expect(window.locator('[data-nav-section="review"]')).toContainText(TITLE, { timeout: 15_000 })
  await window.getByRole('button', { name: 'Keep all', exact: true }).click({ timeout: 20_000 })
  await expect(window.locator('[data-nav-section="pinned"]')).toContainText(TITLE, { timeout: 15_000 })
  await expect(window.locator('[data-nav-section="done"]')).toHaveCount(0)
})

test('Fork opens a new task with the same conversation, listed beside the original', async () => {
  const { window } = launched
  await openMenu()
  await window.getByRole('menuitem', { name: 'Fork' }).click()
  await expect(window.getByText('Forked — a copy of the task to take another way')).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-task-header] h1')).toHaveText(`${TITLE} (fork)`, { timeout: 20_000 })
  // Its record is the original's conversation.
  await expect(window.getByText('Shortcuts sit under App, and the section labels share one style.')).toBeVisible()
  // Both tasks are in the navigator.
  await expect(window.locator('[data-navigator]')).toContainText(`${TITLE} (fork)`)
  await expect(window.locator('[data-navigator]').getByRole('button', { name: new RegExp(`^${TITLE}(?! \\(fork\\))`) }).first()).toBeVisible()
})
