import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/*
  Dictation with nothing stood in but the microphone: Chromium's fake capture
  device plays a recording of speech into the real getUserMedia, and real
  Whisper on this PC transcribes it — the drafts while listening and the
  finals after each pause.

  Local only. It needs the Whisper models on disk and a 16-bit WAV of speech
  with pauses between phrases, which CI does not have:

    VYOTIQ_E2E_WHISPER_MODELS=<userData>/dictation/models
    VYOTIQ_E2E_SPEECH_WAV=<speech.wav>
    VYOTIQ_E2E_WHISPER_MODEL=whisper-small.en   (optional; or moonshine-base)
*/

const modelsDir = process.env.VYOTIQ_E2E_WHISPER_MODELS ?? ''
const speechWav = process.env.VYOTIQ_E2E_SPEECH_WAV ?? ''
const modelId = process.env.VYOTIQ_E2E_WHISPER_MODEL ?? 'whisper-small.en'
const ready = Boolean(modelsDir && speechWav && existsSync(join(modelsDir, modelId)) && existsSync(speechWav))

test.skip(!ready, 'Set VYOTIQ_E2E_WHISPER_MODELS and VYOTIQ_E2E_SPEECH_WAV to run real Whisper')

/**
 * Hard links, not copies: instant for ~300 MB of weights, and closing the app
 * deletes its userData — which removes the links and leaves the models alone.
 */
function linkTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const e of readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) linkTree(join(from, e.name), join(to, e.name))
    else if (e.isFile()) linkSync(join(from, e.name), join(to, e.name))
  }
}

let launched: LaunchedApp
let workspacePath: string

test.beforeAll(async () => {
  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-dictation-whisper-ws-'))
  launched = await launchApp({
    extraArgs: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${speechWav}`
    ],
    preLaunchSeed: (userDataDir) => {
      const target = join(userDataDir, 'dictation', 'models')
      for (const id of ['whisper-tiny.en', 'whisper-small.en', 'moonshine-base']) {
        if (existsSync(join(modelsDir, id))) linkTree(join(modelsDir, id), join(target, id))
      }
      writeFileSync(
        join(userDataDir, 'settings.json'),
        JSON.stringify({
          dictation: { engine: 'local', localModelId: modelId, holdToTalk: true, enterAction: 'insert' }
        }),
        'utf8'
      )
    }
  })
  const addRes = await launched.window.evaluate(async (path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!addRes.ok) throw new Error(addRes.error)
  workspacePath = requireActivePath(addRes.data.activePath)
  await launched.window.evaluate(() => {
    localStorage.removeItem('vyotiq.chatPaneLayout')
    localStorage.removeItem('vyotiq.rightPanel')
  })
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  rmSync(workspacePath, { recursive: true, force: true })
})

test('real speech lands as words while listening, and Enter inserts the take', async () => {
  test.setTimeout(120_000)
  const { window } = launched
  const expand = window.getByRole('button', { name: /show navigator/i })
  if (await expand.isVisible().catch(() => false)) await expand.click()

  const brief = window.locator('[aria-label="Brief"][data-composer-input]')
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await window.getByRole('button', { name: /^Dictate$/ }).click()
  const strip = window.locator('[data-take]')
  await expect(strip).toHaveAttribute('data-take', 'listening', { timeout: 15_000 })
  await expect(strip.getByText('This PC')).toBeVisible()

  // Watch the field while the recording plays: words must show up before the take ends.
  const t0 = Date.now()
  const timeline: Array<{ ms: number; phase: string | null; text: string }> = []
  let last = ''
  while (Date.now() - t0 < 22_000) {
    const text = ((await brief.textContent()) ?? '').trim()
    const phase = await strip.getAttribute('data-take')
    if (text !== last) {
      timeline.push({ ms: Date.now() - t0, phase, text })
      last = text
    }
    if (/keep the changes small/i.test(text) && !text.endsWith('…')) break
    await window.waitForTimeout(100)
  }
  console.log(timeline.map((t) => `${String(t.ms).padStart(6)} ms  ${t.phase}  ${t.text}`).join('\n'))

  const whileListening = timeline.filter((t) => t.phase === 'listening' && /refactor/i.test(t.text))
  expect(whileListening.length).toBeGreaterThan(0)
  await expect(strip).toHaveAttribute('data-take', 'listening')

  await window.keyboard.press('Enter')
  await expect(strip).toHaveAttribute('data-take', 'inserted', { timeout: 30_000 })
  const final = ((await brief.textContent()) ?? '').trim()
  console.log(`inserted after ${Date.now() - t0} ms: ${final}`)
  expect(final).toMatch(/refactor the settings page/i)
  expect(final).toMatch(/unit tests/i)
  expect(final).not.toMatch(/…/)
  await expect(brief).toHaveAttribute('contenteditable', 'true')
})
