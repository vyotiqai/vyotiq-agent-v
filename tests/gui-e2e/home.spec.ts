import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { namedGitBranch } from '../../src/shared/utils/gitBranch'
import {
  RUN_INTERRUPTED_ERROR,
  seedAppSettings,
  seedWorkspacesRegistry,
  sessionsRootFor
} from './helpers/seedWorkspace'

/**
 * Home and Usage end to end against real persisted state.
 *
 * The workspace is this repository, so Workspaces reports the branch git
 * itself reports. Every number on Home and Usage comes from files seeded here
 * the way the app writes them — status.json, receipt.json and the usage
 * ledger — which exercises disk → main aggregation → IPC → the page. The
 * approval is real too: the fixture run asks through the run's own gate, so
 * main holds it as pending and Home answers it the way the record would.
 */

let launched: LaunchedApp
const workspacePath = process.cwd()
const workspaceName = basename(workspacePath)
// Read through namedGitBranch, the same helper the app resolves a branch with:
// a detached checkout (actions/checkout on a PR) reports no branch at all.
const branch = namedGitBranch(
  execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: workspacePath, encoding: 'utf8' })
)
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'
const RECEIPT_VERSION = 5

function today(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}

type SeedRun = {
  runId: string
  goal: string
  status: 'done' | 'error' | 'cancelled'
  minutesAgo: number
  resumable?: true
  error?: string
  receipt?: {
    verifiedAfterLastMutation?: boolean
    toolStats?: Record<string, { ok: number; failed: number }>
    failureClusters?: Array<{ key: string; count: number }>
    wroteFiles?: string[]
  }
  usage?: { inputTokens: number; outputTokens: number; billedCost?: number }
}

function seedRun(userDataDir: string, run: SeedRun): void {
  const dir = join(sessionsRootFor(userDataDir, workspacePath), run.runId)
  mkdirSync(dir, { recursive: true })
  const updatedAt = new Date(Date.now() - run.minutesAgo * 60_000).toISOString()
  // Receipts are written now, so every seeded run lands on today's local day.
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
  writeFileSync(join(dir, 'messages.jsonl'), `${JSON.stringify({ role: 'user', content: run.goal })}\n`, 'utf8')
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
        toolStats: { totalCalls: totals.ok + totals.failed, ok: totals.ok, failed: totals.failed, byName },
        failureClusters: run.receipt.failureClusters ?? [],
        unreadEditPaths: [],
        wroteFiles: run.receipt.wroteFiles ?? [],
        diagnostics: { calls: 0, ok: 0, clean: 0 },
        ...(run.receipt.verifiedAfterLastMutation != null
          ? { verification: { verifiedAfterLastMutation: run.receipt.verifiedAfterLastMutation } }
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

function seedRuns(userDataDir: string): void {
  seedRun(userDataDir, {
    runId: 'home-failed',
    goal: 'Fix the production login redirect',
    status: 'error',
    minutesAgo: 5,
    error: 'provider returned 500',
    receipt: {
      toolStats: { apply_patch: { ok: 6, failed: 4 } },
      failureClusters: [{ key: 'apply_patch: patch did not apply', count: 4 }]
    },
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
    receipt: { verifiedAfterLastMutation: false, wroteFiles: ['docs/install.md', 'README.md'] },
    usage: { inputTokens: 80_000, outputTokens: 20_000, billedCost: 0.75 }
  })
  for (const [runId, goal, minutesAgo] of [
    ['home-goal', 'Keep the test suite green', 120],
    ['home-loop', 'Watch the nightly build', 240],
    ['home-idle', 'Draft the release notes', 600]
  ] as const) {
    seedRun(userDataDir, { runId, goal, status: 'done', minutesAgo, receipt: { verifiedAfterLastMutation: true } })
  }
}

async function goHome(window: Page): Promise<void> {
  await window.keyboard.press(`${MOD}+Shift+H`)
  await expect(window.getByRole('heading', { name: 'What should the agent do?' })).toBeVisible({ timeout: 20_000 })
}

test.describe('Home and Usage', () => {
  test.beforeAll(async () => {
    launched = await launchApp({
      fixtureFile: 'tests/gui-e2e/fixtures/home-approval.json',
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'home', toolApprovalOnboardingDone: true })
        seedRuns(userDataDir)
        seedWorkspacesRegistry(userDataDir, workspacePath, null)
      }
    })
    await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
  })

  test('Home asks what the agent should do, and holds only what the navigator can’t', async () => {
    const { window } = launched
    await expect(window.getByRole('heading', { name: 'What should the agent do?' })).toBeVisible({ timeout: 30_000 })
    await expect(window.getByRole('textbox', { name: 'New task' })).toBeVisible()
    for (const name of ['Needs you', 'Workspaces', 'This week']) {
      await expect(window.getByRole('region', { name })).toBeVisible()
    }
    // The task lists are the navigator's; the analytics are Usage's.
    await expect(window.getByRole('region', { name: /^(Activity|Repositories|In flight|Pinned)/ })).toHaveCount(0)
    await expect(window.getByRole('region', { name: 'Needs you' })).toContainText('Nothing is waiting on you')
    await expect(window.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  })

  test('Workspaces reports the branch git reports', async () => {
    const region = launched.window.getByRole('region', { name: 'Workspaces' })
    await expect(region.getByRole('button', { name: `New task in ${workspaceName}` })).toBeVisible({ timeout: 20_000 })
    if (branch) {
      await expect(region.getByText(branch, { exact: true })).toBeVisible({ timeout: 20_000 })
    } else {
      // Detached HEAD: the app reports no branch, so it must not invent one.
      await expect(region.getByText('HEAD', { exact: true })).toHaveCount(0)
    }
  })

  test('This week sums the seeded receipts and ledgers', async () => {
    const region = launched.window.getByRole('region', { name: 'This week' })
    // Five runs with a receipt today: four done, one failed. The interrupted
    // run wrote no receipt, so it neither counts nor ended.
    await expect(region).toContainText('5tasks', { timeout: 20_000 })
    // $1.25 + $0.75 provider-reported; 200k input + 60k output.
    await expect(region).toContainText('$2.00spent')
    await expect(region).toContainText('260Ktokens')
    await expect(region).toContainText('80%finished')
    await expect(region.getByRole('img', { name: /^Tasks per day/ })).toBeVisible()
  })

  test('Usage carries the analytics, read from the same receipts', async () => {
    const { window } = launched
    await window.getByRole('region', { name: 'This week' }).getByRole('button', { name: 'Usage' }).click()
    const page = window.locator('[data-usage]')
    await expect(page).toBeVisible({ timeout: 20_000 })
    await expect(window.locator('[data-navigator]').getByRole('button', { name: 'Usage' })).toHaveAttribute('aria-current', 'page')
    await expect(page).toContainText('Tasks5on 1 of 7 days', { timeout: 20_000 })
    await expect(page).toContainText('Spend$2.00')
    await expect(page).toContainText('Finished80%1 failed')

    const tools = window.getByRole('region', { name: 'Tool failures' })
    await expect(tools).toContainText('of 10 calls')
    await expect(tools).toContainText('apply_patchpatch did not apply4 of 10')

    const unchecked = window.getByRole('region', { name: 'Unchecked' })
    await expect(unchecked.getByRole('button', { name: /^Update the installation guide/ })).toContainText('2 files')

    await window.getByRole('radio', { name: '30 days' }).click()
    await expect(page).toContainText('on 1 of 30 days', { timeout: 20_000 })
  })

  test('Start sends the line as a task, and Home answers its approval in place', async () => {
    const { window } = launched
    await goHome(window)
    const field = window.getByRole('textbox', { name: 'New task' })
    await field.fill('Run the updater suite and report')
    await field.press('Enter')

    // Started at once — the record, already asking before the command.
    const card = window.locator('[data-tool-approval]')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('run a command?')

    // Home has the same ask, answerable where it is.
    await goHome(window)
    const needs = window.getByRole('region', { name: 'Needs you' })
    const row = needs.getByRole('listitem').filter({ hasText: 'Wants to run pnpm vitest run tests/main/unit/updaterSwap.test.ts' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('Run the updater suite and report')
    // The navigator agrees: the task is under Needs you there too.
    await expect(window.locator('[data-nav-section="needs"]')).toContainText('Run the updater suite and report')
    // And the bell: main's notification names the task and says what it wants,
    // in the same words as the row above.
    await window.getByRole('button', { name: /^Notifications/ }).click()
    const inbox = window.getByRole('dialog', { name: 'Notifications' })
    const ask = inbox.locator('[data-notification-kind="needs_you"]')
    await expect(ask).toContainText('Run the updater suite and report', { timeout: 20_000 })
    await expect(ask).toContainText('Wants to run pnpm vitest run tests/main/unit/updaterSwap.test.ts')
    await window.keyboard.press('Escape')
    await expect(inbox).toBeHidden()

    await row.getByRole('button', { name: 'Allow once' }).click()
    await expect(needs).toContainText('Nothing is waiting on you', { timeout: 20_000 })
    await expect(window.locator('[data-nav-section="needs"]')).toHaveCount(0)

    // The run went on with the command's result and finished.
    await window.locator('[data-navigator]').getByRole('button', { name: /^Run the updater suite and report/ }).click()
    await expect(window.getByText('The updater suite passes.').first()).toBeVisible({ timeout: 20_000 })
    await expect(card).toHaveCount(0)

    // Answered, the ask left the inbox; the finish took its place. The run
    // edited nothing, so it is Finished, not Ready for review.
    await window.getByRole('button', { name: /^Notifications/ }).click()
    await expect(inbox.locator('[data-notification-kind="needs_you"]')).toHaveCount(0)
    const finished = inbox.locator('[data-notification-kind="run_done"]').filter({ hasText: 'Run the updater suite and report' })
    await expect(finished).toContainText('Finished', { timeout: 20_000 })
    await expect(finished.locator('[data-state="done"]')).toHaveCount(1)
    await window.keyboard.press('Escape')
  })

  test('a workspace row opens a new task there', async () => {
    const { window } = launched
    await goHome(window)
    await window.getByRole('region', { name: 'Workspaces' }).getByRole('button', { name: `New task in ${workspaceName}` }).click()
    await expect(window.locator('[data-new-task]')).toBeVisible({ timeout: 20_000 })
  })
})

test.describe('Home when no task can run', () => {
  let blocked: LaunchedApp

  test.beforeAll(async () => {
    blocked = await launchApp({
      preLaunchSeed: (userDataDir) => {
        // A cloud provider with no key stored: nothing can run until one is saved.
        seedAppSettings(userDataDir, { navigationMode: 'home', toolApprovalOnboardingDone: true, provider: 'openai' })
        seedWorkspacesRegistry(userDataDir, workspacePath, null)
      }
    })
    await expect(blocked.window.locator('body')).toBeVisible({ timeout: 30_000 })
  })

  test.afterAll(async () => {
    if (blocked) await closeApp(blocked)
  })

  test('says the provider has no key, and Start opens the brief instead of a run that can’t start', async () => {
    const { window } = blocked
    const needs = window.getByRole('region', { name: 'Needs you' })
    await expect(needs).toContainText('OpenAI has no API key', { timeout: 30_000 })
    await expect(needs.getByRole('button', { name: 'Add key' })).toBeVisible()

    const field = window.getByRole('textbox', { name: 'New task' })
    await field.fill('Tidy the release notes')
    await field.press('Enter')
    await expect(window.locator('[data-new-task]')).toBeVisible({ timeout: 20_000 })
    await expect(window.getByRole('combobox', { name: 'Brief' })).toHaveText('Tidy the release notes')
  })
})
