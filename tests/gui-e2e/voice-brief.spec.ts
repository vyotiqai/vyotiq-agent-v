import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  A-112 (docs/voice-mode.md §24.13): a task said to the New task brief
  started, but the window stayed on New task and the voice never learned the
  run, so it sat in Thinking. The task must open, and the voice must follow
  its run.

  The listener is the scripted fixture: the test speaks through it in main.
  With no chat key the voice has no model, so what you say goes to the agent.
*/

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-voice-brief-ws-'))
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
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    await window.vyotiq.setSecret('openai', 'sk-e2e-voice-fixture')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  try {
    rmSync(workspacePath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
})

async function say(text: string): Promise<void> {
  await launched.app.evaluate((_electron, words) => {
    const stt = (globalThis as { __vyotiqVoiceFixtureStt?: { say: (t: string) => void } }).__vyotiqVoiceFixtureStt
    if (!stt) throw new Error('no voice listener open')
    stt.say(words)
  }, text)
}

/** Each run's workspace folder and status. */
function runs(): Array<{ workspace: string; status: string }> {
  const root = join(launched.userDataDir, 'workspaces')
  if (!existsSync(root)) return []
  return readdirSync(root).flatMap((id) => {
    const sessions = join(root, id, 'sessions')
    if (!existsSync(sessions)) return []
    const workspace = (JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')) as { canonicalPath: string }).canonicalPath
    return readdirSync(sessions).flatMap((run) => {
      const file = join(sessions, run, 'status.json')
      return existsSync(file) ? [{ workspace, status: (JSON.parse(readFileSync(file, 'utf8')) as { status: string }).status }] : []
    })
  })
}

test('a task said to the New task brief opens, and the voice follows its run (A-112)', async () => {
  const { window } = launched
  await window.keyboard.press('Control+n')
  const brief = window.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-voice-button="off"]').first()).toBeAttached({ timeout: 20_000 })
  await window.evaluate(() => (document.querySelector('[data-voice-button="off"]') as HTMLButtonElement | null)?.click())
  const view = window.locator('[data-voice-view]').first()
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  expect(runs()).toEqual([])

  await say('Run the tests.')
  // One task started, and it is the one on screen.
  await expect.poll(() => runs().length, { timeout: 30_000 }).toBe(1)
  // The voice follows the run: its approval is asked out loud, not left in Thinking.
  await expect(view).toHaveAttribute('data-voice-view', 'waiting_on_you', { timeout: 20_000 })
  await expect(window.locator('[aria-label="Brief"][data-composer-input]')).toHaveCount(0, { timeout: 15_000 })
})

/*
  Voice mode from anywhere (§24.15): on Home no task line is on screen, so the
  shortcut used to do nothing. Now it opens New task and starts there.
*/
test('the voice shortcut on Home opens New task and starts listening there', async () => {
  const { window } = launched
  await window.evaluate(() => (document.querySelector('[data-voice-end]') as HTMLButtonElement | null)?.click())
  await expect(window.locator('[data-voice-view]')).toHaveCount(0, { timeout: 15_000 })
  await window.keyboard.press('Escape')
  await window.keyboard.press('Control+Shift+H')
  await expect(window.locator('[data-home]')).toBeVisible({ timeout: 15_000 })
  await expect(window.locator('[aria-label="Brief"][data-composer-input]')).toHaveCount(0)
  await expect(window.locator('[data-voice-button]')).toHaveCount(0)

  await window.keyboard.press('Control+Shift+M')
  await expect(window.locator('[data-voice-view]').first()).toHaveAttribute('data-voice-view', 'listening', { timeout: 20_000 })
})
