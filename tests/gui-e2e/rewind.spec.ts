import { expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedRunEvents, seedWorkspacesRegistry } from './helpers/seedWorkspace'
import { REWIND_CHECKPOINT_ID, REWIND_FILES, seedRewindTask } from './helpers/seedRewind'

/**
 * Rewind, end to end: the record's rewind asks with main's own preview of the
 * files, and what it says is what main then does to the disk and the record —
 * including leaving the file you changed after the agent wrote it.
 */

const runId = 'run-rewind-e2e'
let workspace: string
let launched: LaunchedApp

const read = (rel: string): string => readFileSync(join(workspace, rel), 'utf8')

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-rewind-e2e-'))
  launched = await launchApp({
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

const REWIND = 'Rewind files and record to before this instruction'

test('Cancel changes nothing', async () => {
  const { window } = launched
  await window.getByRole('button', { name: REWIND }).click({ timeout: 30_000 })
  const dialog = window.getByRole('dialog', { name: 'Rewind to before run 2?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Cancel' }).click()
  await expect(dialog).toBeHidden()
  expect(read(REWIND_FILES.changed.path)).toBe(REWIND_FILES.changed.after)
  expect(existsSync(join(workspace, REWIND_FILES.created.path))).toBe(true)
  await expect(window.getByText('Shortcuts sit under App, and the section labels share one style.')).toBeVisible()
})

test('rewinds to before run 2, leaving the file you changed since', async () => {
  const { window } = launched
  await window.getByRole('button', { name: REWIND }).click()
  const dialog = window.getByRole('dialog', { name: 'Rewind to before run 2?' })
  await expect(dialog).toContainText(
    'Everything after run 2’s instruction leaves the record, and these files go back to how they were before it. This can’t be undone.'
  )
  const rows = dialog.getByRole('list', { name: 'Files' }).getByRole('listitem')
  await expect(rows).toHaveCount(3)
  await expect(rows.filter({ hasText: REWIND_FILES.changed.path })).toContainText('M')
  await expect(rows.filter({ hasText: REWIND_FILES.created.path })).toContainText('A')
  await expect(rows.filter({ hasText: REWIND_FILES.yours.path })).toContainText('changed since · left as is')

  await dialog.getByRole('button', { name: 'Rewind 2 files' }).click()
  await expect(dialog).toBeHidden()
  await expect(window.getByText('Rewound to before run 2 · 2 files restored · 1 file left as you changed it')).toBeVisible({
    timeout: 20_000
  })

  // On disk: the change undone, the new file gone, yours as you left it.
  expect(read(REWIND_FILES.changed.path)).toBe(REWIND_FILES.changed.before)
  expect(existsSync(join(workspace, REWIND_FILES.created.path))).toBe(false)
  expect(read(REWIND_FILES.yours.path)).toBe(REWIND_FILES.yours.mine)

  // In the record: run 2's instruction stays; what the agent did after it is gone.
  await expect(window.getByText('Shortcuts sit under App, and the section labels share one style.')).toHaveCount(0)
  await expect(window.getByText('Also move Shortcuts under App, and share one section-label style').first()).toBeVisible()

  // Nothing is left waiting on Keep or Undo, so the navigator stops calling it Ready for review.
  await expect(window.locator('[data-nav-section="review"]')).toHaveCount(0, { timeout: 15_000 })
  await expect(window.locator('[data-nav-section="done"]')).toContainText('Regroup Settings into App, Agent and System')
})

test.describe('Keep all', () => {
  const keepRunId = 'run-keep-e2e'
  let keepWorkspace: string
  let keepApp: LaunchedApp

  test.beforeAll(async () => {
    keepWorkspace = mkdtempSync(join(tmpdir(), 'vyotiq-keep-e2e-'))
    keepApp = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        seedRewindTask(userDataDir, keepWorkspace, keepRunId)
        // The turn's checkpoint event, as the loop appends it: Changes offers Keep and Undo from it.
        seedRunEvents(userDataDir, keepWorkspace, keepRunId, [
          {
            type: 'writes_checkpoint',
            runId: keepRunId,
            checkpointId: REWIND_CHECKPOINT_ID,
            files: [
              { path: REWIND_FILES.changed.path, action: 'modified', undoable: true },
              { path: REWIND_FILES.created.path, action: 'created', undoable: true },
              { path: REWIND_FILES.yours.path, action: 'modified', undoable: true }
            ]
          }
        ])
        seedWorkspacesRegistry(userDataDir, keepWorkspace, keepRunId)
      }
    })
  })

  test.afterAll(async () => {
    if (keepApp) await closeApp(keepApp)
    rmSync(keepWorkspace, { recursive: true, force: true })
  })

  test('takes the task out of Ready for review, and leaves the files as they are', async () => {
    const { window } = keepApp
    await expect(window.locator('[data-nav-section="review"]')).toContainText('Regroup Settings into App, Agent and System', {
      timeout: 30_000
    })
    await window.getByRole('button', { name: 'Keep all', exact: true }).click({ timeout: 20_000 })
    await expect(window.locator('[data-nav-section="review"]')).toHaveCount(0, { timeout: 15_000 })
    await expect(window.locator('[data-nav-section="done"]')).toContainText('Regroup Settings into App, Agent and System')
    expect(read2(keepWorkspace, REWIND_FILES.changed.path)).toBe(REWIND_FILES.changed.after)
  })
})

function read2(root: string, rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}
