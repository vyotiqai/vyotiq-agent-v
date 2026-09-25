import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * New task in a narrow column: with the inspector open beside a 1100px window
 * the task column is under 500px. The brief used a fixed two-column grid that
 * left the field about 100px wide, with what the agent will see drawn over it.
 * It stacks now, so the field keeps the column's width.
 */
let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-narrow-brief-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp()
  const added = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  await launched.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1100, height: 760 })
  })
  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('the brief keeps its column width with the inspector open beside it', async () => {
  const { window } = launched
  const brief = window.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 30_000 })
  await window.keyboard.press('Alt+2')
  await expect(window.getByRole('tabpanel', { name: 'Files' })).toBeVisible({ timeout: 20_000 })

  const column = await window.locator('[data-new-task]').boundingBox()
  const field = await brief.boundingBox()
  const sees = await window.getByText('What the agent will see').boundingBox()
  expect(column && field && sees).toBeTruthy()
  // The field spans most of the column, and the aside sits under it, not over it.
  expect(field!.width).toBeGreaterThan(column!.width * 0.6)
  expect(sees!.y).toBeGreaterThan(field!.y + field!.height)
  await brief.fill('Stays typeable at this width')
  await expect(brief).toHaveText('Stays typeable at this width')
})
