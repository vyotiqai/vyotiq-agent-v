import { describe, expect, it } from 'vitest'
import {
  CustomProviderSchema,
  DEFAULT_CUSTOM_PROVIDER_ID,
  DEFAULT_CUSTOM_PROVIDER_SLUG,
  DEFAULT_SETTINGS,
  SettingsSchema,
  MAX_CUSTOM_PROVIDERS,
  dropLegacyCustomProviderSeed,
  newCustomProviderId,
  normalizeCustomProviders
} from '@shared/ipc/schemas/settings'
import {
  CustomProviderIdSchema,
  ProviderIdSchemaAny,
  customProviderId,
  customProviderSlug,
  isCustomProviderId
} from '@shared/ipc/schemas/providers'
import { modelSelectionKey, parseModelSelectionKey } from '@shared/domain/modelSelection'
import type { ProviderId } from '@shared/ipc/schemas/providers'
import type { CustomProvider } from '@shared/ipc'

describe('custom provider id schema', () => {
  it('accepts builtin ids and rejects unknown strings on the builtin enum', () => {
    expect(ProviderIdSchemaAny.safeParse('openai').success).toBe(true)
    expect(ProviderIdSchemaAny.safeParse('custom:my-server').success).toBe(true)
    expect(ProviderIdSchemaAny.safeParse('bogus').success).toBe(false)
  })

  it('validates the custom:<slug> template', () => {
    expect(CustomProviderIdSchema.safeParse('custom:my-server-1').success).toBe(true)
    expect(CustomProviderIdSchema.safeParse('custom:a').success).toBe(true)
    expect(CustomProviderIdSchema.safeParse('custom:Bad').success).toBe(false)
    expect(CustomProviderIdSchema.safeParse('custom:').success).toBe(false)
    expect(CustomProviderIdSchema.safeParse('custom:a::b').success).toBe(false)
    expect(CustomProviderIdSchema.safeParse('custom:a:b').success).toBe(false)
    expect(CustomProviderIdSchema.safeParse('openai').success).toBe(false)
    expect(
      CustomProviderIdSchema.safeParse(`custom:${'a'.repeat(41)}`).success
    ).toBe(false)
    expect(CustomProviderIdSchema.safeParse(`custom:${'a'.repeat(40)}`).success).toBe(true)
  })

  it('round-trips slugs and id predicates', () => {
    expect(customProviderSlug('custom:my-server')).toBe('my-server')
    expect(customProviderSlug('openai')).toBe(null)
    expect(customProviderSlug('custom:not allowed!')).toBe(null)
    expect(isCustomProviderId('custom:lan')).toBe(true)
    expect(isCustomProviderId('custom')).toBe(false)
    expect(customProviderId(DEFAULT_CUSTOM_PROVIDER_SLUG)).toBe(DEFAULT_CUSTOM_PROVIDER_ID)
    expect(DEFAULT_CUSTOM_PROVIDER_ID).toBe('custom:default')
  })

  it('trims and bounds entry names', () => {
    const ok = CustomProviderSchema.safeParse({
      id: 'custom:lan',
      name: '  LAN Llama  ',
      baseUrl: ' http://127.0.0.1:8080/v1 '
    })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.name).toBe('LAN Llama')
      expect(ok.data.baseUrl).toBe('http://127.0.0.1:8080/v1')
    }
    expect(
      CustomProviderSchema.safeParse({ id: 'custom:lan', name: '', baseUrl: 'x' }).success
    ).toBe(false)
    expect(
      CustomProviderSchema.safeParse({ id: 'custom:lan', name: 'x'.repeat(61), baseUrl: 'x' })
        .success
    ).toBe(false)
    expect(
      CustomProviderSchema.safeParse({ id: 'custom:lan', name: 'LAN', baseUrl: ' ' }).success
    ).toBe(false)
  })
})

describe('two custom providers coexist', () => {
  it('keeps both entries in parsed settings', () => {
    const parsed = SettingsSchema.parse({
      ...DEFAULT_SETTINGS,
      customProviders: [
        { id: 'custom:deepinfra', name: 'DeepInfra', baseUrl: 'https://api.deepinfra.com/v1' },
        { id: 'custom:lan-llama', name: 'LAN Llama', baseUrl: 'http://192.168.1.10:8080/v1' }
      ]
    })
    expect(parsed.customProviders).toHaveLength(2)
    expect(parsed.customProviders.map((e) => e.id)).toEqual([
      'custom:deepinfra',
      'custom:lan-llama'
    ])
  })

  it('defaults to an empty list', () => {
    expect(SettingsSchema.parse({ ...DEFAULT_SETTINGS }).customProviders).toEqual([])
  })
})

describe('normalizeCustomProviders', () => {
  it('dedupes by id slug, first entry wins', () => {
    const out = normalizeCustomProviders([
      { id: 'custom:lan', name: 'First', baseUrl: 'http://127.0.0.1:8080/v1' },
      { id: 'custom:lan', name: 'Second', baseUrl: 'https://other.example.com/v1' }
    ])
    expect(out).toEqual([
      { id: 'custom:lan', name: 'First', baseUrl: 'http://127.0.0.1:8080/v1' }
    ])
  })

  it('dedupes by normalized base URL across different ids', () => {
    const out = normalizeCustomProviders([
      { id: 'custom:a', name: 'A', baseUrl: 'https://api.example.com/v1/' },
      { id: 'custom:b', name: 'B', baseUrl: 'https://api.example.com/v1' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.id).toBe('custom:a')
  })

  it('drops invalid rows', () => {
    const out = normalizeCustomProviders([
      { id: 'custom:BAD', name: 'Bad', baseUrl: 'https://x/v1' },
      { id: 'custom:ok', name: '', baseUrl: 'https://x/v1' },
      { id: 'custom:ok2', name: 'Ok', baseUrl: '' },
      'garbage',
      { id: 'custom:ok3', name: 'Ok3', baseUrl: 'https://x/v1' }
    ])
    expect(out.map((e) => e.id)).toEqual(['custom:ok3'])
  })

  it('is idempotent and tolerates undefined', () => {
    const rows = [{ id: 'custom:lan', name: 'LAN', baseUrl: 'http://127.0.0.1:8080/v1' }]
    expect(normalizeCustomProviders(normalizeCustomProviders(rows))).toEqual(
      normalizeCustomProviders(rows)
    )
    expect(normalizeCustomProviders(undefined)).toEqual([])
  })
})

describe('dropLegacyCustomProviderSeed', () => {
  // Earlier builds copied the builtin Custom URL into a `custom:default`
  // entry, so the same endpoint showed twice. Load drops that copy only.
  const seeded: CustomProvider = {
    id: 'custom:default',
    name: 'Custom',
    baseUrl: 'https://api.deepinfra.com/v1/openai'
  }

  it('drops the untouched seeded copy of the builtin Custom endpoint', () => {
    expect(dropLegacyCustomProviderSeed([seeded], 'https://api.deepinfra.com/v1/openai/')).toEqual([])
  })

  it('keeps it once renamed or pointed elsewhere', () => {
    const renamed = { ...seeded, name: 'DeepInfra' }
    const moved = { ...seeded, baseUrl: 'https://other.example.com/v1' }
    expect(dropLegacyCustomProviderSeed([renamed], seeded.baseUrl)).toEqual([renamed])
    expect(dropLegacyCustomProviderSeed([moved], seeded.baseUrl)).toEqual([moved])
  })

  it('never touches user-added ids', () => {
    const lan: CustomProvider = { id: 'custom:lan', name: 'Custom', baseUrl: seeded.baseUrl }
    expect(dropLegacyCustomProviderSeed([lan], seeded.baseUrl)).toEqual([lan])
  })

  it('compares against the product default when the legacy field is unset', () => {
    const local = { ...seeded, baseUrl: 'http://127.0.0.1:8080/v1' }
    expect(dropLegacyCustomProviderSeed([local], undefined)).toEqual([])
  })
})

describe('newCustomProviderId', () => {
  it('slugs the name', () => {
    expect(newCustomProviderId('Lab vLLM', [])).toBe('custom:lab-vllm')
    expect(newCustomProviderId('  Café Server!! ', [])).toBe('custom:cafe-server')
  })

  it('suffixes a taken slug and reserves the legacy default', () => {
    expect(newCustomProviderId('Lab', ['custom:lab'])).toBe('custom:lab-2')
    expect(newCustomProviderId('Lab', ['custom:lab', 'custom:lab-2'])).toBe('custom:lab-3')
    expect(newCustomProviderId('Default', [])).toBe('custom:default-2')
  })

  it('falls back when the name has no slug characters, and caps the length', () => {
    expect(newCustomProviderId('！！', [])).toBe('custom:endpoint')
    const long = newCustomProviderId('x'.repeat(100), [])
    expect(CustomProviderIdSchema.safeParse(long).success).toBe(true)
    expect(long.length).toBe('custom:'.length + 32)
  })

  it('always yields a valid id', () => {
    for (const name of ['a', 'A-B_C', '---', '日本語', 'x'.repeat(31) + ' y']) {
      expect(CustomProviderIdSchema.safeParse(newCustomProviderId(name, [])).success).toBe(true)
    }
  })

  it('caps the list at a documented size', () => {
    expect(MAX_CUSTOM_PROVIDERS).toBe(20)
  })
})

describe('modelSelectionKey collision-freedom', () => {
  it('round-trips custom provider keys', () => {
    const provider = 'custom:my-server' as ProviderId
    const key = modelSelectionKey(provider, 'meta/Llama-3.3-70B')
    expect(key).toBe('custom:my-server::meta/Llama-3.3-70B')
    expect(parseModelSelectionKey(key)).toEqual({
      provider: 'custom:my-server',
      model: 'meta/Llama-3.3-70B'
    })
  })

  it('cannot collide with the :: separator because slugs exclude ":"', () => {
    // Slug characters cannot include ':', so `custom:a::b` is never a valid id
    // and the first `::` always ends the provider part.
    expect(customProviderSlug('custom:a::b')).toBe(null)
    expect(parseModelSelectionKey('custom:my-server::a::b')).toEqual({
      provider: 'custom:my-server',
      model: 'a::b'
    })
  })
})
