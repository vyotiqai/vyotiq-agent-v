import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * An agent-built tool is arbitrary Node the agent wrote. It runs with the
 * cleaned environment every other child process gets, not the app's own:
 * whatever secrets the app was started with stay out of it.
 *
 * Real loop, real utilityProcess: a local OpenAI-compatible server asks for
 * the tool, the person allows it, and the tool reports what it can see. The
 * server reads that report back out of the next request.
 */
let launched: LaunchedApp
let workspacePath: string
let server: Server
let completions = 0
let toolReport: string | null = null

const SECRET_NAME = 'VYOTIQ_E2E_SECRET_PROBE'
const TOOL_NAME = 'env_probe'

test.setTimeout(120_000)

function seedTool(userDataDir: string): void {
  const dir = join(userDataDir, 'agent-tools')
  mkdirSync(dir, { recursive: true })
  const header = JSON.stringify({
    name: TOOL_NAME,
    description: 'Reports which environment variables the tool process can see.',
    inputSchema: { type: 'object', properties: {} }
  })
  writeFileSync(
    join(dir, `${TOOL_NAME}.mjs`),
    `/* @agent-tool ${header} */\n\nexport async function handler() {\n` +
      `  return { hasSecret: ${JSON.stringify(SECRET_NAME)} in process.env, hasPath: 'PATH' in process.env || 'Path' in process.env }\n}\n`,
    'utf8'
  )
}

function sse(res: import('node:http').ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-tools', object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString('utf8')
      })
      req.on('end', () => {
        completions += 1
        const id = `c${completions}`
        const report = /hasSecret\\?"\s*:\s*(true|false)[\s\S]*?hasPath\\?"\s*:\s*(true|false)/.exec(body)
        if (report) {
          toolReport = `hasSecret=${report[1]} hasPath=${report[2]}`
          sse(res, [
            { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'Probe done.' }, finish_reason: null }] },
            { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }
          ])
          return
        }
        sse(res, [
          {
            id,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [{ index: 0, id: `call_${completions}`, type: 'function', function: { name: TOOL_NAME, arguments: '{}' } }]
                },
                finish_reason: null
              }
            ]
          },
          { id, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
        ])
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-tool-env-ws-'))
  // The app inherits this from whoever started it, as it would a real token.
  process.env[SECRET_NAME] = 'do-not-leak'
  try {
    launched = await launchApp({ e2eFixture: false, preLaunchSeed: seedTool })
  } finally {
    delete process.env[SECRET_NAME]
  }
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  const saved = await launched.window.evaluate(
    (baseUrl) => window.vyotiq.setSettings({ provider: 'custom', model: 'mock-tools', customOpenAiBaseUrl: baseUrl }),
    `http://127.0.0.1:${port}/v1`
  )
  if (!saved.ok) throw new Error(saved.error)
  await launched.window.evaluate(() => localStorage.removeItem('vyotiq.chatPaneLayout'))
  await launched.window.reload()
  await launched.window.waitForLoadState('domcontentloaded')
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  rmSync(workspacePath, { recursive: true, force: true })
})

test('an agent-built tool runs without the secrets the app was started with', async () => {
  const page = launched.window
  // The app itself does have it: the probe is meaningful only if so.
  const appHasSecret = await launched.app.evaluate((_electron, name) => name in process.env, SECRET_NAME)
  expect(appHasSecret).toBe(true)

  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Probe the environment')
  await brief.press('Control+Enter')

  // Agent-built tools always ask.
  // The record's card; the navigator row offers the same answer.
  const allow = page.locator('[data-needs-you]').getByRole('button', { name: /^Allow once/ })
  await expect(allow).toBeVisible({ timeout: 60_000 })
  await allow.click()

  await expect.poll(() => toolReport, { timeout: 60_000 }).not.toBeNull()
  expect(toolReport).toBe('hasSecret=false hasPath=true')
})
