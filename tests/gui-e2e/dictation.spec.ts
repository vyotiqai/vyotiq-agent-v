import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Dictation end to end in the real app: real getUserMedia plumbing, real Web
  Audio capture (AudioContext + the ScriptProcessor tap), the real segmenter
  and take controller, IPC to main, and main's fixture transcriber.

  The one stand-in is the microphone itself: getUserMedia returns a stream
  from an oscillator gated on and off like phrases with pauses, so the take
  hears "speech", cuts it at the pauses, and transcribes while listening.
*/

const FIXTURE_TRANSCRIPT = 'E2E dictation transcript.'

let launched: LaunchedApp
let workspacePath: string
/** Result of storing the OpenAI secret — headless Linux CI has no OS keyring. */
let secretWrite: { ok: boolean; error?: unknown } | null = null

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-dictation-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  await launched.window.addInitScript(() => {
    const speakingMic = async (): Promise<MediaStream> => {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      const gate = ctx.createGain()
      gate.gain.value = 0
      // 1.2 s of "phrase", 0.9 s of pause, repeated for a minute.
      const t0 = ctx.currentTime + 0.05
      for (let i = 0; i < 30; i++) {
        gate.gain.setValueAtTime(0.4, t0 + i * 2.1)
        gate.gain.setValueAtTime(0, t0 + i * 2.1 + 1.2)
      }
      const out = ctx.createMediaStreamDestination()
      osc.connect(gate).connect(out)
      osc.start()
      return out.stream
    }
    const devices = navigator.mediaDevices
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: speakingMic })
  })

  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)

  workspacePath = requireActivePath(addRes.data.activePath)
  secretWrite = await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    const res = await window.vyotiq.setSecret('openai', 'sk-e2e-dictation-fixture')
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
    localStorage.removeItem('vyotiq.browserPanelOpen')
    return res
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

test('a take writes into the brief while listening, and Enter inserts it', async () => {
  const { window } = launched

  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const brief = window.locator('[aria-label="Brief"][data-composer-input]')
  await expect(brief).toBeVisible({ timeout: 20_000 })

  // The engine needs the provider secret. On headless Linux there is no OS
  // keyring, setSecret fails, and the mic correctly offers setup instead —
  // skip only when the write demonstrably failed.
  if (secretWrite && !secretWrite.ok) {
    test.skip(true, `setSecret unavailable: ${JSON.stringify(secretWrite.error)}`)
  }

  await window.getByRole('button', { name: /^Dictate$/ }).click()
  const strip = window.locator('[data-take]')
  await expect(strip).toHaveAttribute('data-take', 'listening', { timeout: 10_000 })
  await expect(strip).toHaveAttribute('data-take-open', '')
  // Where the audio goes is named once per take. The token hides under a
  // 420px row, which CI's window reaches, so check it is rendered, not shown.
  await expect(strip.getByTitle(/OpenAI/)).toBeAttached()
  // The level meter moves: some bar is taller than the 2px floor.
  await expect
    .poll(async () =>
      strip.locator('[data-take-meter] span').evaluateAll((bars) => bars.some((b) => (b as HTMLElement).offsetHeight > 4))
    )
    .toBe(true)

  // The first phrase closes at its pause and is transcribed while still listening.
  await expect(brief).toContainText(FIXTURE_TRANSCRIPT, { timeout: 15_000 })
  await expect(strip).toHaveAttribute('data-take', 'listening')
  await expect(brief).toHaveAttribute('contenteditable', 'false')

  await window.keyboard.press('Enter')
  await expect(strip).toHaveAttribute('data-take', 'inserted', { timeout: 15_000 })
  await expect(strip).toContainText('words inserted')
  await expect(brief).toHaveAttribute('contenteditable', 'true')
  await expect(brief).toContainText(FIXTURE_TRANSCRIPT)

  // Undo takes the whole take back out.
  await strip.getByRole('button', { name: /Undo/ }).click()
  await expect(brief).not.toContainText(FIXTURE_TRANSCRIPT)
})

test('Esc discards a take and Restore brings it back listening', async () => {
  const { window } = launched
  // Same guard as above: without a stored key the mic offers setup, not Dictate.
  if (secretWrite && !secretWrite.ok) {
    test.skip(true, `setSecret unavailable: ${JSON.stringify(secretWrite.error)}`)
  }
  const strip = window.locator('[data-take]')
  await window.getByRole('button', { name: /^Dictate$/ }).click()
  await expect(strip).toHaveAttribute('data-take', 'listening', { timeout: 10_000 })
  await window.keyboard.press('Escape')
  await expect(strip).toHaveAttribute('data-take', 'discarded')
  await strip.getByRole('button', { name: 'Restore' }).click()
  await expect(strip).toHaveAttribute('data-take', 'listening', { timeout: 10_000 })
  await window.keyboard.press('Escape')
  await expect(strip).toHaveAttribute('data-take', 'discarded')
})
