/**
 * The navigator's View menu, workspace headings, archive, hover card and
 * Recent folders, end to end in the real shell: the settings write behind
 * Archive, the localStorage view, hover timing and the hit tests of controls
 * that only appear on hover are what jsdom can't show.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  appCanonicalWorkspacePath,
  seedRunsInUserData,
  seedWorkspacesRegistry,
  sessionsRootFor
} from './helpers/seedWorkspace'

let launched: LaunchedApp
const alpha = mkdtempSync(join(tmpdir(), 'vyotiq-nav-alpha-'))
const beta = mkdtempSync(join(tmpdir(), 'vyotiq-nav-beta-'))
const gamma = mkdtempSync(join(tmpdir(), 'vyotiq-nav-gamma-'))
const recent = (path: string): string => path.split(/[\\/]/).pop()!
const now = (minsAgo: number): string => new Date(Date.now() - minsAgo * 60_000).toISOString()

test.beforeAll(async () => {
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, alpha, [
        { runId: 'a-keep', goal: 'Alpha keep me', updatedAt: now(5) },
        { runId: 'a-old', goal: 'Alpha put me away', updatedAt: now(10) },
        { runId: 'a-wt', goal: 'Alpha in a worktree', updatedAt: now(15) }
      ])
      seedRunsInUserData(userDataDir, beta, [{ runId: 'b-one', goal: 'Beta only task', updatedAt: now(20) }])
      // A task whose edits ran in a worktree of its own.
      const wtStatus = join(sessionsRootFor(userDataDir, alpha), 'a-wt', 'status.json')
      const status = JSON.parse(readFileSync(wtStatus, 'utf8')) as Record<string, unknown>
      writeFileSync(
        wtStatus,
        JSON.stringify({ ...status, worktreePath: join(alpha, '.wt', 'fix-login'), worktreeBranch: 'task/fix-login' }),
        'utf8'
      )
      // Two open workspaces, and gamma opened once and closed since.
      seedWorkspacesRegistry(userDataDir, alpha, 'a-keep')
      const registryPath = join(userDataDir, 'workspaces.json')
      const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as {
        openPaths: string[]
        recentPaths: string[]
        uiStateByPath: Record<string, unknown>
      }
      const [alphaCanonical] = registry.openPaths
      const canonical = appCanonicalWorkspacePath
      registry.openPaths = [alphaCanonical!, canonical(beta)]
      registry.recentPaths = [alphaCanonical!, canonical(beta), canonical(gamma)]
      registry.uiStateByPath[canonical(beta)] = registry.uiStateByPath[alphaCanonical!]
      mkdirSync(userDataDir, { recursive: true })
      writeFileSync(registryPath, JSON.stringify(registry), 'utf8')
    }
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
})

const rowFor = (text: string) => launched.window.locator('[data-nav-row]').filter({ hasText: text })

test('the list opens with every workspace under its own heading', async () => {
  await rowFor('Alpha keep me').waitFor({ timeout: 20_000 })
  await expect(rowFor('Beta only task')).toHaveCount(1)
  await expect(launched.window.locator('[data-workspace-heading]')).toHaveCount(2)
})

test('a resting pointer shows the task card, with its worktree branch', async () => {
  const { window } = launched
  await rowFor('Alpha in a worktree').hover()
  const card = window.locator('[data-task-hover-card]')
  // The card waits 500ms on purpose; a loaded machine stretches that well past 3s.
  await expect(card).toBeVisible({ timeout: 10_000 })
  await expect(card).toContainText('task/fix-login')
  // Beside the navigator, not over it.
  const nav = await window.locator('nav[data-navigator]').boundingBox()
  const box = await card.boundingBox()
  expect(box!.x).toBeGreaterThanOrEqual(nav!.x + nav!.width)
  await window.mouse.move(nav!.x + nav!.width + 400, 5)
  await expect(card).toHaveCount(0)
})

test('a heading folds its workspace, and its + starts a task there', async () => {
  const { window } = launched
  const heading = window.locator('[data-workspace-heading]').filter({ hasText: recent(beta) })
  await heading.click()
  await expect(rowFor('Beta only task')).toHaveCount(0)
  await expect(heading).toHaveAttribute('aria-expanded', 'false')
  await heading.click()
  await expect(rowFor('Beta only task')).toHaveCount(1)

  await heading.hover()
  await window.getByRole('button', { name: `New task in ${recent(beta)}` }).click()
  // The New task page opens on beta, though alpha is the active workspace.
  const brief = window.locator('[data-new-task]')
  await expect(brief).toBeVisible({ timeout: 10_000 })
  await expect(brief).toContainText(recent(beta))
  await expect(brief).not.toContainText(recent(alpha))
})

test('the View menu filters, says what it hides, and shows all again', async () => {
  const { window } = launched
  await window.locator('[data-navigator-view]').click()
  await window.getByRole('menuitemcheckbox', { name: 'In place' }).click()
  // A checklist: still open after a toggle.
  await expect(window.getByRole('menuitemcheckbox', { name: 'In place' })).toHaveAttribute('aria-checked', 'false')
  await window.keyboard.press('Escape')
  await expect(rowFor('Alpha keep me')).toHaveCount(0)
  await expect(rowFor('Alpha in a worktree')).toHaveCount(1)
  await expect(window.locator('[data-filter-dot]')).toHaveCount(1)
  await window.locator('[data-nav-filter-notice]').getByRole('button', { name: 'Show all' }).click()
  await expect(rowFor('Alpha keep me')).toHaveCount(1)
  await expect(window.locator('[data-filter-dot]')).toHaveCount(0)
})

test('Archive puts a task away, Undo brings it back, and Show archived lists it', async () => {
  const { window } = launched
  await rowFor('Alpha put me away').click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(rowFor('Alpha put me away')).toHaveCount(0)
  await window.getByRole('button', { name: 'Undo' }).click()
  await expect(rowFor('Alpha put me away')).toHaveCount(1)

  await rowFor('Alpha put me away').click({ button: 'right' })
  await window.getByRole('menuitem', { name: 'Archive' }).click()
  await expect(rowFor('Alpha put me away')).toHaveCount(0)
  await window.locator('[data-navigator-view]').click()
  await window.getByRole('menuitemcheckbox', { name: 'Show archived' }).click()
  await window.keyboard.press('Escape')
  const archived = window.locator('[data-nav-section="archived"]')
  await expect(archived.locator('[data-nav-row]').filter({ hasText: 'Alpha put me away' })).toHaveCount(1)

  // Kept across a reload: settings hold the archive, the view holds Show archived.
  await window.reload()
  await expect(window.locator('[data-nav-section="archived"] [data-nav-row]')).toHaveCount(1, { timeout: 20_000 })
  await window.locator('[data-navigator-view]').click()
  await window.getByRole('menuitemcheckbox', { name: 'Show archived' }).click()
  await window.keyboard.press('Escape')
  await expect(rowFor('Alpha put me away')).toHaveCount(0)
})

test('Recent in the workspace menu opens a closed folder again', async () => {
  const { window } = launched
  await window.locator('[data-workspace-scope]').click()
  await expect(window.getByText('Recent', { exact: true })).toBeVisible()
  await window.getByRole('menuitem', { name: recent(gamma) }).click()
  await expect(window.locator('[data-workspace-heading]').filter({ hasText: recent(gamma) })).toHaveCount(1, {
    timeout: 15_000
  })
})
