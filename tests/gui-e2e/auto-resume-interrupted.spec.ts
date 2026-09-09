import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  RUN_INTERRUPTED_ERROR,
  seedAppSettings,
  seedInterruptedRun,
  seedWorkspacesRegistry
} from './helpers/seedWorkspace'

const FIXTURE_ASSISTANT_TEXT = 'E2E fixture response.'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-auto-resume-ws-'))
  mkdirSync(workspacePath, { recursive: true })

  launched = await launchApp({
    e2eFixture: true,
    preLaunchSeed: (userDataDir) => {
      seedAppSettings(userDataDir, {
        toolApprovalOnboardingDone: true,
        autoResumeInterruptedRuns: true
      })
      seedInterruptedRun(userDataDir, workspacePath, {
        runId: 'auto-resume-run',
        goal: 'Auto resume test',
        status: 'cancelled',
        resumable: true,
        error: RUN_INTERRUPTED_ERROR,
        step: 1
      })
      seedWorkspacesRegistry(userDataDir, workspacePath, 'auto-resume-run')
    }
  })

  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({
      toolApprovalOnboardingDone: true,
      autoResumeInterruptedRuns: true
    })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
  })
  await launched.window.reload()
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

test('auto-resumes interrupted run without manual Continue click', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  // Auto-resume restarts the interrupted run in the background (it shows in
  // the Home "Running now" panel); open the session to watch it stream.
  await window.getByRole('button', { name: /Auto resume test/i }).first().click()

  await expect(window.getByText(FIXTURE_ASSISTANT_TEXT)).toBeVisible({ timeout: 25_000 })
})
