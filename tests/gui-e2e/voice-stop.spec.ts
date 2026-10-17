import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  A spoken stop reaches the run (docs/voice-mode.md §24.13, A-103/A-105): on
  2026-10-15 "Cancel it." and the voice's own stop left a run going for 70 s,
  because the stop went through the task's composer, which dropped it. Here a
  task's run waits on an approval (so it is still running), voice mode opens on
  that task, and "Cancel it." must cancel the run from main.

  The listener is the scripted fixture: the test speaks through it in main.
*/

let launched: LaunchedApp
let workspacePath: string
let secretWrite: { ok: boolean; error?: unknown } | null = null

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-voice-stop-ws-'))
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/always-allow.json' })
  await launched.window.addInitScript(() => {
    const mic = async (): Promise<MediaStream> => {
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const quiet = ctx.createGain()
      quiet.gain.value = 0.0001
      const out = ctx.createMediaStreamDestination()
      osc.connect(quiet).connect(out)
      osc.start()
      return out.stream
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: mic })
  })
  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  secretWrite = await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    return window.vyotiq.setSecret('openai', 'sk-e2e-voice-fixture')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

// The listener needs the OpenAI key: a runner with no OS keyring can't store one.
test.beforeEach(() => {
  if (secretWrite && !secretWrite.ok) test.skip(true, `setSecret unavailable: ${JSON.stringify(secretWrite.error)}`)
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

/** Say this through the scripted listener, in main. */
async function say(text: string): Promise<void> {
  await launched.app.evaluate((_electron, words) => {
    const stt = (globalThis as { __vyotiqVoiceFixtureStt?: { say: (t: string) => void } }).__vyotiqVoiceFixtureStt
    if (!stt) throw new Error('no voice listener open')
    stt.say(words)
  }, text)
}

function runStatuses(): string[] {
  const root = join(launched.userDataDir, 'workspaces')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((id) => {
    const sessions = join(root, id, 'sessions')
    if (!existsSync(sessions)) return []
    return readdirSync(sessions).flatMap((run) => {
      const file = join(sessions, run, 'status.json')
      return existsSync(file) ? [(JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status] : []
    })
  })
}

test('"Cancel it." stops a run that is waiting on you, from main', async () => {
  const { window } = launched
  await window.keyboard.press('Control+n')
  const brief = window.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Run the tests')
  await brief.press('Control+Enter')
  // The run asks to run a command: it stays running, waiting on you.
  await expect(window.getByRole('button', { name: 'Allow once' }).first()).toBeVisible({ timeout: 30_000 })
  expect(runStatuses()).toEqual(['running'])
  // Open the task, as you would to talk about it.
  await window.getByText('Run the tests', { exact: true }).first().click()
  await expect(window.locator('[data-voice-button="off"]').first()).toBeAttached({ timeout: 20_000 })

  // Voice mode on that task follows its run and asks the approval out loud.
  await window.evaluate(() => (document.querySelector('[data-voice-button="off"]') as HTMLButtonElement | null)?.click())
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'waiting_on_you', { timeout: 15_000 })

  await say('Cancel it.')
  await expect.poll(runStatuses, { timeout: 15_000 }).toEqual(['cancelled'])
  // Cancelled by the voice session in main, not by the window's Stop (chat:cancel logs under [ipc]).
  const log = (): string => {
    const file = join(launched.userDataDir, 'logs', 'vyotiq.log')
    return existsSync(file) ? readFileSync(file, 'utf8') : ''
  }
  await expect.poll(() => /\[voice\][^\n]*Chat cancel/.test(log()), { timeout: 10_000 }).toBe(true)
  expect(/\[ipc\][^\n]*Chat cancel/.test(log())).toBe(false)
  await expect(view).not.toHaveAttribute('data-voice-view', 'waiting_on_you', { timeout: 15_000 })
})
