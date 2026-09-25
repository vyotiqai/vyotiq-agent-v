import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedAppSettings, seedRunsInUserData, sessionsRootFor } from './helpers/seedWorkspace'

/**
 * Run-error boxes in the real transcript, restored from disk.
 *
 * A reload used to append every persisted failure to the end of the
 * transcript, so an old error kept reappearing under the newest work — most
 * visibly after a prompt was edited and resent, whose failed first attempt
 * stayed on disk. Each session below is one shape of that history.
 */

let launched: LaunchedApp
let workspacePath: string

/** Edited-and-resent prompt: the failed attempt's rows sit ahead of the resend. */
const STALE = {
  runId: 'run-stale-error',
  goal: 'Remove the old sync feature',
  answer: 'Removed it and updated the tests.',
  error: 'Upstream request failed: This Go model requires Global regions.'
}
/** A turn that failed, then a newer prompt that finished. */
const HISTORY = {
  runId: 'run-history-error',
  goal: 'Summarize the release notes',
  followUp: 'Try again with the other model',
  answer: 'Here is the summary.',
  error: 'Connection dropped mid-stream'
}
/** The latest turn failed and nothing has run since. */
const LATEST = {
  runId: 'run-latest-error',
  goal: 'Refactor the parser',
  error: 'Connection lost'
}

function writeJsonl(path: string, rows: unknown[]): void {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8')
}

function seedSession(runId: string, messages: unknown[], events: unknown[]): void {
  const dir = join(sessionsRootFor(launched.userDataDir, workspacePath), runId)
  writeJsonl(join(dir, 'messages.jsonl'), messages)
  writeJsonl(
    join(dir, 'events.jsonl'),
    events.map((row) => {
      const { at, ...event } = row as { at: string } & Record<string, unknown>
      return { at, event: { runId, ...event } }
    })
  )
}

async function openRun(window: Page, goal: string): Promise<void> {
  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()
  await window.getByRole('button', { name: goal, exact: true }).first().click()
}

/** Reload the renderer so everything it knows comes back from main and disk. */
async function reloadWindow(window: Page): Promise<void> {
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.locator('body')).toBeVisible({ timeout: 30_000 })
}

/** The persisted workspace UI state, where dismissed error boxes are remembered. */
function savedUiState(): string {
  const path = join(launched.userDataDir, 'workspaces.json')
  return existsSync(path) ? readFileSync(path, 'utf8') : ''
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-run-error-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({
    preLaunchSeed: (userDataDir) =>
      seedAppSettings(userDataDir, { toolApprovalOnboardingDone: true })
  })

  // Seed before addWorkspace so the first listRuns (and its cache) sees the runs.
  seedRunsInUserData(launched.userDataDir, workspacePath, [
    { runId: STALE.runId, goal: STALE.goal, updatedAt: '2026-09-23T06:05:00.100Z' },
    { runId: HISTORY.runId, goal: HISTORY.goal, updatedAt: '2026-09-23T10:05:10.000Z' },
    { runId: LATEST.runId, goal: LATEST.goal, updatedAt: '2026-09-23T11:00:30.000Z' }
  ])
  seedSession(
    STALE.runId,
    [
      { role: 'user', content: STALE.goal, at: '2026-09-23T06:02:22.778Z' },
      { role: 'assistant', content: STALE.answer }
    ],
    [
      { at: '2026-09-23T06:02:23.004Z', type: 'status', invokeId: 2, status: 'running' },
      {
        at: '2026-09-23T06:02:23.004Z',
        type: 'error',
        invokeId: 2,
        message: STALE.error,
        code: 'PROVIDER_REQUEST'
      },
      { at: '2026-09-23T06:02:23.004Z', type: 'status', invokeId: 2, status: 'error' },
      { at: '2026-09-23T06:02:23.054Z', type: 'status', invokeId: 3, status: 'running' },
      { at: '2026-09-23T06:05:00.000Z', type: 'assistant_message', invokeId: 3, content: STALE.answer },
      { at: '2026-09-23T06:05:00.100Z', type: 'status', invokeId: 3, status: 'done' }
    ]
  )
  seedSession(
    HISTORY.runId,
    [
      { role: 'user', content: HISTORY.goal, at: '2026-09-23T10:00:00.000Z' },
      { role: 'user', content: HISTORY.followUp, at: '2026-09-23T10:05:00.000Z' },
      { role: 'assistant', content: HISTORY.answer }
    ],
    [
      { at: '2026-09-23T10:00:00.100Z', type: 'status', invokeId: 1, status: 'running' },
      {
        at: '2026-09-23T10:00:01.000Z',
        type: 'error',
        invokeId: 1,
        message: HISTORY.error,
        code: 'PROVIDER_NETWORK'
      },
      { at: '2026-09-23T10:00:01.000Z', type: 'status', invokeId: 1, status: 'error' },
      { at: '2026-09-23T10:05:00.100Z', type: 'status', invokeId: 2, status: 'running' },
      { at: '2026-09-23T10:05:09.000Z', type: 'assistant_message', invokeId: 2, content: HISTORY.answer },
      { at: '2026-09-23T10:05:10.000Z', type: 'status', invokeId: 2, status: 'done' }
    ]
  )
  seedSession(
    LATEST.runId,
    [{ role: 'user', content: LATEST.goal, at: '2026-09-23T11:00:00.000Z' }],
    [
      { at: '2026-09-23T11:00:00.100Z', type: 'status', invokeId: 1, status: 'running' },
      {
        at: '2026-09-23T11:00:30.000Z',
        type: 'error',
        invokeId: 1,
        message: LATEST.error,
        code: 'PROVIDER_NETWORK'
      },
      { at: '2026-09-23T11:00:30.000Z', type: 'status', invokeId: 1, status: 'error' }
    ]
  )

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = addRes.data.activePath ?? workspacePath

  // The renderer picks the new workspace up on boot, not from the IPC call.
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('an edited-and-resent prompt does not bring back its failed attempt', async () => {
  const { window } = launched
  await openRun(window, STALE.goal)
  const transcript = window.locator('[data-transcript-scroll]')
  await expect(transcript.getByText(STALE.answer)).toBeVisible({ timeout: 20_000 })

  await expect(window.getByText(STALE.error)).toHaveCount(0)
})

test('an earlier failed turn keeps its box in place, without Retry', async () => {
  const { window } = launched
  await openRun(window, HISTORY.goal)
  const transcript = window.locator('[data-transcript-scroll]')
  await expect(transcript.getByText(HISTORY.answer)).toBeVisible({ timeout: 20_000 })

  const box = transcript.getByRole('alert').filter({ hasText: HISTORY.error })
  await expect(box).toHaveCount(1)
  const followUp = transcript.getByText(HISTORY.followUp, { exact: true }).first()
  // The failure closes the first turn instead of trailing the newest answer.
  const boxBeforeFollowUp = await box.evaluate(
    (node, next) =>
      next instanceof Node &&
      Boolean(node.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING),
    await followUp.elementHandle()
  )
  expect(boxBeforeFollowUp).toBe(true)
  await expect(window.getByRole('button', { name: 'Retry' })).toHaveCount(0)
})

test('the latest failed turn shows one box with Retry and no duplicate banner', async () => {
  const { window } = launched
  await openRun(window, LATEST.goal)
  const transcript = window.locator('[data-transcript-scroll]')
  const box = transcript.getByRole('alert').filter({ hasText: LATEST.error })
  await expect(box).toHaveCount(1, { timeout: 20_000 })

  await expect(box.getByRole('button', { name: 'Retry' })).toBeVisible()
  await expect(window.getByRole('button', { name: 'Retry' })).toHaveCount(1)
  await expect(window.locator('[data-composer-column] [role="alert"]')).toHaveCount(0)
})

// The two tests below dismiss boxes, so they run after the ones that read them.

test('a dismissed error box stays gone after the app reloads', async () => {
  const { window } = launched
  await openRun(window, HISTORY.goal)
  const transcript = window.locator('[data-transcript-scroll]')
  const box = transcript.getByRole('alert').filter({ hasText: HISTORY.error })
  await expect(box).toHaveCount(1, { timeout: 20_000 })

  await box.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(box).toHaveCount(0)
  // A row written before errors carried an errorId is keyed by its own time.
  await expect.poll(savedUiState, { timeout: 15_000 }).toContain(
    'run-error:2026-09-23T10:00:01.000Z'
  )

  await reloadWindow(window)
  await openRun(window, HISTORY.goal)
  await expect(transcript.getByText(HISTORY.answer)).toBeVisible({ timeout: 20_000 })
  await expect(window.getByText(HISTORY.error)).toHaveCount(0)
})

test('dismissing the latest failure quiets the banner too, after a reload as well', async () => {
  const { window } = launched
  const composerAlerts = window.locator('[data-composer-column] [role="alert"]')
  await openRun(window, LATEST.goal)
  const transcript = window.locator('[data-transcript-scroll]')
  const box = transcript.getByRole('alert').filter({ hasText: LATEST.error })
  await expect(box).toHaveCount(1, { timeout: 20_000 })

  await box.getByRole('button', { name: 'Dismiss error' }).click()
  await expect(box).toHaveCount(0)
  await expect(composerAlerts).toHaveCount(0)
  await expect.poll(savedUiState, { timeout: 15_000 }).toContain(
    'run-error:2026-09-23T11:00:30.000Z'
  )

  await reloadWindow(window)
  await openRun(window, LATEST.goal)
  await expect(transcript.getByText(LATEST.goal, { exact: true }).first()).toBeVisible({
    timeout: 20_000
  })
  await expect(window.getByText(LATEST.error, { exact: true })).toHaveCount(0)
  await expect(composerAlerts).toHaveCount(0)
})
