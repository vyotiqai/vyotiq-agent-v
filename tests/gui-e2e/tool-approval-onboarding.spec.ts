import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

const FIXTURE_ASSISTANT_TEXT = 'E2E fixture response.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-approval-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  const addRes = await launched.window.evaluate(async (path) => {
    return window.vyotiq.addWorkspace(path)
  }, workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: false })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
  await expect(launched.window.locator('body')).toBeVisible({ timeout: 30_000 })
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

test('a task started around Set up asks the approval question on first send', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  // No choice on record and no task yet: the window opens on Set up. New task
  // (Ctrl+N) goes around it, so the first send still has to ask.
  await expect(window.getByRole('heading', { name: 'Set up Agent V' })).toBeVisible({ timeout: 20_000 })
  await window.keyboard.press('Control+n')

  const composer = window.getByRole('combobox', { name: 'Brief' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('First send with onboarding')

  // A new task starts from its brief on Ctrl+Enter — Enter is a new line there.
  await composer.press('Control+Enter')

  const question = window.getByRole('dialog', { name: 'What needs your OK?' })
  await expect(question).toBeVisible({ timeout: 10_000 })
  await expect(question.getByRole('button', { name: /Unattended/ })).toContainText(
    'MCP tools and tools the agent writes still ask.'
  )
  await expect(question.getByRole('button', { name: /Edits and commands/ })).toBeFocused()
  await question.getByRole('button', { name: /Edits and commands/ }).click()

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.toolApprovalOnboardingDone).toBe(true)
  expect(settings?.toolApproval?.mode).toBe('mutating')
})
