import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData, sessionsRootFor } from './helpers/seedWorkspace'

/**
 * The run rating, end to end in the real app: transcript control → IPC →
 * preload → main handler → the per-workspace store on disk.
 *
 * Every other test of this path stubs one of those seams. This one asserts
 * the bytes that actually land in `runFeedback.json`, which is the only
 * evidence that the verdict survives the trip.
 */

let launched: LaunchedApp
let workspacePath: string
const RUN_ID = 'run-rated'
const GOAL = 'Rate this finished run'
const ANSWER = 'Done, I changed one file.'

function storePath(): string {
  return join(dirname(sessionsRootFor(launched.userDataDir, workspacePath)), 'runFeedback.json')
}

function readStore(): { entries?: { runId: string; rating?: string }[] } | null {
  const p = storePath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as { entries?: { runId: string; rating?: string }[] }
  } catch {
    return null
  }
}

function ratingOnDisk(): string | null {
  return readStore()?.entries?.find((e) => e.runId === RUN_ID)?.rating ?? null
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-rating-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()

  // Seed before addWorkspace so the first listRuns (and its cache) sees the run.
  seedRunsInUserData(launched.userDataDir, workspacePath, [
    { runId: RUN_ID, goal: GOAL, updatedAt: '2026-08-08T00:00:10.000Z' }
  ])
  // The seeder writes only the user turn. The control lives on the closing
  // assistant answer of a finished run, so the transcript needs one.
  writeFileSync(
    join(sessionsRootFor(launched.userDataDir, workspacePath), RUN_ID, 'messages.jsonl'),
    `${JSON.stringify({ role: 'user', content: GOAL })}\n` +
      `${JSON.stringify({ role: 'assistant', content: ANSWER })}\n`,
    'utf8'
  )
  // The control only appears once the turn has a terminal outcome, and a
  // restored session reads that from the persisted status event — not from
  // status.json. A real finished run writes this row.
  writeFileSync(
    join(sessionsRootFor(launched.userDataDir, workspacePath), RUN_ID, 'events.jsonl'),
    `${JSON.stringify({
      at: '2026-08-08T00:00:11.000Z',
      event: { type: 'status', status: 'done' }
    })}
`,
    'utf8'
  )

  const addRes = await launched.window.evaluate(
    async (path) => window.vyotiq.addWorkspace(path),
    workspacePath
  )
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = addRes.data.activePath ?? workspacePath

  const listed = await launched.window.evaluate(
    async (path) => window.vyotiq.listRuns(path),
    workspacePath
  )
  expect(listed.ok).toBe(true)
  if (!listed.ok) throw new Error(listed.error)
  expect(listed.data.runs.map((r) => r.goal)).toContain(GOAL)

  // The renderer picks the new workspace up on boot, not from the IPC call.
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('rates a finished run from the transcript and persists the verdict', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  await window.getByRole('button', { name: GOAL, exact: true }).first().click()
  await expect(window.getByText(ANSWER)).toBeVisible({ timeout: 20_000 })

  // Nothing rated yet, so the store holds no verdict for this run.
  expect(ratingOnDisk()).toBeNull()

  const down = window.getByRole('button', { name: 'Mark unhelpful' })
  await expect(down).toBeVisible({ timeout: 15_000 })
  await down.click()

  // Optimistic state flips immediately...
  await expect(window.getByRole('button', { name: 'Marked unhelpful' })).toHaveAttribute(
    'aria-pressed',
    'true'
  )
  // ...and the verdict reaches the store the next run can read.
  await expect.poll(ratingOnDisk, { timeout: 15_000 }).toBe('down')

  // Clicking the active thumb again clears it, in the UI and on disk.
  await window.getByRole('button', { name: 'Marked unhelpful' }).click()
  await expect(window.getByRole('button', { name: 'Mark unhelpful' })).toHaveAttribute(
    'aria-pressed',
    'false'
  )
  await expect.poll(ratingOnDisk, { timeout: 15_000 }).toBeNull()
})
