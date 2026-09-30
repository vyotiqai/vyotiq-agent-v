import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'
import { requireActivePath } from './helpers/seedWorkspace'

/**
 * The spend limit, end to end through the real loop — no fixture replay. A
 * local OpenAI-compatible server stands in for the model and bills $0.60 a
 * step (`usage.cost`, the field OpenRouter-style hosts report), so nothing
 * real is spent. With a $1 limit the task parks on a question after two
 * steps; "Allow another $1.00" lets it run two more, and "Stop here" ends it
 * with the spend_limit notice.
 */
let launched: LaunchedApp
let workspacePath: string
let server: Server
let completions = 0

function sse(res: import('node:http').ServerResponse, chunks: unknown[]): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const chunk of chunks) res.write(`data: ${JSON.stringify(chunk)}\n\n`)
  res.end('data: [DONE]\n\n')
}

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-billed', object: 'model' }] }))
      return
    }
    if (req.method === 'POST' && req.url?.endsWith('/chat/completions')) {
      req.resume()
      req.on('end', () => {
        completions += 1
        const id = `call_${completions}`
        sse(res, [
          {
            id: `c${completions}`,
            object: 'chat.completion.chunk',
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id, type: 'function', function: { name: 'read', arguments: '{"path":"README.md"}' } }
                  ]
                },
                finish_reason: null
              }
            ]
          },
          { id: `c${completions}`, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          {
            id: `c${completions}`,
            object: 'chat.completion.chunk',
            choices: [],
            usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110, cost: 0.6 }
          }
        ])
      })
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-spend-ws-'))
  writeFileSync(join(workspacePath, 'README.md'), '# Spend limit\n', 'utf8')
  launched = await launchApp({ e2eFixture: false })
  const added = await launched.window.evaluate((path) => window.vyotiq.addWorkspace(path), workspacePath)
  if (!added.ok) throw new Error(added.error)
  workspacePath = requireActivePath(added.data.activePath)
  const saved = await launched.window.evaluate(
    (baseUrl) =>
      window.vyotiq.setSettings({
        provider: 'custom',
        model: 'mock-billed',
        customOpenAiBaseUrl: baseUrl,
        taskSpendLimitUsd: 1
      }),
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

test('a task parks at its spend limit, spends another stretch when allowed, and stops when told', async () => {
  const page = launched.window
  await page.keyboard.press('Control+n')
  const brief = page.getByRole('combobox', { name: 'Brief' })
  await expect(brief).toBeVisible({ timeout: 20_000 })
  await brief.fill('Read the readme')
  await brief.press('Control+Enter')

  // Two steps at $0.60 cross $1: the task asks before a third model call.
  const question = page.locator('form[data-needs-you]')
  await expect(question).toContainText('Spend limit reached', { timeout: 60_000 })
  await expect(question).toContainText(
    'This task has spent $1.20 of its $1.00 limit, helper instances included. Let it spend more?'
  )
  expect(completions).toBe(2)
  // A parked task is one that needs you.
  await expect(page.locator('[data-navigator]')).toContainText('Has a question for you')

  await question.getByRole('radio', { name: 'Allow another $1.00' }).click()

  // $1.80, then $2.40 over the new $2 line: asked again.
  await expect(question).toContainText('This task has spent $2.40 of its $2.00 limit', { timeout: 60_000 })
  expect(completions).toBe(4)
  await question.getByRole('radio', { name: 'Stop here' }).click()

  // The person stopped it: the receipt says Stopped (not Failed), and the
  // question is gone.
  const outcome = page.locator('[data-receipt-outcome]').last()
  await expect(outcome).toHaveAttribute('data-receipt-outcome', 'stopped', { timeout: 30_000 })
  await expect(outcome).toContainText('Stopped')
  await expect(question).toHaveCount(0)
  expect(completions).toBe(4)

  // The allowance is the task's own, in spend.json beside its record.
  const spendFiles = findFiles(launched.userDataDir, 'spend.json')
  expect(spendFiles).toHaveLength(1)
  expect(JSON.parse(readFileSync(spendFiles[0]!, 'utf8'))).toMatchObject({ version: 1, allowanceUsd: 1 })
})

function findFiles(dir: string, name: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...findFiles(full, name))
    else if (entry.name === name) out.push(full)
  }
  return out
}
