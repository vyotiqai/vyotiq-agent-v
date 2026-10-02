import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath, seedAppSettings, seedRunEvents, seedWorkspacesRegistry } from './helpers/seedWorkspace'
import { REWIND_CHECKPOINT_ID, REWIND_FILES, seedRewindTask } from './helpers/seedRewind'

/**
 * The redesign's last gaps, against a real run and real files: a task waiting
 * on you stays in the Inbox whatever was notified; Stop says so and Resume
 * carries on (from the toast and from the header); kept edits are committed
 * from the record's own line, and the commit is said there and in Review.
 */

test.describe('Stop, Resume and the Inbox', () => {
  let launched: LaunchedApp
  let workspacePath: string

  test.beforeAll(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-ported-stop-'))
    mkdirSync(workspacePath, { recursive: true })
    launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/navigator-live.json' })
    const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
    if (!added.ok) throw new Error(added.error)
    workspacePath = requireActivePath(added.data.activePath)
    await launched.window.evaluate(async () => {
      // No notice for a task that needs you: the Inbox must still have it.
      await window.vyotiq.setSettings({
        toolApprovalOnboardingDone: true,
        notifications: { enabled: true, desktop: 'off', agentRunFinished: true, agentRunFailed: true, agentNeedsYou: false, system: true }
      })
      localStorage.removeItem('vyotiq.chatPaneLayout')
    })
    await launched.window.reload()
    await launched.window.waitForLoadState('domcontentloaded')
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
    rmSync(workspacePath, { recursive: true, force: true })
  })

  test('the waiting task is in the Inbox with no notice; Stop says so, and Resume carries on from the toast and the header', async () => {
    const page = launched.window
    const brief = page.getByRole('combobox', { name: 'Brief' })
    await expect(brief).toBeVisible({ timeout: 30_000 })
    await brief.fill('Run the suite and build')
    await brief.press('Control+Enter')

    const nav = page.locator('[data-navigator]')
    await expect(nav.locator('[data-nav-section="needs"]')).toContainText('Run the suite and build', { timeout: 40_000 })

    // The Inbox's Needs you is the task itself: no notice was made, and it can't be dismissed.
    await page.getByRole('button', { name: /^Inbox/ }).click()
    const inbox = page.getByRole('dialog', { name: 'Inbox' })
    const asks = inbox.locator('[data-inbox-group="asks"]')
    await expect(asks).toContainText('Run the suite and build', { timeout: 20_000 })
    await expect(asks.locator('[data-inbox-command]')).toContainText('pnpm build --filter nav-live', { timeout: 20_000 })
    await expect(asks.getByRole('button', { name: /^Dismiss/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Inbox, 1 unread/ })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(inbox).toBeHidden()

    // Stop from the header: it says so, naming the task, with Resume.
    const pane = page.locator('[data-task-pane]').first()
    await pane.getByRole('button', { name: 'Stop', exact: true }).click()
    const toast = page.locator('[data-toast]').filter({ hasText: 'Stopped' })
    await expect(toast).toContainText('Run the suite and build', { timeout: 20_000 })
    await expect(page.locator('[data-receipt-outcome="stopped"]').first()).toBeVisible({ timeout: 20_000 })
    await toast.getByRole('button', { name: 'Resume' }).click()

    // Resume sends what the record's Resume sends, and the task goes again.
    await expect(page.getByText('Continue from where you stopped.').first()).toBeVisible({ timeout: 20_000 })
    await expect(nav.locator('[data-nav-section="needs"]')).toContainText('Run the suite and build', { timeout: 40_000 })

    // Stopped again, the header's ⋯ leads with Resume, and it carries on too.
    await pane.getByRole('button', { name: 'Stop', exact: true }).click()
    await expect(page.locator('[data-toast]').filter({ hasText: 'Stopped' }).first()).toBeVisible({ timeout: 20_000 })
    await pane.getByRole('button', { name: /^More — resume/ }).click({ timeout: 20_000 })
    const menu = page.getByRole('menu', { name: 'Task actions' })
    await expect(menu.getByRole('menuitem').first()).toHaveText('Resume')
    await menu.getByRole('menuitem', { name: 'Resume' }).click()
    await expect(page.getByText('Continue from where you stopped.')).toHaveCount(2, { timeout: 20_000 })
  })
})

test.describe('Kept edits, committed from the record', () => {
  const runId = 'run-ported-commit'
  let launched: LaunchedApp
  let workspacePath: string
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: workspacePath, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  test.beforeAll(async () => {
    workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-ported-commit-'))
    // The repo holds the files as they were before the task; the seed writes the task's versions over them.
    const put = (rel: string, text: string): void => {
      mkdirSync(dirname(join(workspacePath, rel)), { recursive: true })
      writeFileSync(join(workspacePath, rel), text, 'utf8')
    }
    put(REWIND_FILES.changed.path, REWIND_FILES.changed.before)
    put(REWIND_FILES.yours.path, REWIND_FILES.yours.before)
    git('init', '-q', '-b', 'main')
    git('add', '-A')
    git('-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', 'commit', '-q', '-m', 'before')
    git('config', 'user.email', 'e2e@example.com')
    git('config', 'user.name', 'E2E')
    launched = await launchApp({
      preLaunchSeed: (userDataDir) => {
        seedAppSettings(userDataDir, { navigationMode: 'sidebar', toolApprovalOnboardingDone: true })
        seedRewindTask(userDataDir, workspacePath, runId)
        seedRunEvents(userDataDir, workspacePath, runId, [
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
        seedWorkspacesRegistry(userDataDir, workspacePath, runId)
      }
    })
  })

  test.afterAll(async () => {
    if (launched) await closeApp(launched)
    rmSync(workspacePath, { recursive: true, force: true })
  })

  test('Keep all, then the record’s Commit… opens the commit box; the commit is said in the record and in Review', async () => {
    const page = launched.window
    await expect(page.locator('[data-nav-section="review"]')).toContainText('Regroup Settings into App, Agent and System', {
      timeout: 30_000
    })
    await page.getByRole('button', { name: 'Keep all', exact: true }).click({ timeout: 20_000 })

    const kept = page.locator('[data-result-outcome="kept"]')
    await expect(kept).toContainText('Kept, not committed yet', { timeout: 20_000 })
    await kept.getByRole('button', { name: 'Commit…' }).click()

    const message = page.getByRole('textbox', { name: 'Commit message' })
    await expect(message).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('[data-commit-facts]')).toContainText('Commit to main', { timeout: 10_000 })
    await message.fill('Regroup the settings sections\n\nThree groups: App, Agent and System.')
    await message.press('Control+Enter')

    const committed = page.locator('[data-result-outcome="committed"]')
    await expect(committed).toContainText('Committed', { timeout: 30_000 })
    await expect(committed).toContainText('to main')
    // git itself has it, title and body.
    expect(git('log', '-1', '--pretty=%s')).toBe('Regroup the settings sections')
    expect(git('log', '-1', '--pretty=%b')).toBe('Three groups: App, Agent and System.')

    // Changes moved to the new commit; back on This task, it says what became of the task's edits.
    await page.getByRole('button', { name: 'Change scope' }).click()
    await page.getByRole('option', { name: 'This task' }).click()
    await expect(page.locator('[data-changes-settled="committed"]')).toContainText('Committed', { timeout: 20_000 })
    // Pull request goes to the PR tab.
    await committed.getByRole('button', { name: 'Pull request' }).click()
    await expect(page.getByRole('tab', { name: /^PR/, selected: true })).toBeVisible({ timeout: 10_000 })
  })
})
