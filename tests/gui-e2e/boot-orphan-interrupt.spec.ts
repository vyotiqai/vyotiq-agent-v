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
      seedAppSettings(userDataDir, { toolApprovalOnboardingDone: true })
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

test('boot interrupts orphan running run and shows amber sidebar dot', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /expand sidebar/i })
  if (await expand.isVisible().catch(() => false)) {
    await expand.click()
  }

  await expect(window.getByTitle('Interrupted — click to continue')).toBeVisible({
    timeout: 20_000
  })
})
