import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { seedRunsInUserData, seedWorkspacesRegistry, sessionsRootFor } from './helpers/seedWorkspace'

/**
 * The interface pass, end to end in the real shell: search inside tasks,
 * select and archive several, the palette's appearance commands, What's new
 * again, a rebound shortcut, settings to a file and back, and a finished task
 * read out to screen readers.
 */
let launched: LaunchedApp
const workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-phase3-'))
const fileDir = mkdtempSync(join(tmpdir(), 'vyotiq-phase3-file-'))
const settingsFile = join(fileDir, 'agent-v-settings.json')

test.beforeAll(async () => {
  launched = await launchApp({
    e2eFixture: true,
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, workspacePath, [
        { runId: 'run-parser', goal: 'Fix the parser' },
        { runId: 'run-docs', goal: 'Write docs' },
        { runId: 'run-release', goal: 'Ship release' }
      ])
      // Words said inside a task, not in its title.
      appendFileSync(
        join(sessionsRootFor(userDataDir, workspacePath), 'run-parser', 'messages.jsonl'),
        `${JSON.stringify({ role: 'assistant', content: 'I rewrote the tokenizer loop so nested quotes parse.' })}\n`
      )
      seedWorkspacesRegistry(userDataDir, workspacePath, 'run-release')
    }
  })
  const saved = await launched.window.evaluate(() => window.vyotiq.setSettings({ toolApprovalOnboardingDone: true }))
  if (!saved.ok) throw new Error(saved.error)
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
  rmSync(fileDir, { recursive: true, force: true })
})

const rowFor = (page: Page, text: string) => page.locator('[data-nav-row]').filter({ hasText: text })

async function stored<T>(page: Page, pick: (s: Record<string, unknown>) => T): Promise<T> {
  return pick(
    await page.evaluate(async () => {
      const res = await window.vyotiq.getSettings()
      if (!res.ok) throw new Error(res.error)
      return res.data as unknown as Record<string, unknown>
    })
  )
}

async function openSettingsSection(page: Page, name: string): Promise<void> {
  if (!(await page.getByRole('navigation', { name: 'Settings', exact: true }).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /^settings/i }).click()
  }
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name, exact: true }).click()
}

test('search finds a task by what was said in it, and shows the line', async () => {
  const page = launched.window
  await rowFor(page, 'Fix the parser').waitFor({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Search tasks', exact: true }).click()
  const box = page.getByRole('textbox', { name: 'Search tasks' })
  await box.fill('tokenizer')
  await expect(rowFor(page, 'Write docs')).toHaveCount(0)
  await expect(rowFor(page, 'Fix the parser')).toHaveCount(1)
  const snippet = page.locator('[data-nav-snippet]')
  await expect(snippet).toContainText('Agent: I rewrote the tokenizer loop', { timeout: 10_000 })
  await expect(snippet.locator('mark')).toHaveText('tokenizer')
  await box.press('Escape')
  await expect(rowFor(page, 'Write docs')).toHaveCount(1)
})

test('Ctrl-click selects several tasks; Archive puts them away in one go, and Undo brings them back', async () => {
  const page = launched.window
  // Ctrl-click is a right-click on macOS, where Command selects.
  await rowFor(page, 'Write docs').click({ modifiers: ['ControlOrMeta'] })
  await rowFor(page, 'Ship release').click({ modifiers: ['ControlOrMeta'] })
  const bar = page.getByRole('group', { name: 'Selected tasks' })
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Archive' }).click()
  await expect(rowFor(page, 'Write docs')).toHaveCount(0)
  await expect(rowFor(page, 'Ship release')).toHaveCount(0)
  await expect.poll(() => stored(page, (s) => (s.archivedRuns as string[]).length)).toBe(2)
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(rowFor(page, 'Write docs')).toHaveCount(1)
  await expect.poll(() => stored(page, (s) => (s.archivedRuns as string[]).length)).toBe(0)
})

test('the palette switches the theme', async () => {
  const page = launched.window
  await page.keyboard.press('Control+k')
  await page.getByRole('dialog', { name: 'Search and commands' }).locator('input').fill('Theme: Light')
  await page.getByRole('option', { name: 'Theme: Light', exact: true }).click()
  // Light, not dark: this machine's own theme may already be dark.
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
  await expect.poll(() => stored(page, (s) => s.theme)).toBe('light')
})

test('What’s new opens again from About', async () => {
  const page = launched.window
  await openSettingsSection(page, 'About')
  await page.locator('[data-settings-field="about-whats-new"]').getByRole('button', { name: 'Show' }).click()
  const dialog = page.locator('[data-whats-new-modal]')
  await expect(dialog).toBeVisible()
  await page.getByRole('button', { name: 'Got it' }).click()
  await expect(dialog).toHaveCount(0)
})

test('a rebound shortcut runs with its new keys, and its old keys stop', async () => {
  const page = launched.window
  await openSettingsSection(page, 'Shortcuts')
  await page.getByRole('button', { name: 'Change the shortcut for New task' }).click()
  await page.keyboard.press('Control+u')
  await expect.poll(() => stored(page, (s) => s.shortcutOverrides)).toEqual({ newChat: { key: 'u', mod: true, shift: 'forbid' } })
  await expect(page.locator('[data-settings-field="shortcut-newChat"] kbd').last()).toHaveText('U')

  await page.getByRole('button', { name: /^Back to/ }).click()
  await page.keyboard.press('Control+n')
  await expect(page.locator('[data-new-task]')).toHaveCount(0)
  await page.keyboard.press('Control+u')
  await expect(page.locator('[data-new-task]')).toBeVisible({ timeout: 10_000 })
})

test('settings go to a file and come back; reset keeps what it says it keeps', async () => {
  const page = launched.window
  await launched.app.evaluate(({ dialog }, file) => {
    dialog.showSaveDialog = (async () => ({ canceled: false, filePath: file })) as typeof dialog.showSaveDialog
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog
  }, settingsFile)

  await openSettingsSection(page, 'About')
  await page.getByRole('button', { name: 'Export…' }).click()
  await expect.poll(() => existsSync(settingsFile)).toBe(true)
  const doc = JSON.parse(readFileSync(settingsFile, 'utf8')) as { format: string; settings: Record<string, unknown> }
  expect(doc.format).toBe('vyotiq-settings')
  expect(doc.settings.theme).toBe('light')
  expect(doc.settings).not.toHaveProperty('mcpServers')

  // Change something, then import the file: the dialog lists the change first.
  await page.evaluate(() => window.vyotiq.setSettings({ theme: 'dark', keepRecentTurns: 20 }))
  await page.getByRole('button', { name: 'Import…' }).click()
  const preview = page.locator('[data-settings-import-preview]')
  await expect(preview).toContainText('theme')
  await expect(preview).toContainText('keepRecentTurns')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await expect.poll(() => stored(page, (s) => [s.theme, s.keepRecentTurns])).toEqual(['light', 12])

  await page.getByRole('button', { name: 'Reset all…' }).click()
  await page.getByRole('button', { name: 'Reset', exact: true }).click()
  await expect.poll(() => stored(page, (s) => s.theme)).toBe('system')
  // Kept: the approval choice (no trip back to Set up) and the rebound shortcut is a preference, so it's reset.
  expect(await stored(page, (s) => s.toolApprovalOnboardingDone)).toBe(true)
  expect(await stored(page, (s) => s.shortcutOverrides)).toEqual({})
})

test('a finished task is read out to screen readers', async () => {
  const page = launched.window
  await page.getByRole('button', { name: /^Back to/ }).click().catch(() => undefined)
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Say hello')
  await brief.press('Control+Enter')
  // The app root's polite live region (the sr-only status one).
  const live = page.locator('div.sr-only[role="status"][aria-live="polite"][aria-atomic="true"]')
  await expect(live).toContainText(/Say hello|hello/i, { timeout: 30_000 })
})
