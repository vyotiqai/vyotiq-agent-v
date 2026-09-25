import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * Pause and Resume on a workspace's index, end to end through main: paused, it
 * says so in Settings and in what the agent sees, and stays paused through an
 * edit; resumed, it carries on to a finished index.
 */
let launched: LaunchedApp
let workspacePath: string
const FILES = 3000

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-index-pause-'))
  for (let d = 0; d < 30; d++) {
    const dir = join(workspacePath, 'src', `m${d}`)
    mkdirSync(dir, { recursive: true })
    for (let f = 0; f < FILES / 30; f++) {
      writeFileSync(join(dir, `f${f}.ts`), `export function helper${d}_${f}(n: number): number {\n  return n * ${f} + ${d}\n}\n`, 'utf8')
    }
  }
  launched = await launchApp({})
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  // Added over IPC: the window reads its open workspaces again on load.
  await launched.window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('pause stops the index and keeps it stopped; resume finishes it', async () => {
  const page = launched.window
  const paused = await page.evaluate((path) => window.vyotiq.codeIndexPause(path), workspacePath)
  expect(paused.ok).toBe(true)

  // Kept by main, and said in the agent's context.
  const state = await page.evaluate(async (path) => {
    const settings = await window.vyotiq.getSettings()
    const context = await window.vyotiq.agentContext({ workspacePath: path })
    return {
      pausedPaths: settings.ok ? settings.data.codeIndex.pausedPaths : null,
      index: context.ok ? context.data.codeIndex.state : null
    }
  }, workspacePath)
  expect(state.pausedPaths).toEqual([workspacePath])
  expect(state.index).toBe('paused')

  // An edit does not restart it.
  writeFileSync(join(workspacePath, 'src', 'm0', 'new.ts'), 'export const x = 1\n', 'utf8')
  const status = await page.evaluate(async () => {
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const res = await window.vyotiq.codeIndexStatus()
    return res.ok ? { phase: res.data.phase, message: res.data.message } : null
  })
  expect(status).toMatchObject({ phase: 'idle', message: 'Indexing paused' })

  // Settings shows it paused, and Resume carries on to a finished index.
  await page.keyboard.press('Control+,')
  await page.getByRole('navigation', { name: 'Settings' }).first().getByRole('button', { name: 'Indexing' }).click({ timeout: 20_000 })
  const row = page.locator('[data-settings-item^="index:"]').filter({ hasText: 'vyotiq-index-pause' })
  await expect(row.getByText('Paused', { exact: true })).toBeVisible({ timeout: 20_000 })
  await row.getByRole('button', { name: /^Resume indexing/ }).click()
  await expect(row.getByText('Ready', { exact: true })).toBeVisible({ timeout: 120_000 })
  await expect(row).toContainText(/3,00\d files/)
  const after = await page.evaluate(async () => {
    const settings = await window.vyotiq.getSettings()
    return settings.ok ? settings.data.codeIndex.pausedPaths : null
  })
  expect(after).toEqual([])
})
