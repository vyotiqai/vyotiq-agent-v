import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath, seedRunsInUserData, sessionsRootFor } from './helpers/seedWorkspace'

/**
 * Records keep no secrets, and "Delete all my data" really deletes.
 *
 * Real loop against a local OpenAI-compatible server: the first request
 * carries the key the person typed (the run can use it), the record on disk
 * holds a placeholder, and a follow-up — rebuilt from that record — sends the
 * placeholder. Then the confirm quits the app the normal way, and the next
 * launch on the same profile finds an empty folder before it reads a setting.
 */
const KEY = 'sk-proj-e2eAbcdefghijklmnopqrstuvwxyz0123456789'
const PLACEHOLDER = '[redacted:secret]'

let first: LaunchedApp | null = null
let second: LaunchedApp | null = null
let server: Server
const requests: string[] = []
let workspaceDir = ''
let flagDir = ''

function sse(res: ServerResponse, text: string, n: number): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of [
    { id: `c${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
    { id: `c${n}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
  ]) {
    res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  }
  res.end('data: [DONE]\n\n')
}

test.beforeAll(async () => {
  workspaceDir = mkdtempSync(join(tmpdir(), 'vyotiq-wipe-ws-'))
  flagDir = mkdtempSync(join(tmpdir(), 'vyotiq-wipe-flag-'))
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-echo', object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
      req.on('end', () => {
        requests.push(body)
        // The reply repeats the key when it was sent one, as a model might.
        sse(res, body.includes(KEY) ? `Configured the client with ${KEY}.` : 'Done.', requests.length)
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
})

test.afterAll(async () => {
  if (second) await closeApp(second)
  else if (first) await closeApp(first)
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  if (workspaceDir) rmSync(workspaceDir, { recursive: true, force: true })
  if (flagDir) rmSync(flagDir, { recursive: true, force: true })
})

async function openStorage(page: Page): Promise<void> {
  if (!(await page.getByRole('navigation', { name: 'Settings', exact: true }).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /^settings/i }).click()
  }
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Storage', exact: true }).click()
}

test('a key in a brief is stored redacted; Delete all my data empties the profile on the next launch', async () => {
  test.setTimeout(240_000)
  first = await launchApp({
    e2eFixture: false,
    preLaunchSeed: (dir) => {
      seedRunsInUserData(dir, workspaceDir, [{ runId: 'run-old', goal: 'An older task' }])
      mkdirSync(join(dir, 'home'), { recursive: true })
      writeFileSync(join(dir, 'home', 'notes.md'), 'scratch')
    }
  })
  const { window: page, app, userDataDir } = first
  const added = await page.evaluate((path) => window.vyotiq.addWorkspace(path), workspaceDir)
  if (!added.ok) throw new Error(added.error)
  const workspacePath = requireActivePath(added.data.activePath)
  const port = (server.address() as AddressInfo).port
  const saved = await page.evaluate(
    (baseUrl) =>
      window.vyotiq.setSettings({ provider: 'custom', model: 'mock-echo', customOpenAiBaseUrl: baseUrl, toolApprovalOnboardingDone: true }),
    `http://127.0.0.1:${port}/v1`
  )
  if (!saved.ok) throw new Error(saved.error)
  const encryption = await page.evaluate(async () => {
    const status = await window.vyotiq.secretStatus()
    return status.ok && status.data.encryptionAvailable
  })
  if (encryption) {
    const stored = await page.evaluate(() => window.vyotiq.setSecret('openai', 'sk-test-e2e-wipe-000000000000000000'))
    expect(stored.ok).toBe(true)
  }
  await page.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await page.reload()
  await page.waitForLoadState('domcontentloaded')

  // 1. The run gets the key; the record keeps a placeholder.
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill(`Configure the client with ${KEY}`)
  await brief.press('Control+Enter')
  await expect(page.getByText(`Configured the client with ${KEY}.`)).toBeVisible({ timeout: 60_000 })
  expect(requests[0]).toContain(KEY)

  const sessions = sessionsRootFor(userDataDir, workspacePath)
  const runDir = (): string | null => {
    const run = existsSync(sessions) ? readdirSync(sessions).find((name) => name !== 'run-old') : undefined
    return run ? join(sessions, run) : null
  }
  const record = (file: string): string => {
    const dir = runDir()
    return dir && existsSync(join(dir, file)) ? readFileSync(join(dir, file), 'utf8') : ''
  }
  await expect.poll(() => record('messages.jsonl'), { timeout: 15_000 }).toContain(`Configured the client with ${PLACEHOLDER}.`)
  for (const file of ['messages.jsonl', 'events.jsonl', 'contract.md', 'status.json']) {
    expect(record(file), file).not.toContain(KEY)
  }
  expect(record('messages.jsonl')).toContain(`Configure the client with ${PLACEHOLDER}`)
  expect(record('contract.md')).toContain(`Configure the client with ${PLACEHOLDER}`)

  // A follow-up is rebuilt from the record: the model now sees the placeholder.
  const sentBefore = requests.length
  const instruction = page.getByRole('combobox', { name: 'Instruction' })
  await expect(instruction).toBeVisible({ timeout: 20_000 })
  await instruction.fill('Now summarise what you did')
  await instruction.press('Control+Enter')
  await expect.poll(() => requests.length, { timeout: 60_000 }).toBeGreaterThan(sentBefore)
  const followUp = requests[requests.length - 1]!
  expect(followUp).toContain('Now summarise what you did')
  expect(followUp).toContain(PLACEHOLDER)
  expect(followUp).not.toContain(KEY)

  // 2. Delete all my data: measured first, then one confirm.
  await openStorage(page)
  const field = page.locator('[data-settings-field="storage-delete-all"]')
  await field.getByRole('button', { name: 'Delete…' }).click()
  const list = field.getByRole('list', { name: 'What gets deleted' })
  await expect(list).toBeVisible({ timeout: 20_000 })
  await expect(list).toContainText('2 tasks')
  await expect(list).toContainText('1 file')

  // The relaunch is the test's to do (a real one would outlive Playwright);
  // everything else — the request, the normal quit — is the app's own.
  const relaunchFlag = join(flagDir, 'relaunched')
  await app.evaluate(({ app: electronApp }, flag) => {
    electronApp.relaunch = () => {
      process.getBuiltinModule('fs').writeFileSync(flag, String(process.pid))
    }
  }, relaunchFlag)
  const dialogLog = join(flagDir, 'dialogs')
  await app.evaluate(({ dialog }, file) => {
    const original = dialog.showMessageBox.bind(dialog)
    ;(dialog as unknown as { showMessageBox: (...args: unknown[]) => unknown }).showMessageBox = (...args: unknown[]) => {
      const opts = (args.length > 1 ? args[1] : args[0]) as { message?: string }
      process.getBuiltinModule('fs').appendFileSync(file, `${opts.message}\n`)
      return (original as (...a: unknown[]) => unknown)(...args)
    }
  }, dialogLog)
  // Main's own pid: on Windows the process Playwright started is not it.
  const pid = await app.evaluate(() => process.pid)
  const closed = app.waitForEvent('close', { timeout: 60_000 })
  await field.getByRole('button', { name: /^Delete .+ and restart$/ }).click()
  await closed

  // Quitting from Settings asks nothing: no editor is open, so nothing is "still saving".
  expect(existsSync(dialogLog) ? readFileSync(dialogLog, 'utf8') : '').toBe('')
  expect(readFileSync(relaunchFlag, 'utf8')).toBe(String(pid))
  const marker = JSON.parse(readFileSync(join(userDataDir, '.pending-wipe'), 'utf8')) as { pid: number }
  expect(marker.pid).toBe(pid)
  // Nothing is deleted by the process that asked.
  expect(existsSync(join(sessions, 'run-old'))).toBe(true)

  // 3. The next launch on the same profile deletes before it reads anything:
  // even the settings the launcher wrote just now are gone.
  second = await launchApp({ e2eFixture: false, userDataDir })
  expect(existsSync(join(userDataDir, '.pending-wipe'))).toBe(false)
  expect(existsSync(sessions)).toBe(false)
  expect(existsSync(join(userDataDir, 'home', 'notes.md'))).toBe(false)
  const after = await second.window.evaluate(async () => {
    const [settings, secrets] = await Promise.all([window.vyotiq.getSettings(), window.vyotiq.secretStatus()])
    if (!settings.ok || !secrets.ok) throw new Error('bridge failed')
    return { onboarded: settings.data.toolApprovalOnboardingDone, provider: settings.data.provider, openaiKey: secrets.data.keys.openai }
  })
  expect(after.onboarded).toBe(false)
  expect(after.provider).not.toBe('custom')
  expect(after.openaiKey).toBe(false)
  await expect
    .poll(
      () => {
        const logs = join(userDataDir, 'logs')
        return existsSync(logs) ? readdirSync(logs).map((name) => readFileSync(join(logs, name), 'utf8')).join('\n') : ''
      },
      { timeout: 15_000 }
    )
    .toContain('Deleted all app data on request')
})
