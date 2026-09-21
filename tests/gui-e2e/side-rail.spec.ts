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
const REVIEW_RUN_ID = 'rail-pending-writes'

/** Ctrl on Win/Linux, Cmd on macOS — the same split `shortcutLabel` makes. */
const MOD = process.platform === 'darwin' ? 'Meta' : 'Control'

const rail = (window: Page) => window.locator('[data-chat-side-rail]')

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-side-rail-gui-'))
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
  await expect(rail(launched.window)).toBeVisible({ timeout: 20_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  if (workspacePath) rmSync(workspacePath, { recursive: true, force: true })
})

/**
 * Close whatever dock is open so the next case starts from the floating rail.
 * Side-dock tabs are portaled into the title bar, so the tablist is not inside
 * `[data-right-dock]` — look for the tab itself, wherever it is hosted.
 */
async function backToRail(window: Page): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    const tabs = window.getByRole('tab', { selected: true })
    if ((await tabs.count()) === 0) break
    const label = (await tabs.first().textContent())?.trim()
    if (!label) break
    await window.getByRole('button', { name: `Close ${label}`, exact: true }).click()
  }
  await expect(rail(window)).toBeVisible()
}

test('every rail chord opens its panel, including the three that had no handler', async () => {
  const { window } = launched

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
    // The same chord closes it again, exactly as the rail tooltip promises.
    await window.keyboard.press(`${MOD}+${key}`)
    await expect(window.locator(`#dock-panel-${panel}`)).toHaveCount(0)
    await expect(rail(window)).toBeVisible()
  }
})

test('the rail is one tab stop that the arrow keys walk', async () => {
  const { window } = launched
  await backToRail(window)

  const buttons = rail(window).getByRole('button')
  await expect(buttons.first()).toBeVisible()
  const tabIndexes = await buttons.evaluateAll((els) =>
    els.map((el) => (el as HTMLElement).tabIndex)
  )
  expect(tabIndexes.filter((t) => t === 0)).toHaveLength(1)

  await buttons.first().focus()
  await window.keyboard.press('ArrowDown')
  await expect(buttons.nth(1)).toBeFocused()
  await window.keyboard.press('End')
  await expect(buttons.last()).toBeFocused()
  await window.keyboard.press('Home')
  await expect(buttons.first()).toBeFocused()

  // Enter on the focused control opens that panel — the rail is operable
  // without a pointer from end to end.
  await window.keyboard.press('Enter')
  await expect(window.locator('#dock-panel-files')).toBeVisible({ timeout: 20_000 })
  await backToRail(window)
})

test('rail buttons announce the chord that toggles them', async () => {
  const { window } = launched
  await backToRail(window)

  const files = rail(window).getByRole('button', { name: /Show files panel/ })
  await expect(files).toHaveAttribute(
    'aria-keyshortcuts',
    process.platform === 'darwin' ? 'Meta+Shift+E' : 'Control+Shift+E'
  )
  await expect(files).toHaveAttribute('aria-pressed', 'false')
})

test('Changes counts the agent writes still waiting to be reviewed', async () => {
  const { window } = launched
  await backToRail(window)

  // Nothing pending on a fresh chat.
  await expect(window.locator('[data-rail-row="changes"] [data-rail-count]')).toHaveCount(0)

  await window.getByRole('button', { name: 'Edit two files', exact: true }).click()
  await expect(window.locator('[data-rail-row="changes"] [data-rail-count]')).toHaveText('2', {
    timeout: 20_000
  })
  await expect(
    window.getByRole('button', { name: /Show changes panel · 2 files to review/ })
  ).toBeVisible()
})
