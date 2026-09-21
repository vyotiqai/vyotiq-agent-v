import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Teammates, end to end.
 *
 * The feature had no GUI e2e coverage at all — every one of its ~120 tests
 * mocks either the IPC bridge or the store underneath it, so nothing exercised
 * the path that actually matters: a teammate created in the pane, handed work,
 * and that work running through the real scheduler and reporting back over the
 * `tasksChanged` push.
 */

let launched: LaunchedApp
let workspacePath: string

/** Idempotent: the sidebar control toggles, so a second click would close it. */
async function openTeammates(page: LaunchedApp['window']): Promise<void> {
  const rail = page.locator('[data-teammates-rail]')
  if (await rail.isVisible()) return
  await page.getByLabel('Open teammates').click()
  await rail.waitFor()
}

test.setTimeout(120_000)

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-teammates-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

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
  await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('a teammate created in the pane takes work, runs it, and reports back', async () => {
  const page = launched.window

  await openTeammates(page)

  // Create. The id is slugified from the name, which is what every later
  // selector and the memory namespace key off.
  await page.getByLabel('New teammate').click()
  await page.getByRole('dialog').getByRole('textbox').fill('Scout')
  await page.getByRole('button', { name: 'Create teammate' }).click()
  await expect(page.locator('[data-teammate-detail="scout"]')).toBeVisible()

  // Assign. The brief goes through the same chatStart path a user send does.
  // `exact` because the sidebar row's hover control is "Assign task to Scout".
  await page.getByRole('button', { name: 'Assign task', exact: true }).click()
  const assign = page.getByRole('dialog')
  await assign.getByRole('textbox').first().fill('Audit the pricing pages.')
  await assign.getByRole('button', { name: 'Assign task', exact: true }).click()

  await page.getByRole('tab', { name: 'Activity' }).click()
  const detail = page.locator('[data-teammate-detail="scout"]')
  await expect(detail.getByText('Audit the pricing pages.')).toBeVisible()

  // The scheduler finalizes a delegated task from the run's DURABLE status,
  // not from the stream, so reaching Done proves the whole chain: claim,
  // launch, run-finish listener, status.json read, tasksChanged push.
  await expect(detail.getByText('Done', { exact: true })).toBeVisible({ timeout: 60_000 })
  // Not stuck mid-flight, and not the "Run status unavailable" failure a run
  // with no persisted status settles into.
  await expect(detail.getByText('Running', { exact: true })).toHaveCount(0)
  await expect(detail.getByTestId('delegated-task-error')).toHaveCount(0)

  // A finished task keeps the link back to its transcript.
  await expect(detail.getByTestId('delegated-task-open')).toBeVisible()

  // And the durable record agrees with the badge. Asserted separately because
  // a badge can come from anywhere on the page; this is the row the scheduler
  // actually wrote to `.vyotiq/tasks.json`.
  const tasks = await page.evaluate(async () => window.vyotiq.tasksList())
  expect(tasks.ok).toBe(true)
  if (!tasks.ok) throw new Error(tasks.error)
  const assigned = tasks.data.find((t) => t.prompt === 'Audit the pricing pages.')
  expect(assigned?.status).toBe('done')
  expect(assigned?.runId).toBeTruthy()
  expect(assigned?.finishedAt).toBeTruthy()
})

test('a scheduled task can be cancelled before it ever starts', async () => {
  const page = launched.window

  await openTeammates(page)
  // Select explicitly rather than inheriting the previous test's selection.
  await page.getByRole('option', { name: 'Scout' }).click()
  await page.locator('[data-teammate-detail="scout"]').waitFor()
  await page.getByRole('button', { name: 'Assign task', exact: true }).click()

  const assign = page.getByRole('dialog')
  await assign.getByRole('textbox').first().fill("Next week's release notes.")
  // A schedule far enough out that it cannot fire during the test — the point
  // is cancelling work that never ran, which is the branch with no live run to
  // unwind.
  const when = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
  const local = new Date(when.getTime() - when.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16)
  await assign.locator('input[type="datetime-local"]').fill(local)
  await assign.getByRole('button', { name: 'Schedule task' }).click()

  await page.getByRole('tab', { name: 'Activity' }).click()
  // Scoped to the pane: the sidebar roster carries the same badge, which is
  // itself the point — both surfaces read one store and one push.
  const detail = page.locator('[data-teammate-detail="scout"]')
  await expect(detail.getByText('Scheduled', { exact: true })).toBeVisible()

  await detail.getByTestId('delegated-task-cancel').click()
  await expect(detail.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 20_000 })
  // Nothing ever ran, so there is no transcript for this row to link to.
  await expect(detail.getByText('Scheduled', { exact: true })).toHaveCount(0)
})
