import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import {
  seedAppSettings,
  seedInterruptedRun,
  seedWorkspacesRegistry
} from './helpers/seedWorkspace'

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-boot-orphan-ws-'))
  mkdirSync(workspacePath, { recursive: true })

  launched = await launchApp({
    preLaunchSeed: (userDataDir) => {
      // Auto-resume is on by default and would immediately consume the state
      // this spec exists to observe: boot interrupts the orphan, auto-resume
      // restarts it, and under the e2e fixture that replay now persists its own
      // terminal status — so the run reaches `done` and the interrupted dot
      // never renders. That sequence is correct product behaviour (a run that
      // finished has nothing left to continue) and it has its own spec in
      // auto-resume-interrupted.spec.ts. Hold it off here so the assertion is
      // about the interrupt, not about which of the two wins the race.
      seedAppSettings(userDataDir, {
        toolApprovalOnboardingDone: true,
        autoResumeInterruptedRuns: false
      })
      seedInterruptedRun(userDataDir, workspacePath, {
        runId: 'orphan-boot-run',
        goal: 'Orphan boot test',
        status: 'running',
        step: 2
      })
      seedWorkspacesRegistry(userDataDir, workspacePath, 'orphan-boot-run')
    }
  })

  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
  })
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

test('boot interrupts an orphan running run and the navigator says so', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  // Stopped glyph, named: "Interrupted", never shown as still running.
  await expect(window.locator('[data-navigator]').getByTitle('Interrupted', { exact: true })).toBeVisible({
    timeout: 20_000
  })
})
