import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedWorkspacesRegistry, sessionsRootFor } from './helpers/seedWorkspace'
import { seedRewindTask } from './helpers/seedRewind'

/**
 * Review leads with what is still open, end to end: the task's checks.json as
 * the loop writes it, read by the Changes tab and the full review once the run
 * has stopped — the unmet check first, the met ones folded to a count — and
 * "Ask it to cover this" goes to the task as its next instruction.
 */

const runId = 'run-review-checks-e2e'
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const OPEN_CHECK = 'Section labels share one style everywhere'
const at = new Date().toISOString()
const CHECKS = {
  lastId: 3,
  checks: [
    { id: 'c1', text: 'Settings open on App, Agent and System', source: 'brief', verdict: 'met', evidence: 'settings.test.ts › three groups', createdAt: at, markedAt: at },
    { id: 'c2', text: OPEN_CHECK, source: 'brief', verdict: 'not_met', evidence: 'Extensions still uses its own heading style', createdAt: at, markedAt: at },
    { id: 'c3', text: 'Shortcuts sit under App', source: 'plan', verdict: 'met', evidence: 'groups.ts lists Shortcuts under App', createdAt: at, markedAt: at }
  ]
}

let workspace: string
let launched: LaunchedApp

test.beforeAll(async () => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-review-checks-e2e-'))
  launched = await launchApp({
    e2eFixture: true,
    fixtureFile: 'tests/gui-e2e/fixtures/chat-send-stream.json',
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
      seedRewindTask(userDataDir, workspace, runId)
      writeFileSync(join(sessionsRootFor(userDataDir, workspace), runId, 'checks.json'), JSON.stringify(CHECKS), 'utf8')
      seedWorkspacesRegistry(userDataDir, workspace, runId)
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspace, { recursive: true, force: true })
})

test('Changes leads with the open check and folds the met ones', async () => {
  const { window } = launched
  await expect(window.getByText('Shortcuts sit under App, and the section labels share one style.')).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press('Alt+1')
  const changes = window.getByRole('region', { name: 'Changes' })
  const checks = changes.getByRole('region', { name: 'Done-when checks' })
  await expect(checks).toBeVisible({ timeout: 20_000 })

  const open = checks.locator('[data-check]')
  await expect(open).toHaveCount(1)
  await expect(open.first()).toHaveAttribute('data-check-verdict', 'not_met')
  await expect(open.first()).toContainText(OPEN_CHECK)
  await expect(open.first()).toContainText('Extensions still uses its own heading style')

  const fold = checks.getByRole('button', { name: /2 of 3 checks met/ })
  await expect(fold).toHaveAttribute('aria-expanded', 'false')
  await fold.click()
  await expect(fold).toHaveAttribute('aria-expanded', 'true')
  await expect(checks.locator('[data-check-verdict="met"]')).toHaveCount(2)
  await expect(checks).toContainText('settings.test.ts › three groups')

  // The task's own files are still listed under the checks.
  await expect(changes.locator('[data-change-row="src/settings/sections.ts"]')).toBeVisible()
})

test('the full review leads with it too', async () => {
  const { window } = launched
  await window.keyboard.press(`${MOD}+Shift+I`)
  const review = window.getByRole('region', { name: 'Review', exact: true })
  await expect(review).toBeVisible({ timeout: 20_000 })
  await expect(review.getByRole('region', { name: 'Done-when checks' })).toContainText(OPEN_CHECK)
  await review.getByRole('button', { name: 'Back to the record' }).click()
  await expect(window.getByRole('region', { name: 'Changes' })).toBeVisible()
})

test('Ask it to cover this sends the check to the task as its next instruction', async () => {
  const { window } = launched
  const changes = window.getByRole('region', { name: 'Changes' })
  await changes.getByRole('button', { name: 'Ask it to cover this' }).click()

  // The instruction lands in the record as the next run's, and the task answers it.
  await expect(window.getByText(`The done-when check c2 "${OPEN_CHECK}" is not met.`, { exact: false }).first()).toBeVisible({
    timeout: 20_000
  })
  await expect(window.getByText('E2E fixture response.').first()).toBeVisible({ timeout: 20_000 })
})
