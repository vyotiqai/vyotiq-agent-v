import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { DEFAULT_SETTINGS, type CustomProvider } from '@shared/ipc'

const userData = join(tmpdir(), `vyotiq-custom-endpoints-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => (name === 'userData' ? userData : join(tmpdir(), name)),
    getAppPath: () => join(tmpdir(), 'vyotiq-app'),
    isPackaged: false
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

const lab: CustomProvider = { id: 'custom:lab', name: 'Lab vLLM', baseUrl: 'http://192.168.1.20:8000/v1' }
const infra: CustomProvider = {
  id: 'custom:infra',
  name: 'DeepInfra',
  baseUrl: 'https://api.deepinfra.com/v1/openai'
}

async function settingsModule() {
  const mod = await import('@main/settings/settings')
  mod.clearSettingsCacheForTests()
  return mod
}

beforeEach(() => {
  mkdirSync(userData, { recursive: true })
})

afterEach(async () => {
  const { clearSettingsCacheForTests } = await import('@main/settings/settings')
  clearSettingsCacheForTests()
  if (existsSync(userData)) rmSync(userData, { recursive: true, force: true })
})

describe('custom endpoints in setSettings', () => {
  it('adds endpoints and switches to one', async () => {
    const { setSettings, getSettings } = await settingsModule()
    setSettings({ customProviders: [lab, infra] })
    const next = setSettings({ provider: 'custom:lab' })
    expect(next.provider).toBe('custom:lab')
    expect(next.model).toBeTruthy()
    expect(getSettings().customProviders.map((e) => e.id)).toEqual(['custom:lab', 'custom:infra'])
  })

  it('refuses an active provider that names no endpoint', async () => {
    const { setSettings, getSettings } = await settingsModule()
    expect(() => setSettings({ provider: 'custom:ghost' })).toThrow(/does not exist/)
    expect(getSettings().provider).toBe(DEFAULT_SETTINGS.provider)
  })

  it('refuses to remove the active endpoint', async () => {
    const { setSettings, getSettings } = await settingsModule()
    setSettings({ customProviders: [lab] })
    setSettings({ provider: 'custom:lab' })
    expect(() => setSettings({ customProviders: [] })).toThrow(/Switch the active provider/)
    expect(getSettings().customProviders).toHaveLength(1)
  })

  it('caps the list', async () => {
    const { setSettings } = await settingsModule()
    const many = Array.from({ length: 21 }, (_, i) => ({
      id: `custom:e${i}` as const,
      name: `E${i}`,
      baseUrl: `http://10.0.0.${i + 1}:8000/v1`
    }))
    expect(() => setSettings({ customProviders: many })).toThrow(/Up to 20/)
  })

  it('removing an endpoint drops its key and per-model state, and nothing else', async () => {
    const { setSettings, getSettings } = await settingsModule()
    const { setSecret, secretStatus } = await import('@main/settings/secrets')
    setSettings({ customProviders: [lab, infra] })
    setSecret('custom:lab', 'sk-lab')
    setSecret('custom:infra', 'sk-infra')
    setSettings({
      favoriteModels: ['custom:lab::qwen', 'custom:infra::llama', 'openai::gpt-5'],
      recentModels: ['custom:lab::qwen', 'openai::gpt-5'],
      serviceTierByModel: { 'custom:lab::qwen': 'priority', 'openai::gpt-5': 'flex' },
      thinkingPrefsByProvider: {
        'custom:lab': { thinkingEnabled: true, thinkingEffort: 'high' },
        openai: { thinkingEnabled: false, thinkingEffort: 'low' }
      }
    })

    const next = setSettings({ customProviders: [infra] })
    expect(next.customProviders.map((e) => e.id)).toEqual(['custom:infra'])
    expect(next.favoriteModels).toEqual(['custom:infra::llama', 'openai::gpt-5'])
    expect(next.recentModels).toEqual(['openai::gpt-5'])
    expect(next.serviceTierByModel).toEqual({ 'openai::gpt-5': 'flex' })
    expect(Object.keys(next.thinkingPrefsByProvider)).toEqual(['openai'])

    const status = secretStatus().keys
    expect(status['custom:lab']).toBeFalsy()
    expect(status['custom:infra']).toBe(true)
    expect(getSettings().favoriteModels).toEqual(next.favoriteModels)
  })
})

describe('custom endpoints on load', () => {
  it('resets an active provider whose endpoint is gone', async () => {
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ ...DEFAULT_SETTINGS, provider: 'custom:ghost', model: 'qwen', customProviders: [lab] }),
      'utf8'
    )
    const { getSettings } = await settingsModule()
    const loaded = getSettings()
    expect(loaded.provider).toBe(DEFAULT_SETTINGS.provider)
    expect(loaded.model).toBe(DEFAULT_SETTINGS.model)
    expect(loaded.customProviders).toEqual([lab])
    // Persisted, so the next launch does not redo it.
    const onDisk = JSON.parse(readFileSync(join(userData, 'settings.json'), 'utf8'))
    expect(onDisk.provider).toBe(DEFAULT_SETTINGS.provider)
  })

  it('drops the legacy seeded copy of the builtin Custom endpoint', async () => {
    const url = 'https://api.deepinfra.com/v1/openai'
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({
        ...DEFAULT_SETTINGS,
        customOpenAiBaseUrl: url,
        customProviders: [{ id: 'custom:default', name: 'Custom', baseUrl: url }, lab]
      }),
      'utf8'
    )
    const { getSettings } = await settingsModule()
    expect(getSettings().customProviders).toEqual([lab])
  })
})

describe('endpoint keys and adapters', () => {
  it('secretStatus reports stored endpoint keys beside the builtins', async () => {
    const { setSecret, secretStatus } = await import('@main/settings/secrets')
    setSecret('custom:lab', 'sk-lab')
    const status = secretStatus().keys
    expect(status['custom:lab']).toBe(true)
    expect(status.openai).toBe(false)
  })

  it('routes endpoint ids through the Custom adapter', async () => {
    const { getProvider } = await import('@main/agent/providers')
    // The Custom adapter serves every endpoint; the wrapper only adds that
    // endpoint's own headers (see customEndpointAzureHeaders.test.ts).
    expect(getProvider('custom:lab').id).toBe('custom')
    expect(getProvider('custom')).toBe(getProvider('custom'))
    expect(getProvider('openai').id).toBe('openai')
  })

  it('preflight refuses a chat whose endpoint was removed', async () => {
    const { preflightChatProviderAuth } = await import('@main/agent/providers/preflight')
    const base = {
      apiKey: null,
      baseUrl: lab.baseUrl,
      encryptionAvailable: true,
      hasStoredBlob: false
    }
    expect(
      preflightChatProviderAuth({ ...base, providerId: 'custom:lab', customProviders: [] })
        ?.code
    ).toBe('SETTINGS')
    // Present and on a LAN host: no key needed.
    expect(
      preflightChatProviderAuth({ ...base, providerId: 'custom:lab', customProviders: [lab] })
    ).toBeNull()
    // Public host without a key names the endpoint, not its id.
    const fail = preflightChatProviderAuth({
      ...base,
      baseUrl: infra.baseUrl,
      providerId: 'custom:infra',
      customProviders: [infra]
    })
    expect(fail?.code).toBe('PROVIDER_AUTH')
    expect(fail?.message).toContain('DeepInfra')
  })
})
