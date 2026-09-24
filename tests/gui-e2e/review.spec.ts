import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedWorkspacesRegistry } from './helpers/seedWorkspace'

/**
 * Changes taken to the whole work area is the review: the files down the left
 * to tick off as viewed, the open file's diff side by side, a line's number to
 * ask the agent about it, and the way back to the record.
 */
let launched: LaunchedApp
let workspacePath: string

/** Ctrl on Win/Linux, Cmd on macOS — the same split `shortcutLabel` makes. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-review-gui-'))
  mkdirSync(join(workspacePath, 'src'), { recursive: true })
  const source = Array.from({ length: 12 }, (_, i) => `export const line${i + 1} = ${i + 1}`)
  writeFileSync(join(workspacePath, 'src', 'app.ts'), `${source.join('\n')}\n`, 'utf8')
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: workspacePath, stdio: 'ignore' })
  }
  git('init', '-q')
  git('config', 'user.email', 'e2e@example.com')
  git('config', 'user.name', 'e2e')
  git('config', 'core.autocrlf', 'false')
  git('add', '-A')
  git('commit', '-q', '-m', 'seed')
  // One line changed in place, one file new.
  source[5] = 'export const line6 = 60'
  writeFileSync(join(workspacePath, 'src', 'app.ts'), `${source.join('\n')}\n`, 'utf8')
  writeFileSync(join(workspacePath, 'notes.md'), '# Notes\n', 'utf8')

  launched = await launchApp({
    preLaunchSeed: (userDataDir) => seedWorkspacesRegistry(userDataDir, workspacePath, null)
  })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
})

test('reviews the working tree side by side, ticking files off as viewed', async () => {
  const { window } = launched
  const inspector = window.locator('[data-inspector]')
  await expect(inspector).toBeVisible({ timeout: 20_000 })

  // Nothing from a task yet: git's view of the working tree instead.
  await window.getByRole('button', { name: 'Show uncommitted instead' }).click({ timeout: 20_000 })
  await expect(window.locator('[data-change-row="src/app.ts"]')).toBeVisible({ timeout: 20_000 })

  await window.keyboard.press(`${MOD}+Shift+I`)
  const review = window.getByRole('region', { name: 'Review' })
  await expect(review).toBeVisible()
  await expect(inspector).toHaveAttribute('data-dock-expanded', '1')
  await expect(window.getByRole('tablist', { name: 'Inspector' })).toHaveCount(0)
  await expect(review.getByRole('button', { name: 'Back to the record' })).toBeFocused()

  // Opens on the first file in git's order — the new notes.md — split.
  const progress = review.locator('[data-review-progress]')
  await expect(progress).toContainText('0 of 2 viewed')
  const table = review.locator('[data-review-diff="split"]')
  await expect(table).toBeVisible({ timeout: 20_000 })
  await expect(table).toContainText('@@ -0,0 +1 @@')
  await expect(table).toContainText('# Notes')

  // The edited file: git's hunk header and its real line numbers.
  await review.locator('[data-review-row="src/app.ts"]').getByRole('button').click()
  await expect(review.locator('[data-review-file]')).toContainText('app.ts')
  await expect(table).toContainText('@@ -3,7 +3,7 @@')
  await expect(table).toContainText('export const line6 = 60')
  await expect(review.getByRole('button', { name: 'Ask about line 6', exact: true })).toBeVisible()

  // A line's number asks about it; Escape puts the question away unsent.
  await review.getByRole('button', { name: 'Ask about line 6', exact: true }).click()
  const ask = review.getByRole('textbox', { name: 'Ask the agent about line 6', exact: true })
  await expect(ask).toBeFocused()
  await window.keyboard.press('Escape')
  await expect(ask).toHaveCount(0)

  await review.getByRole('checkbox', { name: 'Viewed app.ts' }).click()
  await expect(progress).toContainText('1 of 2 viewed')
  await review.getByRole('radio', { name: 'Unified' }).click()
  await expect(review.locator('[data-review-diff="unified"]')).toBeVisible()

  await review.getByRole('button', { name: 'Back to the record' }).click()
  await expect(inspector).toHaveAttribute('data-dock-expanded', '0')
  await expect(window.getByRole('tablist', { name: 'Inspector' })).toBeVisible()
})
