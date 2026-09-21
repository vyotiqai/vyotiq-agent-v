import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * `git init` from the two places that report a workspace has no repository:
 * the empty-session context strip and the Changes panel. Both are manual — a
 * button the user presses — so the proof has to be a real click producing a
 * real `.git` on disk, not a stubbed bridge.
 */

/** Ctrl on Win/Linux, Cmd on macOS — the chord that opens the Changes panel. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

let launched: LaunchedApp
let stripWorkspace: string
let panelWorkspace: string

/** The branch git actually chose, read from disk instead of assumed. */
function branchOnDisk(workspacePath: string): string {
  const head = readFileSync(join(workspacePath, '.git', 'HEAD'), 'utf8').trim()
  const match = /^ref: refs\/heads\/(.+)$/.exec(head)
  if (!match) throw new Error(`unexpected HEAD: ${head}`)
  return match[1]!
}

/**
 * Make `path` the workspace the chat pane is bound to. Clicking its sidebar
 * row only expands it, and a saved pane layout pins each pane to its own
 * workspace regardless of which one is active — so drop the layout and let
 * the pane re-derive from the active workspace.
 */
async function activateWorkspace(window: Page, path: string): Promise<void> {
  const res = await window.evaluate(
    async (target) => window.vyotiq.setActiveWorkspace(target),
    path
  )
  expect(res.ok).toBe(true)
  await window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await window.reload()
  await window.waitForLoadState('domcontentloaded')
  await expect(window.getByRole('combobox', { name: 'Message' })).toBeVisible({ timeout: 20_000 })
}

test.beforeAll(async () => {
  // Plain directories: no .git, and nothing above them is a repository either,
  // because the OS temp dir is not one.
  stripWorkspace = mkdtempSync(join(tmpdir(), 'vyotiq-init-strip-'))
  panelWorkspace = mkdtempSync(join(tmpdir(), 'vyotiq-init-panel-'))

  launched = await launchApp({})
  for (const path of [stripWorkspace, panelWorkspace]) {
    const res = await launched.window.evaluate(
      async (target) => window.vyotiq.addWorkspace(target),
      path
    )
    expect(res.ok).toBe(true)
  }
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  for (const path of [stripWorkspace, panelWorkspace]) {
    try {
      rmSync(path, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('the context strip initializes a repository on click', async () => {
  const { window } = launched
  await activateWorkspace(window, stripWorkspace)

  const card = window.getByRole('group', { name: 'What the agent knows' })
  await expect(card).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText('Not a repo')
  expect(existsSync(join(stripWorkspace, '.git'))).toBe(false)

  await card.getByRole('button', { name: 'Initialize' }).click()

  // Real repository on disk, and the strip reports the branch git chose.
  await expect
    .poll(() => existsSync(join(stripWorkspace, '.git')), { timeout: 15_000 })
    .toBe(true)
  const branch = branchOnDisk(stripWorkspace)
  await expect(card).toContainText(branch, { timeout: 15_000 })
  await expect(card).not.toContainText('Not a repo')
  await expect(card.getByRole('button', { name: 'Initialize' })).toHaveCount(0)
})

test('the Changes panel initializes a repository on click', async () => {
  const { window } = launched
  await activateWorkspace(window, panelWorkspace)

  await window.keyboard.press(`${MOD}+E`)
  const panel = window.locator('#dock-panel-changes')
  await expect(panel).toBeVisible({ timeout: 20_000 })
  await expect(panel).toContainText('Not a git repository', { timeout: 15_000 })
  expect(existsSync(join(panelWorkspace, '.git'))).toBe(false)

  await panel.getByRole('button', { name: 'Initialize repository' }).click()

  await expect
    .poll(() => existsSync(join(panelWorkspace, '.git')), { timeout: 15_000 })
    .toBe(true)
  // The panel re-reads git status itself, so the not-a-repo state has to go.
  await expect(panel).not.toContainText('Not a git repository', { timeout: 15_000 })
  await expect(panel.getByRole('button', { name: 'Initialize repository' })).toHaveCount(0)
})
