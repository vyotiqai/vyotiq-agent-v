import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import {
  needsSetup,
  providerCheckFrom,
  setupProvider,
  setupRecents,
  setupStartingMode,
  setupWorkspace,
  type SetupProviderSettings
} from '@renderer/features/setup/setupModel'

const OLLAMA: SetupProviderSettings = {
  provider: 'ollama',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
  customProviders: []
}
const OPENAI: SetupProviderSettings = { ...OLLAMA, provider: 'openai' }

describe('setupProvider', () => {
  it('is not done until the provider has answered', () => {
    expect(setupProvider(OLLAMA, {}, null)).toEqual({
      ready: false,
      state: 'checking',
      label: 'Ollama',
      detail: 'checking http://127.0.0.1:11434…'
    })
    expect(setupProvider(OLLAMA, {}, { state: 'checking' }).ready).toBe(false)
  })

  it('a keyless host that answered needs no key, and says where it is', () => {
    expect(setupProvider(OLLAMA, {}, { state: 'ok' })).toEqual({
      ready: true,
      state: 'done',
      label: 'Ollama',
      detail: 'no key needed · http://127.0.0.1:11434'
    })
  })

  it('a host that did not answer is not connected, in main’s words', () => {
    expect(setupProvider(OLLAMA, {}, { state: 'failed', reason: 'Cannot reach Ollama at http://127.0.0.1:11434.' })).toEqual({
      ready: false,
      state: 'failed',
      label: 'Ollama',
      detail: 'not connected',
      reason: 'Cannot reach Ollama at http://127.0.0.1:11434.'
    })
  })

  it('a provider that needs a key has none until one is saved', () => {
    // No check result makes a missing key ready.
    expect(setupProvider(OPENAI, {}, { state: 'ok' })).toEqual({
      ready: false,
      state: 'missing_key',
      label: 'OpenAI',
      detail: 'needs an API key'
    })
    // Ollama Cloud is Ollama with a key.
    expect(setupProvider({ ...OLLAMA, ollamaBaseUrl: 'https://ollama.com' }, {}, null).state).toBe('missing_key')
  })

  it('a saved key is the encrypted one on this device', () => {
    expect(setupProvider(OPENAI, { openai: true }, { state: 'ok' })).toEqual({
      ready: true,
      state: 'done',
      label: 'OpenAI',
      detail: 'key saved, encrypted on this device'
    })
    expect(setupProvider(OPENAI, { openai: true }, null).detail).toBe('checking…')
  })
})

describe('providerCheckFrom', () => {
  it('a live list is an answer', () => {
    expect(providerCheckFrom({ ok: true, data: { models: [] } })).toEqual({ state: 'ok' })
  })

  it('a reachable host without a model list is an answer too', () => {
    const warning =
      'Ollama does not serve a model list (HTTP 405); the host is reachable and chat can still connect. Showing illustrative placeholder model IDs (not live models).'
    expect(providerCheckFrom({ ok: true, data: { models: [], warning } })).toEqual({ state: 'ok' })
  })

  it('keeps main’s reason and drops the model-picker tail', () => {
    const cases: [string, string][] = [
      [
        'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed). Start the Ollama app, or save an Ollama API key in Settings → Providers to use Ollama Cloud automatically. Showing seed defaults (not live models). Showing illustrative placeholder model IDs (not the live catalog).',
        'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed). Start the Ollama app, or save an Ollama API key in Settings → Providers to use Ollama Cloud automatically.'
      ],
      [
        'Timed out after 10s reaching Ollama at http://127.0.0.1:11434. Showing illustrative placeholder model IDs (not live models).',
        'Timed out after 10s reaching Ollama at http://127.0.0.1:11434.'
      ],
      [
        'Ollama live catalog was empty; showing illustrative placeholder model IDs (not installed models).',
        'Ollama live catalog was empty'
      ],
      [
        'OpenAI returned HTTP 401 (unauthorized). Check the saved API key, then refresh. Showing illustrative placeholder model IDs (not the live catalog).',
        'OpenAI returned HTTP 401 (unauthorized). Check the saved API key, then refresh.'
      ]
    ]
    for (const [warning, reason] of cases) {
      expect(providerCheckFrom({ ok: true, data: { models: [], warning } })).toEqual({ state: 'failed', reason })
    }
  })

  it('a failed call is a failed check', () => {
    expect(providerCheckFrom({ ok: false, error: 'Invalid sender' })).toEqual({ state: 'failed', reason: 'Invalid sender' })
  })
})

describe('setupWorkspace', () => {
  const SCRATCH = '/data/Agent V/home'

  it('the scratch folder main opens by itself is not a folder anyone chose', () => {
    expect(setupWorkspace(SCRATCH, [SCRATCH], SCRATCH)).toBeNull()
  })

  it('a chosen folder counts, the one in front first', () => {
    expect(setupWorkspace('/proj', [SCRATCH, '/proj'], SCRATCH)).toBe('/proj')
    expect(setupWorkspace(SCRATCH, [SCRATCH, '/proj', '/other'], SCRATCH)).toBe('/proj')
    expect(setupWorkspace('/other', ['/proj', '/other'], SCRATCH)).toBe('/other')
  })

  it('without knowing the scratch folder, any open folder counts', () => {
    expect(setupWorkspace('/proj', ['/proj'], null)).toBe('/proj')
  })
})

describe('setupRecents', () => {
  it('lists the folders opened before, newest first, without the open ones or the scratch folder', () => {
    expect(setupRecents(['/scratch', '/a', '/b', '/c'], ['/b'], '/scratch')).toEqual(['/a', '/c'])
  })

  it('stops at five', () => {
    expect(setupRecents(['/1', '/2', '/3', '/4', '/5', '/6', '/7'], [], null)).toEqual(['/1', '/2', '/3', '/4', '/5'])
  })
})

describe('needsSetup', () => {
  it('is a first run: no approval choice on record and no task yet', () => {
    expect(needsSetup(false, 0)).toBe(true)
    expect(needsSetup(false, 3)).toBe(false)
    expect(needsSetup(true, 0)).toBe(false)
  })
})

describe('setupStartingMode', () => {
  it('starts on the recommended mode over the shipped default, and keeps one set in Settings', () => {
    expect(setupStartingMode('off')).toBe('mutating')
    expect(setupStartingMode('all')).toBe('all')
    expect(setupStartingMode('mutating')).toBe('mutating')
  })
})
