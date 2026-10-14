import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Voice mode in the real app (docs/voice-mode.md §24.8): the real mic
  capture, IPC and session in main, with the scripted listener and speaker
  (`VYOTIQ_E2E_FIXTURE=1`). The microphone is an oscillator; its opening can
  be held back, to End voice mode while it's still opening.

  What it checks is what jsdom can't: the window's own key order with a real
  dialog on top, and a mic that arrives after End.
*/

let launched: LaunchedApp
let workspacePath: string
let secretWrite: { ok: boolean; error?: unknown } | null = null

declare global {
  interface Window {
    /** Hold getUserMedia this long (ms) before it answers. */
    __micDelayMs?: number
    /** Whether the last stream handed out still has a live track. */
    __micLive?: () => boolean
    /** The microphone goes away (unplugged, or taken by another app): its track ends. */
    __endMic?: () => void
  }
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-voice-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  launched = await launchApp({ e2eFixture: true })

  await launched.window.addInitScript(() => {
    let last: MediaStream | null = null
    window.__micLive = () => Boolean(last?.getTracks().some((t) => t.readyState === 'live'))
    window.__endMic = () => void last?.getAudioTracks()[0]?.dispatchEvent(new Event('ended'))
    const mic = async (): Promise<MediaStream> => {
      const delay = window.__micDelayMs ?? 0
      if (delay) await new Promise((r) => setTimeout(r, delay))
      const ctx = new AudioContext()
      const osc = ctx.createOscillator()
      const quiet = ctx.createGain()
      quiet.gain.value = 0.0001
      const out = ctx.createMediaStreamDestination()
      osc.connect(quiet).connect(out)
      osc.start()
      last = out.stream
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
    const res = await window.vyotiq.setSecret('openai', 'sk-e2e-voice-fixture')
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

async function openBrief(): Promise<void> {
  const { window } = launched
  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()
  await expect(window.locator('[aria-label="Brief"][data-composer-input]')).toBeVisible({ timeout: 20_000 })
  if (secretWrite && !secretWrite.ok) test.skip(true, `setSecret unavailable: ${JSON.stringify(secretWrite.error)}`)
}

async function startVoice(): Promise<void> {
  // The button sits under the brief's own row; Playwright may call it hidden.
  await launched.window.evaluate(() => (document.querySelector('[data-voice-button="off"]') as HTMLButtonElement | null)?.click())
}

test('Esc closes a dialog over the voice view, and Space presses a focused button', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    window.__micDelayMs = 0
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })

  // Search is a modal dialog: Esc closes it, and voice mode stays as it was.
  await window.keyboard.press('Control+K')
  const dialog = window.getByRole('dialog')
  await expect(dialog).toBeVisible()
  await window.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(view).toHaveAttribute('data-voice-view', 'listening')
  await expect(window.getByText('Press Esc again to end voice mode')).toHaveCount(0)

  // Space on the focused Mute button mutes, and again unmutes: the button's, not push-to-talk.
  const mute = view.getByRole('button', { name: 'Mute' })
  await mute.focus()
  await window.keyboard.press('Space')
  await expect(view).toHaveAttribute('data-voice-view', 'paused')
  await view.getByRole('button', { name: 'Unmute' }).focus()
  await window.keyboard.press('Space')
  await expect(view).toHaveAttribute('data-voice-view', 'listening')

  // With nothing on top, Esc twice ends it.
  await window.locator('body').click({ position: { x: 2, y: 200 } })
  await window.keyboard.press('Escape')
  await window.keyboard.press('Escape')
  await expect(view).toHaveCount(0)

  // The session was kept on disk (§24.8): opened with who listened, closed with an end line.
  const logs = (): string[] => {
    const root = join(launched.userDataDir, 'workspaces')
    if (!existsSync(root)) return []
    return readdirSync(root).flatMap((id) => {
      const dir = join(root, id, 'voice')
      return existsSync(dir) ? readdirSync(dir).map((n) => join(dir, n)) : []
    })
  }
  await expect.poll(() => logs().length).toBeGreaterThan(0)
  await expect
    .poll(() => {
      const kinds = readFileSync(logs()[0]!, 'utf8').trim().split('\n').map((l) => (JSON.parse(l) as { kind: string }).kind)
      return [kinds[0], kinds.at(-1)]
    })
    .toEqual(['start', 'end'])
})

test('End while the mic is still opening leaves no mic running', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    window.__micDelayMs = 1500
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'connecting', { timeout: 5_000 })
  await view.locator('[data-voice-end]').first().click()
  await expect(view).toHaveCount(0)
  // The mic answers after End: it must be stopped at once, not left capturing behind an "off" view.
  await window.waitForTimeout(2_000)
  expect(await window.evaluate(() => window.__micLive?.() ?? false)).toBe(false)
  await expect(window.locator('[data-voice-button="off"]').first()).toBeAttached()
})

test('a microphone that goes away mid-session says so, and Try again brings it back (§24.9, A-64)', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    window.__micDelayMs = 0
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  await window.evaluate(() => window.__endMic?.())
  // Not a view that silently vanishes: the reason, and the way back.
  await expect(view).toHaveAttribute('data-voice-view', 'error')
  await expect(view.getByRole('alert')).toContainText('No microphone found.')
  await view.getByRole('button', { name: 'Try again' }).click()
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  await view.locator('[data-voice-end]').first().click()
  await expect(view).toHaveCount(0)
})
