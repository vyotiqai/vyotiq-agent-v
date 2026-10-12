import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedWorkspacesRegistry } from './helpers/seedWorkspace'
import { REWIND_FILES, seedRewindTask } from './helpers/seedRewind'

/**
 * "Run this again" on the latest answer's receipt, end to end, on the task
 * rewind.spec seeds (run 2 changed three files): it asks with main's own
 * preview of the files that go back, then puts them back and runs the same
 * instruction again — one brief for it, its answer again at the end.
 */

const runId = 'run-again-e2e'
const RUN_2 = 'Also move Shortcuts under App, and share one section-label style'
let workspace: string
let launched: LaunchedApp

const read = (rel: string): string => readFileSync(join(workspace, rel), 'utf8')

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-run-again-e2e-'))
  launched = await launchApp({
    // The rerun's own run replays this fixture instead of calling a model.
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/record-order.json',
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
      seedRewindTask(userDataDir, workspace, runId)
      seedWorkspacesRegistry(userDataDir, workspace, runId)
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspace, { recursive: true, force: true })
})

test('Cancel changes nothing', async () => {
  const { window } = launched
  await window.getByRole('button', { name: 'Run this again' }).click({ timeout: 30_000 })
  const dialog = window.getByRole('dialog', { name: 'Run this again?' })
  await expect(dialog).toContainText(
    'This run’s work and answer leave the record and the same instruction runs again. First, these files go back to how they were.'
  )
  await expect(dialog.getByRole('list', { name: 'Files' }).getByRole('listitem')).toHaveCount(3)
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(read(REWIND_FILES.changed.path)).toBe(REWIND_FILES.changed.after)
  await expect(window.getByText('Shortcuts sit under App, and the section labels share one style.')).toBeVisible()
})

test('puts the files back, then runs the same instruction again', async () => {
  const { window } = launched
  await window.getByRole('button', { name: 'Run this again' }).click()
  const dialog = window.getByRole('dialog', { name: 'Run this again?' })
  await dialog.getByRole('button', { name: 'Run again' }).click()
  await expect(dialog).toBeHidden()
  // The button goes once the run is live; focus lands on the instruction line, not the page.
  await expect.poll(() => window.evaluate(() => document.activeElement?.hasAttribute('data-composer-input') ?? false)).toBe(true)

  // The rewind happened on disk before the run started over.
  await expect.poll(() => read(REWIND_FILES.changed.path), { timeout: 15_000 }).toBe(REWIND_FILES.changed.before)
  expect(existsSync(join(workspace, REWIND_FILES.created.path))).toBe(false)

  // The same instruction, once, and a new answer under it.
  const result = window.locator('section[aria-label="Result"]')
  await expect(result).toContainText('RECORD_ORDER_DONE', { timeout: 30_000 })
  await expect(result).not.toContainText('Shortcuts sit under App')
  await expect(window.locator('[data-brief]').filter({ hasText: RUN_2 })).toHaveCount(1)
})
