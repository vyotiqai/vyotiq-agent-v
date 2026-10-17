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
        // A real receipt records when the last edit landed whenever there was
        // one; without it, "not verified after" is a read-only turn whose
        // check failed, which Usage does not count as unchecked.
        ...(run.receipt.verifiedAfterLastMutation != null
          ? {
              verification: {
                lastMutationAt: writtenAt,
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
  await expect(window.locator('[data-day-sentence]')).toBeVisible({ timeout: 20_000 })
}

/** Home leads with the day as its heading, not the word "Home". */
const DAY = new Date().toLocaleDateString(undefined, { weekday: 'long' })

/**
 * Open one of Home's regions from the foot line (the workspaces, the week):
 * under the day sentence one region shows at a time.
 */
async function openFromFoot(window: Page, region: 'workspaces' | 'week'): Promise<void> {
  const name = region === 'workspaces' ? 'Workspaces' : 'This week'
  if (await window.getByRole('region', { name }).isVisible()) return
  await window.locator(`[data-home-foot] [data-foot="${region}"]`).click()
  await expect(window.getByRole('region', { name })).toBeVisible({ timeout: 20_000 })
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

  test('Home leads with the day and one sentence', async () => {
    const { window } = launched
    await expect(window.getByRole('heading', { name: DAY, exact: true, level: 1 })).toBeVisible({ timeout: 30_000 })
    await expect(window.locator('[data-day-sentence]')).toBeVisible()
    // The one place to type is New task's brief under the sentence: the brief and its next check.
    const brief = window.locator('[data-home] [data-home-brief]')
    await expect(brief.getByRole('combobox', { name: 'Brief' })).toBeVisible()
    await expect(window.locator('[data-home]').getByRole('textbox')).toHaveCount(1)
    await expect(brief.getByRole('textbox', { name: 'New check' })).toBeVisible()
    // Nothing waits on you, so the sentence doesn't say anything does and Needs you isn't open.
    await expect(window.locator('[data-day-sentence]')).not.toContainText('need you')
    await expect(window.locator('[data-home]').getByRole('region', { name: 'Needs you' })).toHaveCount(0)
    // The workspaces and the week stay one press away, on the foot line.
    await expect(window.locator('[data-home-foot] [data-foot="workspaces"]')).toBeVisible()
    await expect(window.locator('[data-home-foot] [data-foot="week"]')).toBeVisible({ timeout: 20_000 })
    // The task lists are the navigator's; the analytics are Usage's.
    await expect(window.getByRole('region', { name: /^(Activity|Repositories|In flight|Pinned)/ })).toHaveCount(0)
    await expect(window.getByRole('button', { name: 'Home' })).toHaveAttribute('aria-current', 'page')
  })

  test('Workspaces reports the branch git reports', async () => {
    await openFromFoot(launched.window, 'workspaces')
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
    await openFromFoot(launched.window, 'week')
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
    await openFromFoot(window, 'week')
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

  test('Home answers a started task’s approval in place', async () => {
    const { window } = launched
    await goHome(window)
    await openFromFoot(window, 'workspaces')
    await window.getByRole('region', { name: 'Workspaces' }).getByRole('button', { name: `New task in ${workspaceName}` }).click()
    // Started from Home's own brief: the task opens in its pane as it starts.
    const brief = window.locator('[data-home-brief]').getByRole('combobox', { name: 'Brief' })
    await expect(brief).toBeVisible({ timeout: 20_000 })
    await brief.fill('Run the updater suite and report')
    // A new task starts from its brief on Ctrl+Enter — Enter is a new line there.
    await brief.press('Control+Enter')
    await expect(window.locator('[data-home]')).toHaveCount(0)

    // Started at once — the record, already asking before the command.
    const card = window.locator('[data-tool-approval]')
    await expect(card).toBeVisible({ timeout: 20_000 })
    await expect(card).toContainText('run a command?')

    // Home has the same ask, answerable where it is.
    await goHome(window)
    // Home's own region: the navigator's reads "Needs you 1", and its row says the ask too.
    const needs = window.locator('[data-home]').getByRole('region', { name: 'Needs you' })
    const row = needs.getByRole('listitem').filter({ hasText: 'Wants to run pnpm vitest run tests/main/unit/updaterSwap.test.ts' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toContainText('Run the updater suite and report')
    // The navigator agrees: the task is under Needs you there too.
    await expect(window.locator('[data-nav-section="needs"]')).toContainText('Run the updater suite and report')
    // And the bell: the ask leads the Inbox, naming the task and the command it
    // waits on, with the same Allow once / Deny under it.
    await window.getByRole('button', { name: /^Inbox/ }).click()
    const inbox = window.getByRole('dialog', { name: 'Inbox' })
    const ask = inbox.locator('[data-notification-kind="needs_you"]')
    await expect(ask).toContainText('Run the updater suite and report', { timeout: 20_000 })
    await expect(ask.locator('[data-inbox-command]')).toContainText('pnpm vitest run tests/main/unit/updaterSwap.test.ts')
    const asks = inbox.locator('[data-inbox-group="asks"]')
    await expect(asks.getByRole('button', { name: 'Allow once' })).toBeVisible()
    await window.keyboard.press('Escape')
    await expect(inbox).toBeHidden()

    await row.getByRole('button', { name: 'Allow once' }).click()
    // Answered: the sentence stops saying it, and Needs you closes with nothing in it.
    await expect(window.locator('[data-day-sentence]')).not.toContainText('need you', { timeout: 20_000 })
    await expect(needs).toHaveCount(0)
    await expect(window.locator('[data-nav-section="needs"]')).toHaveCount(0)

    // The run went on with the command's result and finished.
    await window.locator('[data-navigator]').getByRole('button', { name: /^Run the updater suite and report/ }).click()
    await expect(window.getByText('The updater suite passes.').first()).toBeVisible({ timeout: 20_000 })
    await expect(card).toHaveCount(0)

    // Answered, the ask left the inbox; the finish took its place. The run
    // edited nothing, so it is Finished, not Ready for review.
    await window.getByRole('button', { name: /^Inbox/ }).click()
    await expect(inbox.locator('[data-notification-kind="needs_you"]')).toHaveCount(0)
    const finished = inbox.locator('[data-notification-kind="run_done"]').filter({ hasText: 'Run the updater suite and report' })
    await expect(finished).toContainText('Finished', { timeout: 20_000 })
    await expect(finished.locator('[data-state="done"]')).toHaveCount(1)
    await window.keyboard.press('Escape')
  })

  test('a workspace row points Home’s brief there, ready to type', async () => {
    const { window } = launched
    await goHome(window)
    await openFromFoot(window, 'workspaces')
    await window.getByRole('region', { name: 'Workspaces' }).getByRole('button', { name: `New task in ${workspaceName}` }).click()
    // Home stays: the brief under the sentence is that workspace's, with the caret in it.
    const brief = window.locator('[data-home] [data-home-brief]')
    await expect(brief.locator('[data-task-header]')).toContainText(workspaceName)
    await expect(brief.getByRole('combobox', { name: 'Brief' })).toBeFocused({ timeout: 20_000 })
    await expect(window.locator('[data-new-task]')).toHaveCount(0)
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

  test('says the provider has no key', async () => {
    const { window } = blocked
    const needs = window.getByRole('region', { name: 'Needs you' })
    await expect(needs).toContainText('OpenAI has no API key', { timeout: 30_000 })
    await expect(needs.getByRole('button', { name: 'Add key' })).toBeVisible()
  })
})
