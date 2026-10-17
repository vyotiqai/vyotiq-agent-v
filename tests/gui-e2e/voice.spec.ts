import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Voice mode end to end in the real app (docs/voice-mode.md §19): real
  getUserMedia plumbing and Web Audio capture, IPC to main, the real voice
  session with its turn-taking, the real renderer routing a turn to the task,
  the real run path (the fixture replays the model), the real reply tap and
  spoken-summary parsing, and the real player reporting playback back to main.

  The stand-ins are the microphone (an oscillator the test gates on and off,
  via window.__voiceMic) and the vendors: under VYOTIQ_E2E_FIXTURE=1 the
  listener "hears" the next sentence of VYOTIQ_VOICE_FIXTURE_TURNS for each
  stretch of sound followed by a pause, and the speaker returns silence sized
  to the text.
*/

/** What the listener "hears", in order — from the top again in each new voice session. */
const TURNS = ['Fix the flaky test please', 'yes', 'Now update the changelog', 'yes']

let launched: LaunchedApp
let workspacePath: string
let keysWritable = true

/** Every state and caption the voice bar showed, in order (a MutationObserver in the page). */
async function voiceHistory(window: Page): Promise<{ states: string[]; captions: string[] }> {
  return window.evaluate(() => (window as unknown as { __voiceHistory: { states: string[]; captions: string[] } }).__voiceHistory)
}

async function speak(window: Page, ms = 900): Promise<void> {
  await window.evaluate((d) => (window as unknown as { __voiceMic: { speak(ms: number): void } }).__voiceMic.speak(d), ms)
}

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-voice-ws-'))
  mkdirSync(workspacePath, { recursive: true })
  process.env.VYOTIQ_VOICE_FIXTURE_TURNS = JSON.stringify(TURNS)
  launched = await launchApp({ e2eFixture: true, fixtureFile: 'tests/gui-e2e/fixtures/voice-reply.json' })

  // A microphone that is silent until the test talks into it.
  await launched.window.addInitScript(() => {
    let gate: GainNode | null = null
    let ctx: AudioContext | null = null
    const mic = async (): Promise<MediaStream> => {
      ctx = new AudioContext()
      const osc = ctx.createOscillator()
      osc.frequency.value = 220
      gate = ctx.createGain()
      gate.gain.value = 0
      const out = ctx.createMediaStreamDestination()
      osc.connect(gate).connect(out)
      osc.start()
      return out.stream
    }
    Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: mic })
    const history = { states: [] as string[], captions: [] as string[] }
    ;(window as unknown as { __voiceHistory: unknown }).__voiceHistory = history
    const record = (): void => {
      const bar = document.querySelector('[data-voice-open]')
      const state = bar?.getAttribute('data-voice-open') ?? 'none'
      if (history.states.at(-1) !== state) history.states.push(state)
      const caption = document.querySelector('[data-voice-caption]')?.textContent ?? ''
      if (caption && history.captions.at(-1) !== caption) history.captions.push(caption)
    }
    new MutationObserver(record).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
    ;(window as unknown as { __voiceMic: unknown }).__voiceMic = {
      speak(ms: number) {
        if (!gate || !ctx) return
        const t = ctx.currentTime
        gate.gain.setValueAtTime(0.5, t)
        gate.gain.setValueAtTime(0, t + ms / 1000)
      }
    }
  })

  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  expect(addRes.ok).toBe(true)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(async () => {
    await window.vyotiq.setSettings({ toolApprovalOnboardingDone: true })
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  delete process.env.VYOTIQ_VOICE_FIXTURE_TURNS
  rmSync(workspacePath, { recursive: true, force: true })
})

test('with no listening key, the voice button opens “Talk with” instead of failing', async () => {
  const { window } = launched
  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()
  await expect(window.locator('[aria-label="Brief"][data-composer-input]')).toBeVisible({ timeout: 20_000 })

  await window.getByRole('button', { name: 'Talk with the agent' }).click()
  const panel = window.getByRole('dialog', { name: 'Talk with' })
  await expect(panel).toBeVisible()
  await expect(panel.getByText('Deepgram Flux')).toBeVisible()
  await expect(window.locator('[data-voice-bar]')).toHaveCount(0)
  await window.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

test('keys save to secure storage and show in Settings → Voice', async () => {
  const page = launched.window
  const results = await page.evaluate(async () => [
    await window.vyotiq.voiceSetKey({ vendor: 'deepgram', key: 'dg-e2e-key-1234' }),
    await window.vyotiq.voiceSetKey({ vendor: 'elevenlabs', key: 'el-e2e-key-5678' })
  ])
  keysWritable = results.every((r) => r.ok)
  test.skip(!keysWritable, `secure storage unavailable: ${JSON.stringify(results)}`)
  const status = await page.evaluate(async () => window.vyotiq.voiceKeyStatus())
  expect(status.ok && status.data.voice.deepgram).toMatchObject({ set: true, last4: '1234' })
  expect(status.ok && status.data.voice.elevenlabs).toMatchObject({ set: true, last4: '5678' })
})

test('a whole spoken conversation: start a task, approve by voice, hear the reply, follow up, end', async () => {
  test.skip(!keysWritable, 'needs voice keys')
  const { window } = launched
  await window.getByRole('button', { name: 'Talk with the agent' }).click()
  const bar = window.locator('[data-voice-bar]')
  await expect(bar).toBeVisible()
  await expect(bar.locator('[data-voice-caption]')).toHaveText('Listening. Say what you want done.', { timeout: 15_000 })
  await expect(bar.locator('[data-voice-engine="deepgram"]')).toBeVisible()

  // 1. Said on New task: it becomes the task, and the session moves to the task's line.
  await speak(window)
  await expect(window.getByText(TURNS[0]!).first()).toBeVisible({ timeout: 20_000 })

  // 2. The run asks to run the tests; the agent reads it out and waits on you.
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'waiting_on_you', { timeout: 20_000 })
  await expect.poll(async () => (await voiceHistory(window)).captions.join(' | '), { timeout: 10_000 }).toContain(
    'It wants to run pnpm test. Say yes or no.'
  )

  // 3. "yes" answers it — no message is sent — and the run finishes with its spoken summary.
  await speak(window)
  await expect(window.getByText('Awaited the save before asserting in').first()).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-composer-input]').getByText('yes')).toHaveCount(0)
  await expect.poll(async () => (await voiceHistory(window)).captions.join(' | '), { timeout: 15_000 }).toContain(
    'The flaky test is fixed. The save now finishes'
  )
  await expect.poll(async () => (await voiceHistory(window)).states.join(','), { timeout: 15_000 }).toContain('speaking')
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening', { timeout: 20_000 })
  // The written answer never shows the spoken block.
  await expect(window.getByText('<spoken>')).toHaveCount(0)
  await expect(window.getByText(TURNS[1]!, { exact: true })).toHaveCount(0)

  // 4. A follow-up by voice goes to the same task.
  await speak(window)
  await expect(window.getByText(TURNS[2]!).first()).toBeVisible({ timeout: 20_000 })
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'waiting_on_you', { timeout: 20_000 })
  await speak(window)
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening', { timeout: 30_000 })
  // The second run's summary was spoken too. (Its written answer isn't
  // checked: a second fixture run in one task shows no answer even when typed,
  // with no voice involved — reported separately.)
  await expect
    .poll(async () => (await voiceHistory(window)).captions.filter((c) => c.includes('The flaky test is fixed.')).length, {
      timeout: 15_000
    })
    .toBeGreaterThanOrEqual(2)

  // 5. Esc twice ends voice mode; the line comes back.
  await window.locator('body').press('Escape')
  await window.locator('body').press('Escape')
  await expect(bar).toHaveCount(0)
  await expect(window.getByRole('button', { name: 'Talk with the agent' })).toBeVisible()
})

test('the shortcut, mute, read aloud and Settings → Voice', async () => {
  test.skip(!keysWritable, 'needs voice keys')
  const { window } = launched
  // A fresh typed task, so its answer (and its Read aloud) is on screen.
  await window.getByRole('button', { name: 'New task' }).first().click()
  const brief = window.locator('[aria-label="Brief"][data-composer-input]')
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.click()
  await window.keyboard.type('A typed task')
  await window.keyboard.press('Control+Enter')
  await window.getByRole('button', { name: 'Allow once', exact: true }).first().click()
  await expect(window.getByText('Awaited the save before asserting in').first()).toBeVisible({ timeout: 20_000 })

  // Ctrl+Shift+M with nothing focused reaches the task's line (it registered itself).
  await window.locator('body').click({ position: { x: 600, y: 400 } })
  await window.keyboard.press('Control+Shift+M')
  const bar = window.locator('[data-voice-bar]')
  await expect(bar).toBeVisible()
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening', { timeout: 15_000 })

  // M mutes (the session pauses), M again unmutes.
  await window.keyboard.press('m')
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'paused')
  await expect(bar.getByRole('button', { name: 'Unmute' })).toBeVisible()
  await window.keyboard.press('m')
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening')

  // Read aloud is off while the conversation is on (one voice at a time).
  const readAloud = window.locator('[data-read-aloud]').first()
  await expect(readAloud).toBeDisabled()

  // End; Read aloud plays the answer's spoken summary through the real speaker path.
  await bar.getByRole('button', { name: 'End' }).click()
  await expect(bar).toHaveCount(0)
  await expect(readAloud).toBeEnabled()
  // Record every phase the button shows: it must actually play, then finish.
  await window.evaluate(() => {
    const seen: string[] = []
    ;(window as unknown as { __readAloud: string[] }).__readAloud = seen
    const el = document.querySelector('[data-read-aloud]')
    if (!el) return
    new MutationObserver(() => {
      const v = el.getAttribute('data-read-aloud') ?? ''
      if (seen.at(-1) !== v) seen.push(v)
    }).observe(el, { attributes: true })
  })
  await readAloud.click()
  await expect
    .poll(async () => window.evaluate(() => (window as unknown as { __readAloud: string[] }).__readAloud.join(',')), {
      timeout: 10_000
    })
    .toMatch(/playing.*idle/)

  // Settings → Voice shows the saved keys by their last four characters.
  await window.keyboard.press('Control+,')
  const voiceNav = window.getByRole('button', { name: /^Voice$/ }).first()
  await voiceNav.click()
  await expect(window.getByText('••••1234').first()).toBeVisible({ timeout: 10_000 })
  await expect(window.getByText('••••5678').first()).toBeVisible()
  await window.keyboard.press('Escape')
})

test('talking over the agent stops it, and what you said becomes the next turn', async () => {
  test.skip(!keysWritable, 'needs voice keys')
  const { window } = launched
  await window.locator('body').click({ position: { x: 600, y: 400 } })
  await window.keyboard.press('Control+Shift+M')
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening', { timeout: 15_000 })
  const mark = (await voiceHistory(window)).states.length

  await speak(window) // a new session: "Fix the flaky test please"
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'waiting_on_you', { timeout: 20_000 })
  await speak(window) // "yes"
  // The long spoken summary starts; talk over it for a second.
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'speaking', { timeout: 20_000 })
  await window.waitForTimeout(300)
  await speak(window, 1100) // "Now update the changelog"

  // speaking → hearing is only reachable by a barge-in (a natural end goes to listening).
  await expect
    .poll(async () => (await voiceHistory(window)).states.slice(mark).join(','), { timeout: 15_000 })
    .toMatch(/speaking,hearing/)
  // What you said over it is the next turn, sent to the task.
  await expect(window.getByText(TURNS[2]!).last()).toBeVisible({ timeout: 20_000 })
  await expect
    .poll(async () => (await voiceHistory(window)).captions.join(' | '), { timeout: 15_000 })
    .toContain(`“${TURNS[2]}”`)

  await window.locator('body').press('Escape')
  await window.locator('body').press('Escape')
  await expect(window.locator('[data-voice-bar]')).toHaveCount(0)
})

test('opening another task takes the conversation with you', async () => {
  test.skip(!keysWritable, 'needs voice keys')
  const { window } = launched
  await window.locator('body').click({ position: { x: 600, y: 400 } })
  await window.keyboard.press('Control+Shift+M')
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening', { timeout: 15_000 })
  // The first task, from the navigator: the bar comes with it, still listening.
  await window.getByRole('button', { name: /Fix the flaky test please/ }).first().click()
  await expect(window.getByText(TURNS[0]!).first()).toBeVisible({ timeout: 10_000 })
  await expect(window.locator('[data-voice-bar]')).toBeVisible({ timeout: 5_000 })
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', 'listening')
  // And it's still a working conversation there.
  await speak(window)
  await expect(window.locator('[data-voice-open]')).toHaveAttribute('data-voice-open', /hearing|thinking|waiting_on_you/, {
    timeout: 15_000
  })
  await window.locator('[data-voice-bar]').getByRole('button', { name: 'End' }).click()
  await expect(window.locator('[data-voice-bar]')).toHaveCount(0)
})

