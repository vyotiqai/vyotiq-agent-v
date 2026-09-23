/**
 * @vitest-environment jsdom
 */
import { useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, fireEvent, within, waitFor } from '@testing-library/react'
import { SettingsView } from '@renderer/features/settings'
import { SETTINGS_SEARCH_INDEX } from '@renderer/features/settings/settingsSearchIndex'
import { SECTION_GROUPS, SECTION_LABELS } from '@renderer/features/settings/constants'
import { emptySecretStatus, type Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'

afterEach(() => {
  cleanup()
})

const emptySecrets = emptySecretStatus()

const baseSettings: Settings = {
  ...DEFAULT_SETTINGS,
  provider: 'openai',
  model: 'gpt-5.6'
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  window.vyotiq = {
    listModels: vi.fn(async () => ({
      ok: true as const,
      data: { models: [{ id: 'gpt-5.6', inputModalities: ['text'], outputModalities: ['text'], supportsTools: true, supportsVision: false }], warning: 'seed' }
    })),
    openLogsDir: vi.fn(async () => ({ ok: true as const, data: true as const })),
    getLogsPath: vi.fn(async () => ({ ok: true as const, data: '/tmp/logs' })),
    telemetryStatus: vi.fn(async () => ({
      ok: true as const,
      data: { dsnConfigured: false, telemetryEnabled: false }
    })),
    getAppInfo: vi.fn(async () => ({
      ok: true as const,
      data: {
        name: 'Vyotiq',
        version: '1.0.0',
        homepage: 'https://vyotiq.com',
        electron: '43.2.0',
        chrome: '132.0.6834.196',
        node: '22.17.0',
        platform: 'win32',
        arch: 'x64',
        osVersion: '10.0.26200'
      }
    })),
    shellOpenExternal: vi.fn(async () => ({ ok: true as const, data: true as const })),
    mcpStatus: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    mcpRefresh: vi.fn(async () => ({ ok: true as const, data: { servers: [] } })),
    marketplaceBrowse: vi.fn(async () => ({
      ok: true as const,
      data: {
        packages: [
          {
            id: 'filesystem',
            name: 'Filesystem',
            version: '1.0.0',
            description: 'Bundled MCP',
            kind: 'mcp' as const,
            source: 'bundled' as const,
            bundledPath: 'filesystem'
          }
        ]
      }
    })),
    marketplaceListInstalled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplaceRefreshCatalog: vi.fn(async () => ({
      ok: true as const,
      data: { packages: [], remoteCount: 0 }
    })),
    marketplaceInstall: vi.fn(async () => ({
      ok: false as const,
      error: 'not used'
    })),
    marketplaceUninstall: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplaceSetEnabled: vi.fn(async () => ({
      ok: true as const,
      data: { schemaVersion: 1 as const, items: [] }
    })),
    marketplacePickLocal: vi.fn(async () => ({ ok: true as const, data: null })),
    marketplaceGetContents: vi.fn(async () => ({
      ok: false as const,
      error: 'not found'
    })),
    marketplaceAckRemoteInstall: vi.fn(async () => ({ ok: true as const, data: true as const })),
    crashDiagnosticsGet: vi.fn(async () => ({
      ok: true as const,
      data: { snippets: [], pendingRecovery: null }
    })),
    codeIndexStatus: vi.fn(async () => ({
      ok: true as const,
      data: {
        settings: baseSettings.codeIndex,
        phase: 'idle' as const,
        progress: null,
        message: null,
        error: null,
        indexProgress: null
      }
    })),
    codeIndexReindex: vi.fn(async () => ({
      ok: true as const,
      data: { scanned: 0, indexed: 0, skipped: 0, removed: 0 }
    })),
    onCodeIndexStatus: vi.fn(() => () => {}),
    dictationStatus: vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'idle' as const,
        progress: null,
        message: null,
        error: null,
        installed: [],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'openai' as const,
        activeModelId: null,
        loadedModelId: null
      }
    })),
    dictationInstall: vi.fn(async () => ({
      ok: false as const,
      error: 'not used'
    })),
    dictationUnload: vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'idle' as const,
        progress: null,
        message: null,
        error: null,
        installed: [],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'openai' as const,
        activeModelId: null,
        loadedModelId: null
      }
    })),
    dictationDeleteCache: vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'idle' as const,
        progress: null,
        message: null,
        error: null,
        installed: [],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'openai' as const,
        activeModelId: null,
        loadedModelId: null
      }
    })),
    onDictationStatus: vi.fn(() => () => {})
  }
})

describe('settings', () => {
  it('shows the fresh-install Ollama selection as active without calling it default', () => {
    render(
      <SettingsView
        settings={DEFAULT_SETTINGS}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    expect(screen.getByLabelText('Active provider').textContent).toMatch(/Ollama/i)
    expect(screen.queryByText(/No providers configured yet/i)).toBeNull()
    expect(screen.queryByText(/default provider/i)).toBeNull()
  })

  it('says how to fix an active provider with no key when no other key is saved', () => {
    render(
      <SettingsView
        settings={{ ...DEFAULT_SETTINGS, provider: 'deepseek', model: 'deepseek-v4-flash' }}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    expect(screen.getByText(/DeepSeek has no API key\. Add one under API keys below\./)).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Use / })).toBeNull()
  })

  it('keeps the selected section when the settings view rerenders', () => {
    const renderSettings = () => (
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    const { rerender } = render(renderSettings())
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByLabelText('Active provider')).toBeTruthy()

    rerender(renderSettings())
    expect(screen.getByLabelText('Active provider')).toBeTruthy()
  })

  it('surfaces secure-storage unavailable messaging', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        encryptionAvailable={false}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/secure storage is unavailable/i)).toBeTruthy()
    expect(screen.getByPlaceholderText(/Secure storage unavailable/i)).toBeTruthy()
  })

  it('settings has no duplicate model pickers; Providers sets active provider', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    expect(screen.queryByLabelText(/^Model$/i)).toBeNull()
    expect(screen.queryByPlaceholderText(/Custom model id/i)).toBeNull()
    expect(screen.getByRole('button', { name: /^General$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Providers$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Agent$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Indexing$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Voice$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^Tools$/i })).toBeTruthy()
    // Notifications and Diagnostics are real sections: clicking each nav entry
    // renders its own fields instead of falling through to General.
    fireEvent.click(screen.getByRole('button', { name: /^Notifications$/i }))
    expect(document.querySelectorAll('[data-settings-field]').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-settings-field="notifications-enabled"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Diagnostics$/i }))
    expect(document.querySelectorAll('[data-settings-field]').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-settings-field="telemetry"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^General$/i }))
    expect(screen.queryByRole('button', { name: /^Integrations$/i })).toBeNull()
    expect(screen.getByRole('button', { name: /^Shortcuts$/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /^About$/i })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /^Marketplace$/i })).toBeNull()
    expect(screen.queryByLabelText(/Max steps/i)).toBeNull()
    expect(screen.queryByLabelText(/Enable extended thinking/i)).toBeNull()
    expect(screen.getAllByText(/^Workspaces$/i).length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/Search settings/i)).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByLabelText('Active provider')).toBeTruthy()
    expect(screen.queryByLabelText('Image provider')).toBeNull()
    expect(screen.queryByLabelText('Image model')).toBeNull()
    expect(screen.queryByLabelText(/Allow Custom for image generation/i)).toBeNull()
    expect(screen.queryByLabelText('Ollama base URL')).toBeNull()
    expect(screen.queryByLabelText('Custom OpenAI base URL')).toBeNull()
    expect(screen.getByLabelText(/API key status/i)).toBeTruthy()
    expect(screen.queryByText(/change provider in the composer/i)).toBeNull()
  })

  it('shows the 55% auto-compact default from shared settings', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="agent"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(
      (screen.getByLabelText('Auto-compact threshold percent') as HTMLInputElement).value
    ).toBe('55')
  })

  it('shows custom model as read-only active model', () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'ollama', model: 'my-custom-model' }}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(screen.getAllByText(/my-custom-model/).length).toBeGreaterThan(0)
    expect(screen.queryByPlaceholderText(/Custom model id/i)).toBeNull()
  })

  it('active model truncates a long id in place and keeps the whole id as its title', () => {
    const longModel = 'deepseek/deepseek-v4-flash-0731-extra-long-suffix'
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'custom', model: longModel }}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    const field = document.querySelector('[data-settings-field="active-model"]') as HTMLElement
    const label = within(field).getByText(longModel)
    expect(label.classList.contains('truncate')).toBe(true)
    expect(label.getAttribute('title')).toBe(longModel)
    // The row stays copy-left/control-right rather than wrapping under.
    expect(field.querySelector('.flex-nowrap')).toBeTruthy()
  })

  it('surfaces save key errors as alert', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({
          ok: false as const,
          error: 'secure storage failed'
        }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.change(screen.getByLabelText(/API key \(OpenAI\)/i), {
      target: { value: 'sk-test' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/secure storage failed/)
  })

  it('saving a non-active provider key does not activate it and still refreshes models', async () => {
    const onSaveSecret = vi.fn(async () => ({ ok: true as const }))
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={onSaveSecret}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/i }))
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))
    fireEvent.change(screen.getByLabelText(/API key \(Anthropic\)/i), {
      target: { value: 'sk-ant' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    await waitFor(() => expect(onSaveSecret).toHaveBeenCalledWith('anthropic', 'sk-ant'))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic', forceRefresh: true })
      )
    )
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))
    expect(screen.getByLabelText('Active provider').textContent).toMatch(/OpenAI/i)
  })

  it('Active provider menu switches provider without expanding a key row', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const secrets = { ...emptySecrets, openai: true, anthropic: true }
    render(
      <SettingsView
        settings={baseSettings}
        secrets={secrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByLabelText('Active provider'))
    fireEvent.click(screen.getByRole('option', { name: /Anthropic/i }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'anthropic' })
      )
    )
  })

  it('switches active provider to OpenRouter from Providers when DeepSeek lacks a key', async () => {
    function Harness() {
      const [settings, setSettings] = useState<Settings>({
        ...baseSettings,
        provider: 'deepseek',
        model: 'deepseek-v4-flash'
      })
      return (
        <SettingsView
          settings={settings}
          secrets={{ ...emptySecrets, openrouter: true }}
          onClose={vi.fn()}
          onUpdate={async (partial) => {
            setSettings((prev) => ({ ...prev, ...partial }))
            return { ok: true as const }
          }}
          onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
          onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        />
      )
    }

    render(<Harness />)
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/DeepSeek has no API key/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Use OpenRouter/i }))
    await waitFor(() =>
      expect(screen.getByLabelText('Active provider').textContent).toMatch(/OpenRouter/i)
    )
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openrouter', forceRefresh: true })
      )
    )
  })

  it('refreshes models after saving active provider key', async () => {
    const onSaveSecret = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={onSaveSecret}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.change(screen.getByLabelText(/API key \(OpenAI\)/i), {
      target: { value: 'sk-live' }
    })
    fireEvent.click(screen.getByRole('button', { name: /Save key/i }))
    await waitFor(() => expect(onSaveSecret).toHaveBeenCalledWith('openai', 'sk-live'))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'openai', forceRefresh: true })
      )
    )
  })

  it('validates ollama url', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'ollama', model: 'qwen2.5' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    const ollama = screen.getByLabelText('Ollama base URL')
    fireEvent.change(ollama, { target: { value: 'not-a-url' } })
    fireEvent.blur(ollama)
    expect((await screen.findByRole('alert')).textContent).toMatch(/http\(s\) URL/)
    expect(onUpdate).not.toHaveBeenCalled()
  })

  it('shows provider base URL inside the matching API key row, even when that provider is not active', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.queryByLabelText('Ollama base URL')).toBeNull()
    expect(screen.queryByLabelText('Custom OpenAI base URL')).toBeNull()
    expect(
      screen.getByRole('button', { name: /Custom OpenAI-compatible.*127\.0\.0\.1:8080/i })
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: /Ollama.*127\.0\.0\.1:11434/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Custom OpenAI-compatible/i }))
    expect(screen.getByLabelText('Custom OpenAI base URL')).toBeTruthy()
    expect(screen.getByText(/api\.deepinfra\.com\/v1\/openai/)).toBeTruthy()
    expect(screen.getByText(/loopback and private LAN can stay empty/i)).toBeTruthy()
    expect(screen.queryByLabelText('Ollama base URL')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /^Ollama/i }))
    expect(screen.getByLabelText('Ollama base URL')).toBeTruthy()
    expect(screen.queryByLabelText('Custom OpenAI base URL')).toBeNull()
  })

  it('shows the custom base URL when Custom is already the active provider', () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'custom', model: 'local' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByLabelText('Custom OpenAI base URL')).toBeTruthy()
    expect(screen.queryByLabelText('Ollama base URL')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Set as active$/i })).toBeNull()
    expect(screen.queryByText(/still the local default/i)).toBeNull()
  })

  it('sets the expanded provider as active from the API key row', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true, anthropic: true }}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: /Anthropic/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Set as active$/i }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ provider: 'anthropic' }))
    )
  })

  it('warns when Custom is active with the local default URL and a saved key', () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'custom', model: 'local' }}
        secrets={{ ...emptySecrets, custom: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.getByText(/still the local default/i)).toBeTruthy()
  })

  it('does not warn when Custom uses a hosted base URL', () => {
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          provider: 'custom',
          model: 'local',
          customOpenAiBaseUrl: 'https://api.deepinfra.com/v1/openai'
        }}
        secrets={{ ...emptySecrets, custom: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    expect(screen.queryByText(/still the local default/i)).toBeNull()
  })

  it('Active model Change opens the composer model picker', () => {
    const onOpenComposerModel = vi.fn()
    const { rerender } = render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        onOpenComposerModel={onOpenComposerModel}
      />
    )
    const field = document.querySelector('[data-settings-field="active-model"]') as HTMLElement
    expect(within(field).getByText(baseSettings.model)).toBeTruthy()
    fireEvent.click(within(field).getByRole('button', { name: /^Change$/ }))
    expect(onOpenComposerModel).toHaveBeenCalledTimes(1)

    // Without a composer to open, the row only reports the model.
    rerender(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="providers"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(screen.queryByRole('button', { name: /^Change$/ })).toBeNull()
  })

  it('settings search for custom base URL expands the Custom OpenAI-compatible row', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const search = screen.getByLabelText(/Search settings/i)
    fireEvent.change(search, { target: { value: 'deepinfra' } })
    fireEvent.click(screen.getByRole('option', { name: /Custom OpenAI base URL/i }))
    expect(await screen.findByLabelText('Custom OpenAI base URL')).toBeTruthy()
  })

  it('settings search navigates to the Diagnostics telemetry field', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const search = screen.getByLabelText(/Search settings/i)
    fireEvent.change(search, { target: { value: 'telemetry' } })
    fireEvent.click(screen.getByRole('option', { name: /Share crash/i }))
    expect(await screen.findByLabelText(/Share crash and error reports/i)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Open logs folder/i })).toBeTruthy()
  })

  it('surfaces refresh model errors', async () => {
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: false as const,
      error: 'catalog unavailable'
    }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/catalog unavailable/)
  })

  it('surfaces seed fallback warning as alert, not as live catalog success', async () => {
    // @ts-expect-error test bridge
    window.vyotiq.listModels = vi.fn(async () => ({
      ok: true as const,
      data: {
        models: [
          {
            id: 'qwen2.5',
            inputModalities: ['text'],
            outputModalities: ['text'],
            supportsTools: true,
            supportsVision: false
          }
        ],
        warning: 'Cannot reach Ollama at http://127.0.0.1:11434 (fetch failed: ECONNREFUSED). Showing seed defaults (not live models).'
      }
    }))
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'ollama', model: 'qwen2.5' }}
        secrets={{ ...emptySecrets, openrouter: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    // modal left SECRET_PROVIDERS (12 → 11) when the Modal provider was removed.
    expect(screen.getByText(/1\/11 saved/i)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    expect(
      await screen.findByText(/seed models for Ollama.*Cannot reach Ollama/i)
    ).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByText(/^1 models for Ollama · fetch failed$/)).toBeNull()
  })

  it('blocks cloud refresh without a saved key before calling listModels', async () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, provider: 'deepseek', model: 'deepseek-v4-flash' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    expect((await screen.findByRole('alert')).textContent).toMatch(/DeepSeek API key not set/i)
    expect(window.vyotiq.listModels).not.toHaveBeenCalled()
  })

  it('Refresh models uses workspace override custom URL when active', async () => {
    const workspacePath = 'C:\\ws\\proj'
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          provider: 'custom',
          model: 'local',
          customOpenAiBaseUrl: 'http://127.0.0.1:8080/v1'
        }}
        secrets={{ ...emptySecrets, custom: true }}
        activeWorkspacePath={workspacePath}
        settingsOverridesByPath={{
          [workspacePath]: {
            useOverride: true,
            customOpenAiBaseUrl: 'http://192.168.1.50:9000/v1'
          }
        }}
        effectiveChatSettings={{
          provider: 'custom',
          model: 'local',
          ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
          customOpenAiBaseUrl: 'http://192.168.1.50:9000/v1',
          keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
          autoCompactThresholdRatio: DEFAULT_SETTINGS.autoCompactThresholdRatio,
          thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
          thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
          showThinking: DEFAULT_SETTINGS.showThinking,
          toolApproval: DEFAULT_SETTINGS.toolApproval,
          agentPersona: DEFAULT_SETTINGS.agentPersona,
          agentTone: DEFAULT_SETTINGS.agentTone,
          responseLanguage: DEFAULT_SETTINGS.responseLanguage,
          responseVerbosity: DEFAULT_SETTINGS.responseVerbosity
        }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Providers$/i }))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh models' }))
    await waitFor(() =>
      expect(window.vyotiq.listModels).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'custom',
          baseUrl: 'http://192.168.1.50:9000/v1',
          forceRefresh: true
        })
      )
    )
  })

  it('theme menu calls onAppearanceChange', () => {
    const onAppearanceChange = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={{ ...emptySecrets, openai: true }}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        onAppearanceChange={onAppearanceChange}
        section="appearance"
      />
    )

    const trigger = screen.getByRole('button', { name: /^Color mode$/i })
    expect(trigger.className).toContain('max-w-full')
    expect(trigger.className).not.toContain('max-w-[200px]')
    fireEvent.click(trigger)
    const listbox = screen.getByRole('listbox')
    fireEvent.click(within(listbox).getByText('Dark'))
    expect(onAppearanceChange).toHaveBeenCalledWith({ theme: 'dark' })
  })

  it('shows settings search empty state as an overlay', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.change(screen.getByLabelText(/Search settings/i), {
      target: { value: 'zzzz-no-such-setting-xyz' }
    })
    const empty = screen.getByRole('status')
    expect(empty.textContent).toMatch(/No matching settings/)
    expect(empty.className).toContain('absolute')
    expect(empty.className).toContain('z-dropdown')
  })

  it('edits MCP server fields in Marketplace manage view', async () => {
    const serverId = 'mcp-test-id'
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const { MarketplaceView } = await import('@renderer/features/marketplace')
    render(
      <MarketplaceView
        settings={{
          ...baseSettings,
          mcpServers: [
            {
              id: serverId,
              name: 'Echo server',
              command: 'node',
              args: ['echo-server.mjs'],
              enabled: true,
              source: 'manual'
            }
          ]
        }}
        onUpdate={onUpdate}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
    // Manage view polls connection status on open (mcpStatus). Refresh MCP is explicit.
    await waitFor(() => expect(window.vyotiq.mcpStatus).toHaveBeenCalled())

    const nameInput = screen.getByLabelText(`MCP server name for ${serverId}`)
    fireEvent.change(nameInput, { target: { value: 'Filesystem' } })
    fireEvent.blur(nameInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({ id: serverId, name: 'Filesystem' })
          ]
        })
      )
    )

    const commandInput = screen.getByLabelText(`MCP command for ${serverId}`)
    fireEvent.change(commandInput, { target: { value: 'npx' } })
    fireEvent.blur(commandInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [expect.objectContaining({ id: serverId, command: 'npx' })]
        })
      )
    )

    const argsInput = screen.getByLabelText(`MCP arguments for ${serverId}`)
    fireEvent.change(argsInput, { target: { value: '-y\n@modelcontextprotocol/server-filesystem\n.' } })
    fireEvent.blur(argsInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({
              id: serverId,
              args: ['-y', '@modelcontextprotocol/server-filesystem', '.']
            })
          ]
        })
      )
    )

    const envInput = screen.getByLabelText(`MCP environment for ${serverId}`)
    fireEvent.change(envInput, { target: { value: 'FOO=bar\nBAZ=qux' } })
    fireEvent.blur(envInput)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          mcpServers: [
            expect.objectContaining({
              id: serverId,
              env: { FOO: 'bar', BAZ: 'qux' }
            })
          ]
        })
      )
    )
  })

  it('shows MCP connection status in Marketplace manage view', async () => {
    const statusPayload = {
      ok: true as const,
      data: {
        servers: [
          {
            id: 'srv-1',
            name: 'Echo',
            enabled: true,
            connected: true,
            toolCount: 2
          }
        ]
      }
    }
    window.vyotiq.mcpStatus = vi.fn(async () => statusPayload)
    // Manage view loads status via mcpStatus on open. Refresh MCP is explicit.
    window.vyotiq.mcpRefresh = vi.fn(async () => statusPayload)

    const { MarketplaceView } = await import('@renderer/features/marketplace')
    render(
      <MarketplaceView
        settings={{
          ...baseSettings,
          mcpServers: [
            {
              id: 'srv-1',
              name: 'Echo',
              transport: 'stdio',
              command: 'node',
              args: ['echo.mjs'],
              enabled: true,
              source: 'manual'
            }
          ]
        }}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    fireEvent.click(screen.getByRole('tab', { name: /^Manage$/i }))
    expect(await screen.findByRole('tab', { name: /^MCPs$/i })).toBeTruthy()
    expect(await screen.findByText(/Connected · 2 tools/i)).toBeTruthy()
  })

  it('has no Marketplace section; registry lives in Marketplace Manage', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    expect(screen.queryByRole('button', { name: /^Marketplace$/i })).toBeNull()
    expect(screen.queryByLabelText(/Registry URL/i)).toBeNull()

    const { MarketplaceView } = await import('@renderer/features/marketplace')
    cleanup()
    render(
      <MarketplaceView
        settings={baseSettings}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Manage$/i }))
    expect(await screen.findByLabelText(/Package registry/i)).toBeTruthy()
    expect(screen.getByLabelText(/Registry URL/i)).toBeTruthy()
    expect(screen.getByLabelText(/Acknowledge marketplace install risk/i)).toBeTruthy()
  })

  it('Notifications and Diagnostics nav entries render real sections', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Notifications$/i }))
    expect(document.querySelectorAll('[data-settings-field]').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-settings-field="notifications-enabled"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Diagnostics$/i }))
    expect(document.querySelectorAll('[data-settings-field]').length).toBeGreaterThan(0)
    expect(document.querySelector('[data-settings-field="telemetry"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="recent-crashes"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="process-metrics"]')).toBeTruthy()
    // The typecheck/lint command configures an agent tool, so it is in Tools.
    expect(document.querySelector('[data-settings-field="diagnostics-command"]')).toBeNull()
    expect(document.querySelector('[data-settings-field="about"]')).toBeNull()
    expect(document.querySelector('[data-settings-field="github-client-id"]')).toBeNull()
  })

  it('Agent section owns permissions, runs, conversation, and rules', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/i }))
    for (const id of [
      'tool-approval',
      'mcp-tools-protection',
      'agent-autonomous-mode',
      'agent-autonomous-questions',
      'auto-mode-switch',
      'auto-resume-interrupted',
      'show-thinking',
      'keep-recent-turns',
      'auto-compact-threshold',
      'workspace-rules'
    ]) {
      expect(document.querySelector(`[data-settings-field="${id}"]`)).toBeTruthy()
    }
    expect(screen.getByRole('switch', { name: 'MCP tools protection' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    // The offline wait budget had no effect (runs wait out a lost connection
    // indefinitely) and the memory-files row was a paragraph, not a setting.
    expect(document.querySelector('[data-settings-field="agent-offline-wait"]')).toBeNull()
    expect(document.querySelector('[data-settings-field="memory-files"]')).toBeNull()
    expect(document.querySelector('[data-settings-field="codeindex-enabled"]')).toBeNull()
    // Questions only apply to autonomous runs, so they wait on that switch.
    expect(
      (screen.getByRole('button', { name: 'Questions in autonomous mode' }) as HTMLButtonElement)
        .disabled
    ).toBe(true)
  })

  it('Manage rules opens Marketplace on the Rules tab', () => {
    const onOpenMarketplace = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="agent"
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        onOpenMarketplace={onOpenMarketplace}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Manage rules$/ }))
    expect(onOpenMarketplace).toHaveBeenCalledWith('rules')
  })

  it('lists always-allowed tools under Tool approval and removes one', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          toolApproval: { mode: 'mutating', allowlist: ['edit', 'terminal'], mcpProtection: true }
        }}
        secrets={emptySecrets}
        section="agent"
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const row = document.querySelector('[data-settings-field="tool-approval-allowlist"]') as HTMLElement
    expect(row).toBeTruthy()
    expect(within(row).getByText('2 tools skip approval.')).toBeTruthy()
    fireEvent.click(within(row).getByRole('button', { name: 'Remove edit' }))
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          toolApproval: expect.objectContaining({ allowlist: ['terminal'] })
        })
      )
    )
  })

  it('Agent section renders the persona & style group', () => {
    render(
      <SettingsView
        settings={{ ...baseSettings, agentPersona: 'Nova', agentTone: 'friendly, blunt' }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        section="agent"
      />
    )
    expect(document.querySelector('[data-settings-field="agent-persona"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="agent-tone"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="response-language"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="response-verbosity"]')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Nova')
    expect((screen.getByLabelText('Tone') as HTMLInputElement).value).toBe('friendly, blunt')
    expect((screen.getByLabelText('Response language') as HTMLInputElement).value).toBe('')
  })

  it('persists persona, tone, and language edits on blur', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        section="agent"
      />
    )

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nova' } })
    fireEvent.blur(screen.getByLabelText('Name'))
    fireEvent.change(screen.getByLabelText('Tone'), { target: { value: 'friendly, blunt' } })
    fireEvent.blur(screen.getByLabelText('Tone'))
    fireEvent.change(screen.getByLabelText('Response language'), { target: { value: 'Spanish' } })
    fireEvent.blur(screen.getByLabelText('Response language'))

    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentPersona: 'Nova' }))
    })
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ agentTone: 'friendly, blunt' }))
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ responseLanguage: 'Spanish' }))
  })

  it('answer length menu persists the selected verbosity', () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        section="agent"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /^Answer length$/i }))
    const listbox = screen.getByRole('listbox')
    fireEvent.click(within(listbox).getByText('Detailed'))
    expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ responseVerbosity: 'detailed' }))
  })

  it('routes persona edits through the workspace override when active', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    const onSetSettingsOverride = vi.fn(async () => ({ ok: true as const, data: {} as never }))
    const workspacePath = 'C:/work/demo'
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        activeWorkspacePath={workspacePath}
        settingsOverridesByPath={{
          [workspacePath]: {
            useOverride: true,
            provider: 'openai',
            model: 'gpt-5.6'
          }
        }}
        effectiveChatSettings={{
          provider: 'openai',
          model: 'gpt-5.6',
          ollamaBaseUrl: DEFAULT_SETTINGS.ollamaBaseUrl,
          customOpenAiBaseUrl: DEFAULT_SETTINGS.customOpenAiBaseUrl,
          keepRecentTurns: DEFAULT_SETTINGS.keepRecentTurns,
          autoCompactThresholdRatio: DEFAULT_SETTINGS.autoCompactThresholdRatio,
          thinkingEnabled: DEFAULT_SETTINGS.thinkingEnabled,
          thinkingEffort: DEFAULT_SETTINGS.thinkingEffort,
          showThinking: DEFAULT_SETTINGS.showThinking,
          toolApproval: DEFAULT_SETTINGS.toolApproval,
          agentPersona: 'OverrideBot',
          agentTone: '',
          responseLanguage: '',
          responseVerbosity: 'concise'
        }}
        onSetSettingsOverride={onSetSettingsOverride}
        section="agent"
      />
    )

    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('OverrideBot')
    // The override is named once at the top and marked on each row it scopes.
    expect(screen.getByText(/Override is on for/)).toBeTruthy()
    const nameRow = document.querySelector('[data-settings-field="agent-persona"]') as HTMLElement
    expect(within(nameRow).getByText('Workspace')).toBeTruthy()
    const runsRow = document.querySelector('[data-settings-field="auto-mode-switch"]') as HTMLElement
    expect(within(runsRow).queryByText('Workspace')).toBeNull()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed' } })
    fireEvent.blur(screen.getByLabelText('Name'))

    await waitFor(() => {
      expect(onSetSettingsOverride).toHaveBeenCalledWith(
        workspacePath,
        expect.objectContaining({ useOverride: true, agentPersona: 'Changed' })
      )
    })
    expect(onUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ agentPersona: 'Changed' }))
  })

  it('Indexing section owns codebase index controls', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Indexing$/i }))
    expect(document.querySelector('[data-settings-field="codeindex-enabled"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="codeindex-status"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="show-thinking"]')).toBeNull()
    expect(screen.getByRole('button', { name: /Reindex workspace/i })).toBeTruthy()
  })

  it('Voice section wires Install, Unload, and Delete cache', async () => {
    const idle = {
      phase: 'idle' as const,
      progress: null,
      message: null,
      error: null,
      installed: [] as Array<{
        id: 'whisper-tiny.en' | 'whisper-small.en'
        bytesOnDisk: number
        loaded: boolean
      }>,
      recommendedModelId: 'whisper-small.en' as const,
      engine: 'openai' as const,
      activeModelId: null,
      loadedModelId: null
    }
    const install = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...idle,
        phase: 'ready' as const,
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: true }],
        loadedModelId: 'whisper-tiny.en' as const
      }
    }))
    const unload = vi.fn(async () => ({
      ok: true as const,
      data: {
        ...idle,
        phase: 'ready' as const,
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: false }]
      }
    }))
    const deleteCache = vi.fn(async () => ({ ok: true as const, data: idle }))
    window.vyotiq.dictationInstall = install
    window.vyotiq.dictationUnload = unload
    window.vyotiq.dictationDeleteCache = deleteCache

    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    expect(document.querySelector('[data-settings-field="dictation-engine"]')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Install Whisper Tiny/i })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /Install Whisper Tiny/i }))
    await waitFor(() =>
      expect(install).toHaveBeenCalledWith({ modelId: 'whisper-tiny.en' })
    )
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Unload Whisper Tiny/i })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: /Unload Whisper Tiny/i }))
    await waitFor(() => expect(unload).toHaveBeenCalled())
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Delete Whisper Tiny cache/i })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole('button', { name: /Delete Whisper Tiny cache/i }))
    await waitFor(() =>
      expect(deleteCache).toHaveBeenCalledWith({ modelId: 'whisper-tiny.en' })
    )
  })

  it('disables Local dictation engine until a model is installed', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    fireEvent.click(screen.getByLabelText('Dictation engine'))
    const local = await waitFor(() => screen.getByRole('option', { name: /^Local$/i }))
    expect(local.getAttribute('aria-disabled')).toBe('true')
  })

  it('Waveform menu patches dictation.waveformStyle', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    expect(document.querySelector('[data-settings-field="dictation-waveform"]')).toBeTruthy()
    fireEvent.click(screen.getByLabelText('Waveform'))
    fireEvent.click(await waitFor(() => screen.getByRole('option', { name: /^Dots$/i })))
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(onUpdate).toHaveBeenCalledWith({
      dictation: { ...DEFAULT_SETTINGS.dictation, waveformStyle: 'dots' }
    })
  })

  it('switching to Local does not send empty localModelId from stale form state', async () => {
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'ready' as const,
        progress: 1,
        message: 'Ready',
        error: null,
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: true }],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'openai' as const,
        activeModelId: null,
        loadedModelId: 'whisper-tiny.en' as const
      }
    }))
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          dictation: { ...DEFAULT_SETTINGS.dictation, engine: 'openai', localModelId: '' }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    await waitFor(() => expect(window.vyotiq.dictationStatus).toHaveBeenCalled())
    fireEvent.click(screen.getByLabelText('Dictation engine'))
    const local = await waitFor(() => screen.getByRole('option', { name: /^Local$/i }))
    expect(local.getAttribute('aria-disabled')).not.toBe('true')
    fireEvent.click(local)
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(onUpdate).toHaveBeenCalledWith({
      dictation: {
        ...DEFAULT_SETTINGS.dictation,
        engine: 'local',
        localModelId: 'whisper-tiny.en'
      }
    })
  })

  it('Voice cards prefer Error over Ready when load failed with files on disk', async () => {
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'error' as const,
        progress: null,
        message: 'Failed: whisper-tiny.en',
        error: 'ONNX load failed',
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: false }],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'local' as const,
        activeModelId: 'whisper-tiny.en' as const,
        loadedModelId: null
      }
    }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          dictation: {
            ...DEFAULT_SETTINGS.dictation,
            engine: 'local',
            localModelId: 'whisper-tiny.en'
          }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    await waitFor(() => expect(window.vyotiq.dictationStatus).toHaveBeenCalled())
    const tiny = document.querySelector('[data-settings-field="dictation-whisper-tiny"]')
    expect(tiny).toBeTruthy()
    expect(tiny!.textContent).toMatch(/Error: ONNX load failed/)
    expect(tiny!.textContent).not.toMatch(/Ready · on disk/)
    expect(tiny!.textContent).toMatch(/In use/)
  })

  it('shows an indeterminate load bar without a stuck 0%', async () => {
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'loading' as const,
        progress: null,
        message: 'Loading whisper-tiny.en',
        error: null,
        installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: false }],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'local' as const,
        activeModelId: 'whisper-tiny.en' as const,
        loadedModelId: null
      }
    }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          dictation: {
            ...DEFAULT_SETTINGS.dictation,
            engine: 'local',
            localModelId: 'whisper-tiny.en'
          }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    const bar = await waitFor(() =>
      screen.getByRole('progressbar', { name: /whisper-tiny\.en load progress/i })
    )
    expect(bar.getAttribute('aria-valuenow')).toBeNull()
    const tiny = document.querySelector('[data-settings-field="dictation-whisper-tiny"]')
    expect(tiny?.textContent).toMatch(/Loading whisper-tiny\.en/)
    expect(tiny?.textContent).not.toMatch(/0%/)
  })

  it('Use on an installed card sets localModelId without changing engine or loading', async () => {
    const install = vi.fn(async () => ({ ok: false as const, error: 'not used' }))
    const unload = vi.fn(async () => ({ ok: false as const, error: 'not used' }))
    window.vyotiq.dictationInstall = install
    window.vyotiq.dictationUnload = unload
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: true as const,
      data: {
        phase: 'ready' as const,
        progress: 1,
        message: 'Ready',
        error: null,
        installed: [
          { id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: false },
          { id: 'whisper-small.en' as const, bytesOnDisk: 249, loaded: false }
        ],
        recommendedModelId: 'whisper-small.en' as const,
        engine: 'openai' as const,
        activeModelId: null,
        loadedModelId: null
      }
    }))
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          dictation: {
            ...DEFAULT_SETTINGS.dictation,
            engine: 'openai',
            localModelId: 'whisper-small.en'
          }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    await waitFor(() => expect(window.vyotiq.dictationStatus).toHaveBeenCalled())
    const small = document.querySelector('[data-settings-field="dictation-whisper-small"]')
    expect(small?.textContent).toMatch(/In use/)
    expect(screen.queryByRole('button', { name: /Use Whisper Small/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Use Whisper Tiny/i }))
    await waitFor(() => expect(onUpdate).toHaveBeenCalled())
    expect(onUpdate).toHaveBeenCalledWith({
      dictation: {
        ...DEFAULT_SETTINGS.dictation,
        engine: 'openai',
        localModelId: 'whisper-tiny.en'
      }
    })
    expect(install).not.toHaveBeenCalled()
    expect(unload).not.toHaveBeenCalled()
  })

  it('settings search navigates to dictation engine', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const search = screen.getByLabelText(/Search settings/i)
    fireEvent.change(search, { target: { value: 'whisper' } })
    fireEvent.click(screen.getByRole('option', { name: /Dictation engine/i }))
    expect(
      await waitFor(() => {
        const el = document.querySelector('[data-settings-field="dictation-engine"]')
        expect(el).toBeTruthy()
        return el
      })
    ).toBeTruthy()
  })

  it('Tools section owns terminal, browser, MCP, and the tool catalog', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Tools$/i }))
    for (const id of [
      'terminal-shell',
      'diagnostics-command',
      'terminal-screen-reader',
      'search-engine',
      'browser-domain-allowlist',
      'mcp-tool-loading',
      'mcp-servers',
      'tools-catalog'
    ]) {
      expect(document.querySelector(`[data-settings-field="${id}"]`)).toBeTruthy()
    }
    // Approval and run behavior moved to Agent; pane count is layout (General).
    for (const id of ['tool-approval', 'auto-resume-interrupted', 'auto-mode-switch', 'max-chat-panes']) {
      expect(document.querySelector(`[data-settings-field="${id}"]`)).toBeNull()
    }
  })

  it('saves the diagnostics command trimmed on blur', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="tools"
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const input = screen.getByLabelText('Diagnostics command')
    fireEvent.change(input, { target: { value: '  pnpm typecheck  ' } })
    fireEvent.blur(input)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({ diagnosticsCommand: 'pnpm typecheck' })
    )
  })

  it('saves browser domain allowlist on blur', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Tools$/i }))
    const field = screen.getByLabelText('Browser domain allowlist')
    fireEvent.change(field, {
      target: { value: 'example.com\nhttps://api.allowed.dev/path\n*.corp.internal' }
    })
    fireEvent.blur(field)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({
        browserDomainAllowlist: ['example.com', 'api.allowed.dev', '*.corp.internal']
      })
    )
  })

  it('settings search navigates to browser domain allowlist', async () => {
    Element.prototype.scrollIntoView = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const search = screen.getByLabelText(/Search settings/i)
    fireEvent.change(search, { target: { value: 'browser domain' } })
    fireEvent.click(screen.getByRole('option', { name: /Domain allowlist/i }))
    expect(
      await waitFor(() => {
        const el = document.querySelector('[data-settings-field="browser-domain-allowlist"]')
        expect(el).toBeTruthy()
        return el
      })
    ).toBeTruthy()
  })

  it('search index and rendered rows match in both directions, section by section', () => {
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          // The allowlist row only exists once a tool has been allowed.
          toolApproval: { ...baseSettings.toolApproval, allowlist: ['read_file'] }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        onAppearanceChange={vi.fn()}
      />
    )
    const indexed = new Set(SETTINGS_SEARCH_INDEX.map((entry) => entry.id))
    expect(indexed.size).toBe(SETTINGS_SEARCH_INDEX.length)
    const renderedBySection = new Map<string, Set<string>>()
    const mistitled: string[] = []
    // Results that name a part of their row rather than its visible title: a
    // provider's base URL field lives inside that provider's accordion row,
    // and the Shortcuts entry lands on the whole list.
    const namedForContent = new Set(['shortcuts', 'ollama-url', 'custom-url'])
    for (const section of SECTION_GROUPS.flatMap((group) => group.sections)) {
      const name = SECTION_LABELS[section]
      fireEvent.click(screen.getByRole('button', { name: new RegExp(`^${name}$`, 'i') }))
      const ids = new Set<string>()
      document.querySelectorAll('[data-settings-field]').forEach((el) => {
        const id = el.getAttribute('data-settings-field')
        if (id) ids.add(id)
      })
      renderedBySection.set(section, ids)
      for (const entry of SETTINGS_SEARCH_INDEX.filter((e) => e.section === section)) {
        const row = document.querySelector(`[data-settings-field="${entry.id}"]`)
        if (!row || namedForContent.has(entry.id)) continue
        if (!row.textContent?.includes(entry.title)) mistitled.push(`${entry.id}: ${entry.title}`)
      }
    }
    const rendered = new Set([...renderedBySection.values()].flatMap((ids) => [...ids]))
    // Every row can be found…
    expect([...rendered].filter((id) => !indexed.has(id))).toEqual([])
    // …and every result lands on a row that exists, in the section it names.
    expect(
      SETTINGS_SEARCH_INDEX.filter(
        (entry) => !renderedBySection.get(entry.section)?.has(entry.id)
      ).map((entry) => `${entry.section}:${entry.id}`)
    ).toEqual([])
    // …under the name it was listed with: a result called "Copy build info"
    // that highlights a row called "Build info" reads as the wrong result.
    expect(mistitled).toEqual([])
  })

  it('settings search navigates to the Agent auto-resume field', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    const search = screen.getByLabelText(/Search settings/i)
    fireEvent.change(search, { target: { value: 'resume' } })
    fireEvent.click(screen.getByRole('option', { name: /Auto-resume interrupted runs/i }))
    expect(
      await waitFor(() => {
        const el = document.querySelector('[data-settings-field="auto-resume-interrupted"]')
        expect(el).toBeTruthy()
        return el
      })
    ).toBeTruthy()
  })

  it('Shortcuts section lists keyboard chords', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Shortcuts$/i }))
    expect(screen.getByText('Search and commands')).toBeTruthy()
    expect(screen.getByText('Ctrl+K')).toBeTruthy()
    expect(screen.getByText('Next task that needs you')).toBeTruthy()
    expect(screen.getByText('Ctrl+J')).toBeTruthy()
    expect(screen.getByText('Jump to latest')).toBeTruthy()
    expect(screen.getByText('End')).toBeTruthy()
  })

  it('settings search for keyboard jumps to Shortcuts', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.change(screen.getByLabelText(/Search settings/i), {
      target: { value: 'keyboard' }
    })
    fireEvent.click(screen.getByRole('option', { name: /Keyboard shortcuts/i }))
    expect(screen.getByText('Search and commands')).toBeTruthy()
    expect(screen.getByText('Ctrl+K')).toBeTruthy()
    expect(screen.getByText('Next task that needs you')).toBeTruthy()
    expect(screen.getByText('Ctrl+J')).toBeTruthy()
  })

  it('About section shows lockup, version, runtime, website, and docs', async () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^About$/i }))
    const aboutLockup = document.querySelector('[data-settings-field="about"] [data-brand-lockup]')
    expect(aboutLockup).toBeTruthy()
    expect(aboutLockup?.getAttribute('aria-label')).toBe('Vyotiq')
    expect(await screen.findByText('1.0.0')).toBeTruthy()
    expect(screen.getByText('43.2.0')).toBeTruthy()
    expect(screen.getByText('132.0.6834.196')).toBeTruthy()
    expect(screen.getByText('22.17.0')).toBeTruthy()
    expect(screen.getByText(/Windows x64 · 10\.0\.26200/)).toBeTruthy()
    expect(screen.getByText('Agent V. A product of Vyotiq.com.')).toBeTruthy()
    // The links live inline in the brand card now, not in their own group of
    // full-width rows; the field ids stay so settings search still finds them.
    expect(screen.queryByText('Links')).toBeNull()
    const websiteLink = document.querySelector('[data-settings-field="about-website"]')
    expect(websiteLink).toBeTruthy()
    expect(websiteLink?.textContent).toBe('Website')
    fireEvent.click(websiteLink as HTMLElement)
    await waitFor(() => {
      expect(window.vyotiq.shellOpenExternal).toHaveBeenCalledWith('https://vyotiq.com')
    })
    const docsLink = document.querySelector('[data-settings-field="about-docs"]')
    expect(docsLink).toBeTruthy()
    fireEvent.click(docsLink as HTMLElement)
    await waitFor(() => {
      expect(window.vyotiq.shellOpenExternal).toHaveBeenCalledWith(
        new URL('/docs', 'https://vyotiq.com').href
      )
    })
  })

  it('closes on Escape from an empty settings search', () => {
    const onClose = vi.fn()
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={onClose}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.keyDown(screen.getByLabelText(/Search settings/i), { key: 'Escape' })
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('Notifications group toggles persist notifications settings', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        section="notifications"
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(document.querySelector('[data-settings-field="notifications-enabled"]')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable notifications' }))
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalled()
    })
    const payload = onUpdate.mock.calls[0]?.[0] as { notifications?: { enabled?: boolean } }
    expect(payload.notifications?.enabled).toBe(false)
  })

  it('renders organized structure across About, Voice, and Agent sections', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    render(
      <SettingsView
        settings={{
          ...baseSettings,
          agentPersona: 'Code Specialist',
          agentTone: 'Terse and accurate',
          dictation: {
            ...DEFAULT_SETTINGS.dictation,
            engine: 'local',
            localModelId: 'whisper-small.en'
          }
        }}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={onUpdate}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )

    // About Section
    fireEvent.click(screen.getByRole('button', { name: /^About$/i }))
    expect(document.querySelector('[data-settings-field="about"]')).toBeTruthy()
    expect(screen.getByText('Build')).toBeTruthy()
    expect(screen.getByText('Updates')).toBeTruthy()
    // Links are inline in the brand card, not a group of their own.
    expect(screen.queryByText('Links')).toBeNull()
    expect(document.querySelector('[data-settings-field="about-source"]')).toBeTruthy()

    // Agent Section
    fireEvent.click(screen.getByRole('button', { name: /^Agent$/i }))
    expect(document.querySelector('[data-settings-field="agent-persona"]')).toBeTruthy()
    expect(document.querySelector('[data-settings-field="agent-tone"]')).toBeTruthy()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Code Specialist')
    // Short text shows no counter; it appears only near the limit.
    expect(screen.queryByText(/15\/1000/)).toBeNull()
    expect(screen.getByText('turns')).toBeTruthy()

    // Compaction input commits on blur (Enter blurs in the browser)
    const turnsInput = screen.getByLabelText('Keep recent turns')
    fireEvent.change(turnsInput, { target: { value: '20' } })
    fireEvent.blur(turnsInput)
    await waitFor(() => {
      expect(onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ keepRecentTurns: 20 })
      )
    })

    // Voice Section
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    await waitFor(() => expect(window.vyotiq.dictationStatus).toHaveBeenCalled())
    expect(screen.getByText('Local Whisper models')).toBeTruthy()
    await waitFor(() => {
      const smallField = document.querySelector('[data-settings-field="dictation-whisper-small"]')
      expect(smallField?.textContent).toMatch(/Recommended for this PC/)
    })
  })

  it('Voice action errors persist across status pushes', async () => {
    const status = {
      phase: 'idle' as const,
      progress: null,
      message: null,
      error: null,
      installed: [{ id: 'whisper-tiny.en' as const, bytesOnDisk: 41, loaded: false }],
      recommendedModelId: 'whisper-small.en' as const,
      engine: 'openai' as const,
      activeModelId: null,
      loadedModelId: null
    }
    let pushStatus: ((s: Record<string, unknown>) => void) | undefined
    window.vyotiq.dictationStatus = vi.fn(async () => ({ ok: true as const, data: status }))
    // @ts-expect-error test bridge
    window.vyotiq.onDictationStatus = vi.fn((cb: (s: Record<string, unknown>) => void) => {
      pushStatus = cb
      return () => {}
    })
    window.vyotiq.dictationDeleteCache = vi.fn(async () => ({
      ok: false as const,
      error: 'cache delete boom'
    }))
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    const deleteButton = await waitFor(() =>
      screen.getByRole('button', { name: /Delete Whisper Tiny cache/i })
    )
    fireEvent.click(deleteButton)
    await waitFor(() => expect(screen.getByText('cache delete boom')).toBeTruthy())
    pushStatus?.({ ...status, phase: 'ready' })
    await waitFor(() => expect(screen.getByText(/Ready · on disk/i)).toBeTruthy())
    expect(screen.getByText('cache delete boom')).toBeTruthy()
  })

  it('Voice load errors clear on the next status refresh', async () => {
    const status = {
      phase: 'idle' as const,
      progress: null,
      message: null,
      error: null,
      installed: [],
      recommendedModelId: 'whisper-small.en' as const,
      engine: 'openai' as const,
      activeModelId: null,
      loadedModelId: null
    }
    let pushStatus: ((s: Record<string, unknown>) => void) | undefined
    window.vyotiq.dictationStatus = vi.fn(async () => ({
      ok: false as const,
      error: 'status endpoint down'
    }))
    // @ts-expect-error test bridge
    window.vyotiq.onDictationStatus = vi.fn((cb: (s: Record<string, unknown>) => void) => {
      pushStatus = cb
      return () => {}
    })
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /^Voice$/i }))
    await waitFor(() => expect(screen.getByText('status endpoint down')).toBeTruthy())
    pushStatus?.(status)
    await waitFor(() => expect(screen.queryByText('status endpoint down')).toBeNull())
  })

  it('General section shows the Navigation choice with Home page selected by default', () => {
    render(
      <SettingsView
        settings={baseSettings}
        secrets={emptySecrets}
        onClose={vi.fn()}
        onUpdate={vi.fn(async () => ({ ok: true as const }))}
        onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
        onClearSecret={vi.fn(async () => ({ ok: true as const }))}
      />
    )
    expect(document.querySelector('[data-settings-field="navigation"]')).toBeTruthy()
    const home = screen.getByRole('button', { name: 'Home page' }) as HTMLButtonElement
    const chat = screen.getByRole('button', { name: 'Sidebar' }) as HTMLButtonElement
    expect(home.getAttribute('aria-pressed')).toBe('true')
    expect(chat.getAttribute('aria-pressed')).toBe('false')
  })

  it('Navigation choice persists through onUpdate', async () => {
    const onUpdate = vi.fn(async () => ({ ok: true as const }))
    function Harness() {
      const [settings, setSettings] = useState<Settings>(baseSettings)
      return (
        <SettingsView
          settings={settings}
          secrets={emptySecrets}
          onClose={vi.fn()}
          onUpdate={async (partial) => {
            setSettings((prev) => ({ ...prev, ...partial }))
            return onUpdate(partial)
          }}
          onSaveSecret={vi.fn(async () => ({ ok: true as const }))}
          onClearSecret={vi.fn(async () => ({ ok: true as const }))}
        />
      )
    }
    render(<Harness />)
    const chat = screen.getByRole('button', { name: 'Sidebar' }) as HTMLButtonElement
    expect((screen.getByRole('button', { name: 'Home page' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(chat)
    await waitFor(() =>
      expect(onUpdate).toHaveBeenCalledWith({ navigationMode: 'sidebar' })
    )
    await waitFor(() => expect(chat.getAttribute('aria-pressed')).toBe('true'))
    expect((screen.getByRole('button', { name: 'Home page' }) as HTMLButtonElement).getAttribute('aria-pressed')).toBe('false')
  })
})
