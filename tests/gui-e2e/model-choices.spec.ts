import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { expect, test } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * Settings → Agent: the helper and utility models. A local OpenAI-compatible
 * server lists the models, so the pickers show a real catalog — or, under
 * VYOTIQ_E2E_FIXTURE=1 (CI), the seed catalog main serves instead. The test
 * asks main which it is and picks from that.
 */
let launched: LaunchedApp
let server: Server

test.beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.method === 'GET' && req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-small', object: 'model' }, { id: 'mock-big', object: 'model' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  launched = await launchApp({})
  const saved = await launched.window.evaluate(
    (baseUrl) => window.vyotiq.setSettings({ customOpenAiBaseUrl: baseUrl }),
    `http://127.0.0.1:${port}/v1`
  )
  if (!saved.ok) throw new Error(saved.error)
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  await new Promise<void>((resolve) => server?.close(() => resolve()))
})

/** The ids the Custom provider's model picker will offer. */
async function customModelIds(): Promise<string[]> {
  return launched.window.evaluate(async () => {
    const res = await window.vyotiq.listModels({ provider: 'custom', forceRefresh: true })
    if (!res.ok) throw new Error(res.error)
    return res.data.models.map((m) => m.id)
  })
}

async function stored(): Promise<{ helperModel: unknown; utilityModel: unknown }> {
  return launched.window.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    if (!res.ok) throw new Error(res.error)
    return { helperModel: res.data.helperModel, utilityModel: res.data.utilityModel }
  })
}

test('the helper and utility models are picked per provider, and go back to the task model', async () => {
  const page = launched.window
  const [small, big] = await customModelIds()
  expect(small && big).toBeTruthy()
  await page.getByRole('button', { name: /^settings/i }).click()
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name: 'Agent', exact: true }).click()

  const helperProvider = page.getByRole('button', { name: 'Helper model: provider' })
  await expect(helperProvider).toBeVisible({ timeout: 20_000 })
  await expect(helperProvider).toContainText('Same as the task')
  expect(await stored()).toEqual({ helperModel: null, utilityModel: null })

  await helperProvider.click()
  await page.getByRole('option', { name: 'Custom OpenAI-compatible', exact: true }).click()
  // A provider alone saves nothing; the model list waits for a pick.
  expect((await stored()).helperModel).toBeNull()
  const helperModel = page.getByRole('button', { name: 'Helper model: model' })
  await helperModel.click()
  await page.getByRole('option', { name: small!, exact: true }).click()
  await expect.poll(async () => (await stored()).helperModel).toEqual({ provider: 'custom', model: small })

  const utilityProvider = page.getByRole('button', { name: 'Utility model: provider' })
  await utilityProvider.click()
  await page.getByRole('option', { name: 'Custom OpenAI-compatible', exact: true }).click()
  await page.getByRole('button', { name: 'Utility model: model' }).click()
  await page.getByRole('option', { name: big!, exact: true }).click()
  await expect.poll(async () => (await stored()).utilityModel).toEqual({ provider: 'custom', model: big })

  await helperProvider.click()
  await page.getByRole('option', { name: 'Same as the task', exact: true }).click()
  await expect.poll(async () => (await stored()).helperModel).toBeNull()
  await expect(page.getByRole('button', { name: 'Helper model: model' })).toHaveCount(0)
  expect((await stored()).utilityModel).toEqual({ provider: 'custom', model: big })
})
