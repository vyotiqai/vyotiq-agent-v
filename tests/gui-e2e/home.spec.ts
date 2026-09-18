import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  RUN_INTERRUPTED_ERROR,
  seedAppSettings,
  seedWorkspacesRegistry,
  sessionsRootFor
} from './helpers/seedWorkspace'

/**
 * Home end to end against real persisted state.
 *
 * The workspace is this repository, so the Repositories section reports the
 * branch git itself reports. Every other value on the page comes from files
 * seeded here the way the app writes them — status.json, goal.json,
 * loop.json, receipt.json and the usage ledger — which exercises the whole
 * path: disk → main aggregation → IPC → preload → the Home sections.
 */

let launched: LaunchedApp
const workspacePath = process.cwd()
const branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
  cwd: workspacePath,
  encoding: 'utf8'
}).trim()

const RECEIPT_VERSION = 5
const LOOP_NEXT_AT = new Date(Date.now() + 4 * 3_600_000).toISOString()

function today(): string {
  const now = new Date()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${m}-${d}`
}

type SeedRun = {
  runId: string
  goal: string
  status: 'done' | 'error' | 'cancelled' | 'running'
  minutesAgo: number
  resumable?: true
  error?: string
  goalRuntime?: { status: 'active' | 'paused'; continueCount?: number }
  loop?: { prompt: string; intervalMs: number; nextAt: string }
  receipt?: {
    verifiedAfterLastMutation?: boolean
    toolStats?: Record<string, { ok: number; failed: number }>
  }
  usage?: { inputTokens: number; outputTokens: number; billedCost?: number }
}

function seedRun(userDataDir: string, run: SeedRun): void {
  const dir = join(sessionsRootFor(userDataDir, workspacePath), run.runId)
  mkdirSync(dir, { recursive: true })
  const updatedAt = new Date(Date.now() - run.minutesAgo * 60_000).toISOString()
  // Receipts are written now, so every seeded run lands on today's local day.
  // Dating them by `minutesAgo` instead made `activeDays` depend on the wall
  // clock: a run seeded 10h ago falls on yesterday before ~10:00 local.
  const writtenAt = new Date().toISOString()

  writeFileSync(
    join(dir, 'status.json'),
    JSON.stringify({
      status: run.status,
      step: 1,
      updatedAt,
      goal: run.goal,
      workspacePath,
      ...(run.resumable ? { resumable: true } : {}),
      ...(run.error ? { error: run.error } : {})
    }),
    'utf8'
  )
  writeFileSync(
    join(dir, 'messages.jsonl'),
    `${JSON.stringify({ role: 'user', content: run.goal })}\n`,
    'utf8'
  )

  if (run.goalRuntime) {
    writeFileSync(
      join(dir, 'goal.json'),
      JSON.stringify({
        objective: run.goal,
        status: run.goalRuntime.status,
        createdAt: updatedAt,
        updatedAt,
        ...(run.goalRuntime.continueCount
          ? { continueCount: run.goalRuntime.continueCount }
          : {})
      }),
      'utf8'
    )
  }

  if (run.loop) {
    writeFileSync(
      join(dir, 'loop.json'),
      JSON.stringify({ ...run.loop, status: 'armed' }),
      'utf8'
    )
  }

  if (run.receipt) {
    const byName = run.receipt.toolStats ?? {}
    const totals = Object.values(byName).reduce(
      (acc, stat) => ({ ok: acc.ok + stat.ok, failed: acc.failed + stat.failed }),
      { ok: 0, failed: 0 }
    )
    writeFileSync(
      join(dir, 'receipt.json'),
      JSON.stringify({
        version: RECEIPT_VERSION,
        writtenAt,
        runId: run.runId,
        status: run.status,
        step: 1,
        goal: run.goal,
        compactionCount: 0,
        toolStats: {
          totalCalls: totals.ok + totals.failed,
          ok: totals.ok,
          failed: totals.failed,
          byName
        },
        failureClusters: [],
        unreadEditPaths: [],
        wroteFiles: [],
        diagnostics: { calls: 0, ok: 0, clean: 0 },
        ...(run.receipt.verifiedAfterLastMutation != null
          ? {
              verification: {
                verifiedAfterLastMutation: run.receipt.verifiedAfterLastMutation
              }
            }
          : {}),
        contractExcerpt: ''
      }),
      'utf8'
    )
  }

  if (run.usage) {
    writeFileSync(
      join(dir, 'usage.json'),
      JSON.stringify({
        version: 1,
        lastTotals: {
          steps: 1,
          billedInputTokens: run.usage.inputTokens,
          outputTokens: run.usage.outputTokens,
          billedCost: run.usage.billedCost ?? 0,
          estimatedCost: 0,
          cachedInputTokens: 0,
          reasoningTokens: 0
        },
        days: { [today()]: { ...run.usage } }
      }),
      'utf8'
    )
  }
}

test.beforeAll(async () => {
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, {
        navigationMode: 'home',
        toolApprovalOnboardingDone: true,
        // A cloud provider with no key stored — the real condition the
        // Environment section is meant to surface.
        provider: 'openai'
      })
      seedRun(userDataDir, {
        runId: 'home-failed',
        goal: 'Fix the production login redirect',
        status: 'error',
        minutesAgo: 5,
        error: 'provider returned 500',
        receipt: { toolStats: { apply_patch: { ok: 6, failed: 4 } } },
        usage: { inputTokens: 120_000, outputTokens: 40_000, billedCost: 1.25 }
      })
      seedRun(userDataDir, {
        runId: 'home-interrupted',
        goal: 'Rewrite the export pipeline',
        status: 'cancelled',
        minutesAgo: 20,
        resumable: true,
        error: RUN_INTERRUPTED_ERROR
      })
      seedRun(userDataDir, {
        runId: 'home-unverified',
        goal: 'Update the installation guide',
        status: 'done',
        minutesAgo: 60,
        receipt: { verifiedAfterLastMutation: false },
        usage: { inputTokens: 80_000, outputTokens: 20_000, billedCost: 0.75 }
      })
      seedRun(userDataDir, {
        runId: 'home-goal',
        goal: 'Keep the test suite green',
        status: 'done',
        minutesAgo: 120,
        // Paused, so booting the app does not auto-resume the goal and start a
        // live run — the Activity numbers below must come only from the seed.
        goalRuntime: { status: 'paused', continueCount: 7 },
        receipt: { verifiedAfterLastMutation: true }
      })
      seedRun(userDataDir, {
        runId: 'home-loop',
        goal: 'Watch the nightly build',
        status: 'done',
        minutesAgo: 240,
        loop: {
          prompt: 'Check the nightly build',
          intervalMs: 4 * 3_600_000,
          nextAt: LOOP_NEXT_AT
        },
        receipt: { verifiedAfterLastMutation: true }
      })
      seedRun(userDataDir, {
        runId: 'home-idle',
        goal: 'Draft the release notes',
        status: 'done',
        minutesAgo: 600,
        receipt: { verifiedAfterLastMutation: true }
      })
      seedWorkspacesRegistry(userDataDir, workspacePath, null)
    }
  })
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

test('Home opens on the briefing, not a second session list', async () => {
  const { window } = launched
  await expect(window.getByRole('heading', { name: 'Home' })).toBeVisible({ timeout: 30_000 })
  await expect(window.getByRole('region', { name: /Needs you/ })).toBeVisible()
  await expect(window.getByRole('region', { name: /In flight/ })).toBeVisible()
  await expect(window.getByRole('region', { name: /Repositories/ })).toBeVisible()
  await expect(window.getByRole('region', { name: /Activity/ })).toBeVisible()
  await expect(window.getByRole('region', { name: /^Sessions/ })).toHaveCount(0)
})

test('lays the reference rail beside the session lists, and fits the window', async () => {
  const { app, window } = launched
  const restore = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    const before = win.getBounds()
    win.setBounds({ ...before, width: 1600, height: 950 })
    return before
  })
  try {
    await expect(window.getByRole('region', { name: /Activity/ })).toBeVisible({ timeout: 30_000 })
    const box = await window.evaluate(() => {
      const rect = (id: string): { top: number; left: number } | null => {
        const el = document.getElementById(id)?.closest('section')
        if (!el) return null
        const r = el.getBoundingClientRect()
        return { top: Math.round(r.top), left: Math.round(r.left) }
      }
      const main = document
        .getElementById('home-repositories-heading')
        ?.closest('main') as HTMLElement | null
      return {
        environment: rect('home-environment-heading'),
        attention: rect('home-attention-heading'),
        repositories: rect('home-repositories-heading'),
        clientHeight: main?.clientHeight ?? 0,
        scrollHeight: main?.scrollHeight ?? 0
      }
    })

    // The rail is a second column, not more page: stacking it is what used to
    // push Home past a screen at every window size.
    expect(box.repositories!.left).toBeGreaterThan(box.attention!.left)
    expect(box.repositories!.top).toBe(box.attention!.top)
    // A provider with no key blocks every run, so it cannot render below the
    // sessions — that is where it was invisible without scrolling.
    expect(box.environment!.top).toBeLessThan(box.attention!.top)
    expect(box.scrollHeight).toBeLessThanOrEqual(box.clientHeight)
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setBounds(bounds)
    }, restore)
  }
})

test('Needs you lists the real failure states once each', async () => {
  const region = launched.window.getByRole('region', { name: /Needs you/ })
  await expect(region.getByText('Failed')).toBeVisible({ timeout: 20_000 })
  await expect(region.getByText('Interrupted')).toBeVisible()
  await expect(region.getByText('Unverified edits')).toBeVisible()
  await expect(
    launched.window.getByText('Fix the production login redirect')
  ).toHaveCount(1)
  // Nothing notable happened to this one, so it is on no list.
  await expect(launched.window.getByText('Draft the release notes')).toHaveCount(0)
})

test('In flight reads the goal and loop sidecars from disk', async () => {
  const region = launched.window.getByRole('region', { name: /In flight/ })
  await expect(region.getByText('Goal paused ×7')).toBeVisible({ timeout: 20_000 })
  await expect(region.getByText('Loop in 4h')).toBeVisible()
})

test('Activity outcomes match the seeded receipt statuses exactly', async () => {
  const region = launched.window.getByRole('region', { name: /Activity/ })
  await expect(region.getByText('Sessions', { exact: true })).toBeVisible({ timeout: 20_000 })
  // Five seeded receipts: four done, one error. The interrupted run has no
  // receipt, so it is not an outcome.
  await expect(region.getByText('Completed')).toBeVisible()
  await expect(region.getByText('Completed').locator('..')).toContainText('4')
  await expect(region.getByText('Failed').locator('..')).toContainText('1')
})

test('Repositories reports the branch git reports', async () => {
  const region = launched.window.getByRole('region', { name: /Repositories/ })
  await expect(region.getByText(branch, { exact: true })).toBeVisible({ timeout: 20_000 })
  await expect(region.getByRole('button', { name: /New chat/ })).toBeVisible()
})

test('Activity totals come from the seeded receipts and usage ledgers', async () => {
  const region = launched.window.getByRole('region', { name: /Activity/ })
  // 200k billed input + 60k output across two ledgers.
  await expect(region.getByText('260K')).toBeVisible({ timeout: 20_000 })
  // $1.25 + $0.75 provider-reported.
  await expect(region.getByText('$2')).toBeVisible()
  await expect(region.getByText('1 of 7')).toBeVisible()
  await expect(region.getByRole('img', { name: /Sessions per day/ })).toBeVisible()
  // The only failing tool in the seeded receipts.
  await expect(region.getByText('apply_patch')).toBeVisible()
  await expect(region.getByText('4 of 10')).toBeVisible()
})

test('Activity switches window without losing the panel', async () => {
  const { window } = launched
  const region = window.getByRole('region', { name: /Activity/ })
  await window.getByRole('button', { name: '30d' }).click()
  await expect(region.getByText('1 of 30')).toBeVisible({ timeout: 20_000 })
  await window.getByRole('button', { name: '7d' }).click()
  await expect(region.getByText('1 of 7')).toBeVisible()
})

test('Environment reports the seeded provider having no key', async () => {
  const region = launched.window.getByRole('region', { name: /Environment/ })
  await expect(region.getByText('OpenAI has no API key')).toBeVisible({ timeout: 20_000 })
  await expect(region.getByRole('button', { name: 'Add key' })).toBeVisible()
})

test('opening a session from Home routes into that chat', async () => {
  const { window } = launched
  await window
    .getByRole('button', { name: /^Open Fix the production login redirect/ })
    .click()
  await expect(window.getByRole('region', { name: /Needs you/ })).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Home' })).toBeVisible()
})
