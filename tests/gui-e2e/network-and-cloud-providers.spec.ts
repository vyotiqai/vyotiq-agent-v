import { createServer, type Server } from 'node:http'
import net from 'node:net'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { closeApp, launchApp, type LaunchedApp } from './helpers/launch'

/**
 * Settings → General → Network, Settings → Providers for Azure, Bedrock and
 * Vertex. The proxy test runs live (no fixture catalog): the endpoint sits at
 * a private address nothing routes to, so a catalog can only arrive through
 * the proxy set in the UI.
 */
let launched: LaunchedApp
let models: Server
let proxy: net.Server
let modelsPort = 0
let proxyPort = 0
const proxied: string[] = []
/** Tunnels the app leaves open; closed at teardown so the servers can stop. */
const sockets = new Set<net.Socket>()
const adcDir = mkdtempSync(join(tmpdir(), 'vyotiq-e2e-adc-'))
const adcFile = join(adcDir, 'application_default_credentials.json')
const priorAdc = process.env.GOOGLE_APPLICATION_CREDENTIALS

/** 10.255.255.1 is private (no key needed) and unreachable without the proxy. */
const FAR_BASE = () => `http://10.255.255.1:${modelsPort}/v1`

test.beforeAll(async () => {
  models = createServer((req, res) => {
    if (req.url?.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'proxied-model', object: 'model' }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => models.listen(0, '127.0.0.1', resolve))
  modelsPort = (models.address() as AddressInfo).port

  // A forward proxy on raw sockets: records each request line, sends every
  // request to the local models server whatever host it names.
  proxy = net.createServer((client) => {
    sockets.add(client)
    client.on('close', () => sockets.delete(client))
    client.once('data', (first) => {
      const line = first.toString('latin1').split('\r\n')[0]!
      proxied.push(line)
      const upstream = net.connect(modelsPort, '127.0.0.1', () => {
        sockets.add(upstream)
        if (line.startsWith('CONNECT ')) client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
        else upstream.write(first.toString('latin1').replace(/^(\w+) http:\/\/[^/]+/, '$1 '), 'latin1')
        client.pipe(upstream).pipe(client)
      })
      upstream.on('error', () => client.destroy())
      client.on('error', () => upstream.destroy())
    })
  })
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  proxyPort = (proxy.address() as AddressInfo).port

  // Vertex's "gcloud login" check reads this file; the app inherits the env.
  writeFileSync(adcFile, JSON.stringify({ type: 'authorized_user', client_id: 'c', client_secret: 's', refresh_token: 'r' }))
  process.env.GOOGLE_APPLICATION_CREDENTIALS = adcFile

  launched = await launchApp({ e2eFixture: false })
  const saved = await launched.window.evaluate(
    (baseUrl) =>
      window.vyotiq.setSettings({ customProviders: [{ id: 'custom:far', name: 'Far lab', baseUrl }] }),
    FAR_BASE()
  )
  if (!saved.ok) throw new Error(saved.error)
})

test.afterAll(async () => {
  if (launched) await closeApp(launched)
  for (const socket of sockets) socket.destroy()
  models?.closeAllConnections()
  await new Promise<void>((resolve) => models?.close(() => resolve()))
  await new Promise<void>((resolve) => proxy?.close(() => resolve()))
  if (priorAdc === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS
  else process.env.GOOGLE_APPLICATION_CREDENTIALS = priorAdc
  rmSync(adcDir, { recursive: true, force: true })
})

async function openSection(page: Page, name: string): Promise<void> {
  if (!(await page.getByRole('navigation', { name: 'Settings', exact: true }).isVisible().catch(() => false))) {
    await page.getByRole('button', { name: /^settings/i }).click()
  }
  await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('button', { name, exact: true }).click()
}

async function stored<T>(page: Page, pick: (s: Record<string, unknown>) => T): Promise<T> {
  const settings = await page.evaluate(async () => {
    const res = await window.vyotiq.getSettings()
    if (!res.ok) throw new Error(res.error)
    return res.data as unknown as Record<string, unknown>
  })
  return pick(settings)
}

async function farCatalog(page: Page): Promise<{ ids: string[]; warning?: string }> {
  return page.evaluate(async () => {
    const res = await window.vyotiq.listModels({ provider: 'custom:far', forceRefresh: true })
    if (!res.ok) return { ids: [], warning: res.error }
    return { ids: res.data.models.map((m) => m.id), warning: res.data.warning }
  })
}

test('a manual proxy set in Settings carries the app’s own requests, and None turns it off', async () => {
  test.setTimeout(120_000)
  const page = launched.window
  await openSection(page, 'General')
  const mode = page.getByRole('radiogroup', { name: 'Proxy' })
  await expect(mode).toBeVisible({ timeout: 20_000 })
  await expect(mode.getByRole('radio', { name: 'System' })).toHaveAttribute('aria-checked', 'true')

  await mode.getByRole('radio', { name: 'Manual' }).click()
  const address = page.getByRole('textbox', { name: 'Proxy address' })
  await address.fill('bad address with spaces')
  await address.blur()
  await expect(page.locator('#proxy-url-error')).toBeVisible()

  await address.fill(`127.0.0.1:${proxyPort}`)
  await address.blur()
  await expect.poll(() => stored(page, (s) => s.network)).toEqual({
    proxyMode: 'manual',
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    proxyBypass: ''
  })
  await expect(page.locator('[data-proxy-status="manual"]')).toContainText(`http://127.0.0.1:${proxyPort}`)

  // Main's own catalog request goes through the proxy — the only way to it.
  const via = await farCatalog(page)
  expect(via.ids).toContain('proxied-model')
  expect(proxied.some((l) => l.startsWith(`GET http://10.255.255.1:${modelsPort}/v1/models`))).toBe(true)

  await mode.getByRole('radio', { name: 'None' }).click()
  await expect(page.locator('[data-proxy-status="none"]')).toContainText('Direct connection')
  expect(await stored(page, (s) => (s.network as { proxyMode: string }).proxyMode)).toBe('direct')
})

test('an Azure OpenAI endpoint is added by its resource URL, and takes extra headers', async () => {
  const page = launched.window
  await openSection(page, 'Providers')
  await page.getByRole('button', { name: 'Add endpoint' }).click()
  const form = page.getByRole('form', { name: 'Add endpoint' })
  await form.getByRole('radio', { name: 'Azure OpenAI' }).click()
  await form.getByRole('textbox', { name: 'New endpoint name' }).fill('Azure prod')
  await form.getByRole('textbox', { name: 'New endpoint base URL' }).fill('http://my-res.openai.azure.com')
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(page.locator('#new-endpoint-url-error')).toContainText('https')

  await form.getByRole('textbox', { name: 'New endpoint base URL' }).fill(
    'https://my-res.openai.azure.com/openai/deployments/gpt/chat/completions?api-version=2024-10-21'
  )
  await form.getByRole('button', { name: 'Add', exact: true }).click()
  await expect
    .poll(() => stored(page, (s) => (s.customProviders as Array<Record<string, unknown>>).find((e) => e.name === 'Azure prod')))
    .toMatchObject({ kind: 'azure', baseUrl: 'https://my-res.openai.azure.com/openai/v1' })

  // The new endpoint's row is open: its headers.
  const headers = page.getByRole('textbox', { name: 'Extra headers' })
  await headers.fill('Bad Name: x')
  await headers.blur()
  await expect(page.locator('#endpoint-headers-error')).toContainText('not a header name')
  await headers.fill('X-Team: infra\nX-Region: west')
  await headers.blur()
  await expect
    .poll(() => stored(page, (s) => (s.customProviders as Array<Record<string, unknown>>).find((e) => e.name === 'Azure prod')?.headers))
    .toEqual({ 'X-Team': 'infra', 'X-Region': 'west' })
})

test('Bedrock takes a region and access keys; Vertex a project and this computer’s gcloud login', async () => {
  const page = launched.window
  // Saving a key refreshes that provider's catalog. Through the local proxy it
  // stays on this machine instead of reaching AWS or Google with fake keys.
  await page.evaluate(
    (proxyUrl) => window.vyotiq.setSettings({ network: { proxyMode: 'manual', proxyUrl, proxyBypass: '' } }),
    `http://127.0.0.1:${proxyPort}`
  )
  await openSection(page, 'Providers')
  const status = await page.evaluate(async () => {
    const res = await window.vyotiq.secretStatus()
    if (!res.ok) throw new Error(res.error)
    return res.data
  })

  await page.getByRole('button', { name: /(Add key for|Manage) Amazon Bedrock/ }).click()
  const region = page.getByRole('textbox', { name: 'AWS region' })
  await region.fill('mars-north-9x')
  await region.blur()
  await expect(page.getByText('Use a region code')).toBeVisible()
  await region.fill('eu-central-1')
  await region.blur()
  await expect.poll(() => stored(page, (s) => s.bedrockRegion)).toBe('eu-central-1')
  await expect(page.getByText('Calls go only to bedrock-runtime.eu-central-1.amazonaws.com.')).toBeVisible()

  await page.getByRole('radiogroup', { name: 'Bedrock sign-in' }).getByRole('radio', { name: 'Access keys' }).click()
  if (status.encryptionAvailable) {
    await page.getByRole('textbox', { name: 'AWS access key ID' }).fill('AKIAEXAMPLE')
    await page.getByRole('textbox', { name: 'AWS secret access key' }).fill('secret-example')
    await page.getByRole('button', { name: 'Save keys' }).click()
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const res = await window.vyotiq.secretStatus()
          return res.ok ? res.data.keys.bedrock : false
        })
      )
      .toBe(true)
  } else {
    await expect(page.getByRole('button', { name: 'Save keys' })).toBeDisabled()
  }

  await page.getByRole('button', { name: /(Add key for|Manage) Google Vertex AI/ }).click()
  const project = page.getByRole('textbox', { name: 'Google Cloud project' })
  await project.fill('Bad_Project')
  await project.blur()
  await expect(page.getByText('Use the project ID')).toBeVisible()
  await project.fill('my-project-123')
  await project.blur()
  await expect.poll(() => stored(page, (s) => s.vertexProject)).toBe('my-project-123')
  const location = page.getByRole('textbox', { name: 'Vertex location' })
  await location.fill('us-east5')
  await location.blur()
  await expect.poll(() => stored(page, (s) => s.vertexLocation)).toBe('us-east5')

  await page.getByRole('radiogroup', { name: 'Vertex sign-in' }).getByRole('radio', { name: 'gcloud login' }).click()
  await page.getByRole('button', { name: 'Check this computer' }).click()
  await expect(page.locator('[data-adc="found"]')).toContainText(adcFile)
  await expect(page.getByRole('button', { name: 'Use this login' })).toBeEnabled({ timeout: 5_000 }).catch(async () => {
    // Without OS secure storage there is nowhere to keep the choice.
    expect(status.encryptionAvailable).toBe(false)
  })
})
