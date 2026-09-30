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

test('a task started around Set up is held there for the approval choice, then sent', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  // No choice on record and no task yet: the window opens on Set up. New task
  // (Ctrl+N) goes around it, so the first send still has to ask.
  const heading = window.getByRole('heading', { name: 'Set up Agent V' })
  await expect(heading).toBeVisible({ timeout: 20_000 })
  await window.keyboard.press('Control+n')

  const composer = window.getByRole('combobox', { name: 'Brief' })
  await expect(composer).toBeVisible({ timeout: 20_000 })
  await composer.fill('First send with onboarding')

  // A new task starts from its brief on Ctrl+Enter — Enter is a new line there.
  await composer.press('Control+Enter')

  // Set up takes the send: the folder it was written in is already counted,
  // and only the approval choice is left before it goes.
  await expect(heading).toBeVisible({ timeout: 10_000 })
  await expect(window.getByText('Your instruction waits here until you decide what needs your OK.', { exact: false })).toBeVisible()
  await expect(window.locator('[data-setup-step="2"]')).toHaveAttribute('data-state', 'done')
  await expect(window.getByRole('radio', { name: /Unattended/ })).toContainText(
    'MCP tools, tools the agent writes and risky commands still ask.'
  )
  await expect(window.getByRole('radio', { name: /Edits and commands/ })).toHaveAttribute('aria-checked', 'true')
  const send = window.getByRole('button', { name: /Send your instruction/ })
  await expect(send).toBeEnabled({ timeout: 15_000 })
  await send.click()

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 15_000 })
  await expect(heading).toHaveCount(0)

  const settings = await window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    return res.ok ? res.data : null
  })
  expect(settings?.toolApprovalOnboardingDone).toBe(true)
  expect(settings?.toolApproval?.mode).toBe('mutating')
})
