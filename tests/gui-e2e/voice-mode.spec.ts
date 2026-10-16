import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Voice mode in the real app (docs/voice-mode.md §24.8, §26 for the
  redesigned view: Takeover by default, a summary after End): the real mic
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
    self.__micDelayMs = 0
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

test('after End the summary stays on screen, with the conversation one click away, until Close', async () => {
  const { window } = launched
  await openBrief()
  // `window` here is the page; inside evaluate the page's own window is `globalThis`.
  type Page = Window & { __voiceSid?: string }
  await window.evaluate(() => {
    const w = globalThis as unknown as Page
    w.__micDelayMs = 0
    w.vyotiq.onVoiceEvent((e) => {
      w.__voiceSid = e.sessionId
    })
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  // Main says a line (a hand-off the task never took): the conversation has something in it.
  await expect.poll(() => window.evaluate(() => Boolean((globalThis as unknown as Page).__voiceSid))).toBe(true)
  await window.evaluate(() => {
    const w = globalThis as unknown as Page
    return w.vyotiq.voiceHandOffFailed({ sessionId: w.__voiceSid!, handOffId: 'e2e-h1', reason: 'no_task' })
  })
  // Its reply is the live caption under the orb.
  const caption = window.locator('[data-voice-caption="voice"]').first()
  await expect(caption).toBeVisible({ timeout: 15_000 })
  // Read once it has finished saying it (while it speaks, the caption also carries a screen-reader copy).
  await expect(view).not.toHaveAttribute('data-voice-view', 'speaking', { timeout: 30_000 })
  const said = (await caption.textContent()) ?? ''

  await view.locator('[data-voice-end]').first().click()
  await expect(view).toHaveCount(0)
  // End always leaves the summary; nothing was handed to a task.
  const ended = window.locator('[data-voice-ended]')
  await expect(ended).toBeVisible()
  await expect(ended.locator('[data-voice-summary-title]')).toHaveText('No work started')
  await expect(ended.getByRole('button', { name: 'Mute' })).toHaveCount(0)
  await ended.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(ended.locator('[data-voice-line="voice"]').first()).toContainText(said.replace(/\s+/g, ' ').trim().slice(0, 20))
  await ended.getByRole('button', { name: 'Close' }).click()
  await expect(ended).toHaveCount(0)
  await expect(window.locator('[data-voice-button="off"]').first()).toBeAttached()
})

test('End while the mic is still opening leaves no mic running', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    self.__micDelayMs = 1500
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'connecting', { timeout: 5_000 })
  await view.locator('[data-voice-end]').first().click()
  await expect(view).toHaveCount(0)
  // The mic answers after End: it must be stopped at once, not left capturing behind an "off" view.
  await window.waitForTimeout(2_000)
  expect(await window.evaluate(() => self.__micLive?.() ?? false)).toBe(false)
  await expect(window.locator('[data-voice-button="off"]').first()).toBeAttached()
})

test('a microphone that goes away mid-session says so, and Try again brings it back (§24.9, A-64)', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    self.__micDelayMs = 0
  })
  await startVoice()
  const view = window.locator('[data-voice-view]')
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  await window.evaluate(() => self.__endMic?.())
  // Not a view that silently vanishes: the reason, and the way back.
  await expect(view).toHaveAttribute('data-voice-view', 'error')
  await expect(view.getByRole('alert')).toContainText('No microphone found.')
  await view.getByRole('button', { name: 'Try again' }).click()
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  await view.locator('[data-voice-end]').first().click()
  await expect(view).toHaveCount(0)
})

test('every placement shows the session, and the mini window mirrors it and sends its clicks back (§26)', async () => {
  const { window, app } = launched
  await openBrief()
  // Inside evaluate the page's own window is `globalThis` (`window` here is the Page).
  await window.evaluate(() => {
    ;(globalThis as unknown as Window).__micDelayMs = 0
  })
  const place = (voice: Record<string, unknown>) =>
    window.evaluate(async (patch) => {
      const w = globalThis as unknown as Window
      const cur = await w.vyotiq.getSettings()
      if (!cur.ok) return false
      return (await w.vyotiq.setSettings({ voice: { ...cur.data.voice, ...patch } })).ok
    }, voice)
  const placement = window.locator('[data-voice-placement]')

  await startVoice()
  await expect(window.locator('[data-voice-view]').first()).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })
  await expect(placement.first()).toHaveAttribute('data-voice-placement', 'takeover')

  expect(await place({ placement: 'inline' })).toBe(true)
  await expect(placement.first()).toHaveAttribute('data-voice-placement', 'inline')
  await expect(window.locator('[data-voice-composer]')).toHaveAttribute('data-voice-composer', 'listening')

  expect(await place({ placement: 'companion' })).toBe(true)
  await expect(placement.first()).toHaveAttribute('data-voice-placement', 'companion')
  // The drag handle is a hairline (zero width, lit on hover), so it's attached rather than "visible".
  await expect(window.getByRole('separator', { name: 'Resize voice' })).toBeAttached()
  await expect(window.getByRole('complementary', { name: 'Voice mode' })).toBeVisible()

  expect(await place({ placement: 'capsule' })).toBe(true)
  await expect(window.locator('[data-voice-capsule]')).toHaveAttribute('data-voice-capsule', 'pill')
  await window.locator('[data-voice-capsule-open]').click()
  await expect(window.locator('[data-voice-capsule]')).toHaveAttribute('data-voice-capsule', 'card')

  // The mini window: its own window, drawing the main window's session.
  const opened = app.waitForEvent('window', { timeout: 15_000 })
  expect(await place({ placement: 'mini' })).toBe(true)
  const mini = await opened
  expect(mini.url()).toContain('#voice-mini')
  await expect(mini.locator('[data-voice-mini]')).toHaveAttribute('data-voice-mini', 'pill', { timeout: 15_000 })
  // The pill's row is also the open card's top row: its headline is the one to read either way.
  const miniHeadline = mini.locator('[data-voice-mini-row] [data-voice-headline]')
  await expect(miniHeadline).toHaveText('Listening')
  // Nothing of it over the app: the composer's voice bar is the control there.
  await expect(placement).toHaveCount(0)
  await expect(window.locator('[data-voice-bar]')).toBeVisible()
  // A click in the mini window reaches the session, and comes back as its state.
  await mini.locator('[data-voice-mini-row]').getByRole('button', { name: 'Mute' }).click()
  await expect(window.locator('[data-voice-bar]')).toHaveAttribute('data-voice-open', 'paused')
  await expect(miniHeadline).toHaveText('Muted')
  await mini.locator('[data-voice-mini-row]').getByRole('button', { name: 'Mute' }).click()
  await expect(miniHeadline).toHaveText('Listening')

  // Another placement closes it.
  const closed = mini.waitForEvent('close', { timeout: 15_000 })
  expect(await place({ placement: 'takeover' })).toBe(true)
  await closed
  await expect(placement.first()).toHaveAttribute('data-voice-placement', 'takeover')
  await window.locator('[data-voice-end]').first().click()
  await expect(window.locator('[data-voice-view]')).toHaveCount(0)
})

test('hold to talk works while muted and mutes again; the app under the Takeover is inert; Voice settings steps it aside (audit 2026-10-15)', async () => {
  const { window } = launched
  await openBrief()
  await window.evaluate(() => {
    ;(globalThis as unknown as Window).__micDelayMs = 0
  })
  const place = (voice: Record<string, unknown>) =>
    window.evaluate(async (patch) => {
      const w = globalThis as unknown as Window
      const cur = await w.vyotiq.getSettings()
      if (!cur.ok) return false
      return (await w.vyotiq.setSettings({ voice: { ...cur.data.voice, ...patch } })).ok
    }, voice)
  expect(await place({ placement: 'takeover' })).toBe(true)
  await startVoice()
  const view = window.locator('[data-voice-view]').first()
  await expect(view).toHaveAttribute('data-voice-view', 'listening', { timeout: 15_000 })

  // What the Takeover covers can't be reached with Tab: inert while it shows.
  await expect(window.locator('main#main-content')).toHaveAttribute('inert', '')

  // Muted, Space held still talks; let go and it is muted again once it listens.
  await window.locator('body').click({ position: { x: 2, y: 200 } })
  await window.keyboard.press('m')
  await expect(view).toHaveAttribute('data-voice-view', 'paused')
  await window.keyboard.down(' ')
  await expect(view).not.toHaveAttribute('data-voice-view', 'paused')
  await window.keyboard.up(' ')
  await expect(view).toHaveAttribute('data-voice-view', 'paused', { timeout: 15_000 })
  await window.keyboard.press('m')
  await expect(view).toHaveAttribute('data-voice-view', 'listening')

  // Voice settings from the Takeover: it steps aside and Settings is seen.
  await window.locator('[data-voice-engines]').first().click()
  await expect(window.locator('[data-voice-placement="takeover"]')).toHaveCount(0)
  await expect(window.locator('main#main-content')).not.toHaveAttribute('inert', '')
  await expect(window.locator('[data-settings-field="voice-placement"]').first()).toBeAttached({ timeout: 15_000 })
  // The pill standing in brings the Takeover back.
  await window.locator('[data-voice-capsule-open]').click()
  await expect(window.locator('[data-voice-placement="takeover"]')).toHaveCount(1)
  await window.locator('[data-voice-end]').first().click()
  await expect(window.locator('[data-voice-view]')).toHaveCount(0)
})
