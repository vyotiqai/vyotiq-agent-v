import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  seedRunEvents,
  seedRunsInUserData,
  seedWorkspacesRegistry
} from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

/** A finished run whose two file writes are still waiting to be reviewed. */
const REVIEW_RUN_ID = 'inspector-pending-writes'

/** Ctrl on Win/Linux, Cmd on macOS — the same split `shortcutLabel` makes. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const inspector = (window: Page) => window.locator('[data-inspector]')
const strip = (window: Page) => window.getByRole('tablist', { name: 'Inspector' })
const tab = (window: Page, name: RegExp) => strip(window).getByRole('tab', { name })

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-inspector-gui-'))
  writeFileSync(join(workspacePath, 'note.txt'), 'hello\n', 'utf8')
  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      seedRunsInUserData(userDataDir, workspacePath, [
        { runId: REVIEW_RUN_ID, goal: 'Edit two files' }
      ])
      seedRunEvents(userDataDir, workspacePath, REVIEW_RUN_ID, [
        {
          type: 'writes_checkpoint',
          runId: REVIEW_RUN_ID,
          checkpointId: 'cp-1',
          files: [
            { path: 'note.txt', action: 'modified', undoable: true },
            { path: 'added.txt', action: 'created', undoable: true }
          ]
        }
      ])
      seedWorkspacesRegistry(userDataDir, workspacePath, null)
    }
  })
  // Up by default, on Changes.
  await expect(inspector(launched.window)).toBeVisible({ timeout: 20_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
})

/** Every case starts with the inspector up and docked. */
async function docked(window: Page): Promise<void> {
  if ((await inspector(window).count()) === 0) await window.keyboard.press(`${MOD}+I`)
  await expect(inspector(window)).toBeVisible()
  if ((await inspector(window).getAttribute('data-dock-expanded')) === '1') {
    await window.getByRole('button', { name: /^Back to the record/ }).click()
  }
  await expect(inspector(window)).toHaveAttribute('data-dock-expanded', '0')
}

test('shows all six tabs in one strip, on Changes', async () => {
  const { window } = launched
  await expect(strip(window).getByRole('tab')).toHaveText([
    'Changes',
    'Files',
    'Terminal',
    'Browser',
    'PR',
    'Plan'
  ])
  await expect(tab(window, /^Changes/)).toHaveAttribute('aria-selected', 'true')
  // No rail, no dock tab bar, nothing in the title band.
  await expect(window.locator('[data-chat-side-rail]')).toHaveCount(0)
  await expect(window.locator('[data-dock-tab-bar]')).toHaveCount(0)
})

test('every panel chord shows its tab, and the same chord hides the inspector', async () => {
  const { window } = launched
  await docked(window)

  // Files / Plan / Pull request shipped bindings that Settings and the command
  // palette advertised while nothing in the app listened for them.
  for (const [panel, key] of [
    ['files', 'Shift+E'],
    ['plan', 'Shift+D'],
    ['pr', 'Shift+G'],
    ['changes', 'E'],
    ['terminal', '`']
  ] as const) {
    await window.keyboard.press(`${MOD}+${key}`)
    await expect(window.locator(`#dock-panel-${panel}`)).toBeVisible({ timeout: 20_000 })
    await window.keyboard.press(`${MOD}+${key}`)
    await expect(inspector(window)).toHaveCount(0)
  }
})

test('Ctrl I hides the inspector, and the task header offers it back on the same tab', async () => {
  const { window } = launched
  await docked(window)
  await tab(window, /^Plan/).click()
  await expect(window.locator('#dock-panel-plan')).toBeVisible({ timeout: 20_000 })

  await window.keyboard.press(`${MOD}+I`)
  await expect(inspector(window)).toHaveCount(0)

  const offer = window.locator('[data-task-header]').getByRole('button', { name: /^Show inspector/ })
  await expect(offer).toBeVisible()
  await offer.click()
  await expect(tab(window, /^Plan/)).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('[data-task-header]').getByRole('button', { name: /^Show inspector/ })).toHaveCount(0)
})

test('Alt 1–6 pick tabs in strip order', async () => {
  const { window } = launched
  await docked(window)

  await window.keyboard.press('Alt+2')
  await expect(tab(window, /^Files/)).toHaveAttribute('aria-selected', 'true')
  await expect(window.locator('#dock-panel-files')).toBeVisible({ timeout: 20_000 })
  await window.keyboard.press('Alt+6')
  await expect(tab(window, /^Plan/)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('Alt+1')
  await expect(tab(window, /^Changes/)).toHaveAttribute('aria-selected', 'true')
})

test('Ctrl Shift I expands to the whole work area and back — it never opens DevTools', async () => {
  const { window, app } = launched
  await docked(window)

  await window.keyboard.press(`${MOD}+Shift+I`)
  await expect(inspector(window)).toHaveAttribute('data-dock-expanded', '1')
  await expect(window.locator('[data-agent-column]')).toBeHidden()

  await window.keyboard.press(`${MOD}+Shift+I`)
  await expect(inspector(window)).toHaveAttribute('data-dock-expanded', '0')
  await expect(window.locator('[data-agent-column]')).toBeVisible()

  const devTools = await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().some((w) => w.webContents.isDevToolsOpened())
  )
  expect(devTools).toBe(false)
})

test('the strip is one tab stop that the arrow keys walk', async () => {
  const { window } = launched
  await docked(window)
  await tab(window, /^Changes/).click()

  const tabs = strip(window).getByRole('tab')
  const tabIndexes = await tabs.evaluateAll((els) => els.map((el) => (el as HTMLElement).tabIndex))
  expect(tabIndexes.filter((t) => t === 0)).toHaveLength(1)

  await tab(window, /^Changes/).focus()
  await window.keyboard.press('ArrowRight')
  await expect(tab(window, /^Files/)).toBeFocused()
  await expect(tab(window, /^Files/)).toHaveAttribute('aria-selected', 'true')
  await window.keyboard.press('End')
  await expect(tab(window, /^Plan/)).toBeFocused()
  await window.keyboard.press('Home')
  await expect(tab(window, /^Changes/)).toBeFocused()
})

test('Changes counts the agent writes still waiting to be reviewed', async () => {
  const { window } = launched
  await docked(window)

  await window.getByRole('button', { name: 'Edit two files', exact: true }).click()
  await expect(tab(window, /^Changes/)).toHaveText('Changes2', { timeout: 20_000 })
  await expect(tab(window, /^Changes/)).toHaveAttribute('title', /^2 files to review · /)
})
