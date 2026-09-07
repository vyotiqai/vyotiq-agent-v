/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { ModelPicker } from '@renderer/features/chat/components/composer/ModelPicker'
import {
  compactModelLabel,
  type ModelPickerOption
} from '@renderer/features/chat/components/composer/composerModelUtils'

afterEach(() => {
  cleanup()
})

describe('compactModelLabel', () => {
  it('strips a matching provider or group prefix', () => {
    expect(compactModelLabel('OpenAI: GPT-5.6 Luna Pro', 'OpenAI')).toBe('GPT-5.6 Luna Pro')
    expect(compactModelLabel('Qwen: Qwen3.7 Flash', 'OpenRouter', 'Qwen')).toBe('Qwen3.7 Flash')
  })

  it('keeps labels when the prefix does not match', () => {
    expect(compactModelLabel('Claude Opus 5 (Fast)', 'Anthropic')).toBe('Claude Opus 5 (Fast)')
    expect(compactModelLabel('OpenAI: GPT-5.6', 'Anthropic')).toBe('OpenAI: GPT-5.6')
  })
})

const openaiOptions: ModelPickerOption[] = [
  {
    value: 'openai::gpt-5.6',
    label: 'gpt-5.6',
    group: 'OpenAI',
    meta: {
      id: 'gpt-5.6',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: true,
      supportsThinking: true,
      supportedServiceTiers: ['default', 'flex', 'priority']
    }
  },
  {
    value: 'openai::gpt-4.1',
    label: 'gpt-4.1',
    group: 'OpenAI',
    meta: {
      id: 'gpt-4.1',
      inputModalities: ['text'],
      outputModalities: ['text'],
      supportsTools: true,
      supportsVision: false,
      supportsThinking: false
    }
  }
]

const optionsByProvider = {
  openai: openaiOptions,
  anthropic: [
    {
      value: 'anthropic::claude-sonnet-5',
      label: 'claude-sonnet-5',
      group: 'Anthropic',
      meta: {
        id: 'claude-sonnet-5',
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: true,
        supportsThinking: true
      }
    }
  ],
  gemini: [],
  ollama: [],
  deepseek: [],
  groq: [],
  openrouter: [],
  xai: [],
  mistral: []
} as Record<import('@shared/ipc').ProviderId, ModelPickerOption[]>

const seedsByProvider = { ...optionsByProvider }

describe('ModelPicker', () => {
  it('opens panel with provider tabs and no agent settings', () => {
    render(
      <ModelPicker
        providers={['openai', 'anthropic']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{ 'openai::gpt-5.6': openaiOptions[0].meta! }}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByRole('listbox', { name: /Select model/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /OpenAI/i })).toBeTruthy()
    expect(screen.queryByLabelText(/Max steps/i)).toBeNull()
  })

  it('selects a model without closing requirement enforced by parent', () => {
    const onModelChange = vi.fn()
    render(
      <ModelPicker
        providers={['openai', 'anthropic']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={onModelChange}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Anthropic$/i }))
    fireEvent.click(screen.getByRole('option', { name: /claude-sonnet-5/i }))
    expect(onModelChange).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5')
  })

  it('shows speed footer for capable models', () => {
    const onServiceTierChange = vi.fn()
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{ 'openai::gpt-5.6': openaiOptions[0].meta! }}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={onServiceTierChange}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.click(screen.getByRole('button', { name: /^Fast\b/i }))
    expect(onServiceTierChange).toHaveBeenCalledWith('priority')
  })

  it('shows empty catalog message when browsed provider has a seed fallback warning', () => {
    render(
      <ModelPicker
        providers={['ollama']}
        optionsByProvider={{ ...optionsByProvider, ollama: [] }}
        seedsByProvider={{ ...seedsByProvider, ollama: [] }}
        modelMetaByValue={{}}
        provider="ollama"
        model="qwen2.5"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{
          ollama:
            'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).'
        }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByText(/No live models available/i)).toBeTruthy()
    expect(screen.queryByRole('option', { name: /qwen2\.5/i })).toBeNull()
  })

  it('shows catalog warning banner', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: 'Using offline model list' }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    expect(screen.getByText(/offline model list/i)).toBeTruthy()
  })

  it('reserves capability badge columns when Think is missing', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const row = screen.getByRole('option', { name: /gpt-4\.1/i })
    const badges = row.querySelector('[data-capability-badges]')
    expect(badges).toBeTruthy()
    const chips = badges!.querySelectorAll(':scope > span')
    expect(chips.length).toBe(3)
    expect(chips[0]!.textContent).toBe('Think')
    expect(chips[0]!.className).toMatch(/invisible/)
    expect(chips[1]!.textContent).toBe('Vision')
    expect(chips[1]!.className).toMatch(/invisible/)
    expect(chips[2]!.textContent).toBe('Tools')
    expect(chips[2]!.className).not.toMatch(/invisible/)
  })

  it('exposes full model label via title on rows', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const row = screen.getByRole('option', { name: /gpt-5\.6/i })
    const label = within(row).getByTitle('gpt-5.6')
    expect(label).toBeTruthy()
    expect(label.className).toMatch(/truncate/)
  })

  it('scrolls the keyboard-active option into view while navigating', () => {
    const scrollIntoView = vi.fn()
    const original = Element.prototype.scrollIntoView
    Element.prototype.scrollIntoView = scrollIntoView
    try {
      render(
        <ModelPicker
          providers={['openai']}
          optionsByProvider={optionsByProvider}
          seedsByProvider={seedsByProvider}
          modelMetaByValue={{}}
          provider="openai"
          model="gpt-5.6"
          favoriteModels={[]}
          recentModels={[]}
          warningsByProvider={{ openai: null, anthropic: null }}
          serviceTier="default"
          onModelChange={vi.fn()}
          onToggleFavorite={vi.fn()}
          onServiceTierChange={vi.fn()}
          onRefreshCatalog={vi.fn()}
          triggerClassName="test-trigger"
        />
      )

      fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
      const search = screen.getByLabelText('Search models')
      expect(scrollIntoView).not.toHaveBeenCalled()

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(scrollIntoView).toHaveBeenCalledTimes(1)
      const active = scrollIntoView.mock.instances[0] as HTMLElement
      expect(active.closest('[role="option"]')).toBe(
        screen.getByRole('option', { name: /gpt-5\.6/i })
      )
      expect(scrollIntoView.mock.calls[0]![0]).toEqual({ block: 'nearest' })

      fireEvent.keyDown(search, { key: 'ArrowDown' })
      expect(scrollIntoView).toHaveBeenCalledTimes(2)
      const next = scrollIntoView.mock.instances[1] as HTMLElement
      expect(next.closest('[role="option"]')).toBe(
        screen.getByRole('option', { name: /gpt-4\.1/i })
      )
    } finally {
      Element.prototype.scrollIntoView = original
    }
  })

  it('wires aria-activedescendant to the keyboard-active row', () => {
    render(
      <ModelPicker
        providers={['openai']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    const listbox = screen.getByRole('listbox', { name: /Select model/i })
    expect(listbox.getAttribute('aria-activedescendant')).toBeNull()
    fireEvent.keyDown(listbox, { key: 'ArrowDown' })
    expect(listbox.getAttribute('aria-activedescendant')).toBe(
      screen.getAllByRole('option')[0]!.id
    )
  })

  it('does not persist the provider tab when search switches providers', () => {
    sessionStorage.removeItem('vyotiq:model-picker-tab')
    const onBrowseProvider = vi.fn()
    render(
      <ModelPicker
        providers={['openai', 'anthropic']}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={{}}
        provider="openai"
        model="gpt-5.6"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{ openai: null, anthropic: null }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        onBrowseProvider={onBrowseProvider}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.change(screen.getByLabelText('Search models'), { target: { value: 'claude' } })
    expect(screen.getByRole('option', { name: /claude-sonnet-5/i })).toBeTruthy()
    expect(onBrowseProvider).toHaveBeenCalledWith('anthropic')
    expect(sessionStorage.getItem('vyotiq:model-picker-tab')).toBeNull()
  })
})

const CUSTOM_WARNING =
  'Cannot reach custom OpenAI-compatible host at https://example.com/v1 (HTTP 404). Check the base URL and that the server is running. Showing seed defaults (not live models).'

function renderCustomPicker(overrides: {
  optionsByProvider?: Partial<Record<string, ModelPickerOption[]>>
  warningsByProvider?: Partial<Record<string, string | null>>
  onModelChange?: ReturnType<typeof vi.fn>
}): void {
  const onModelChange = overrides.onModelChange ?? vi.fn()
  render(
    <ModelPicker
      providers={['custom']}
      optionsByProvider={
        { ...optionsByProvider, custom: overrides.optionsByProvider?.custom ?? [] } as Record<
          import('@shared/ipc').ProviderId,
          ModelPickerOption[]
        >
      }
      seedsByProvider={
        { ...seedsByProvider, custom: [] } as Record<
          import('@shared/ipc').ProviderId,
          ModelPickerOption[]
        >
      }
      modelMetaByValue={{}}
      provider="custom"
      model="gpt-oss-120b"
      favoriteModels={[]}
      recentModels={[]}
      warningsByProvider={overrides.warningsByProvider ?? { custom: CUSTOM_WARNING }}
      serviceTier="default"
      onModelChange={onModelChange}
      onToggleFavorite={vi.fn()}
      onServiceTierChange={vi.fn()}
      onRefreshCatalog={vi.fn()}
      triggerClassName="test-trigger"
    />
  )
  fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
}

describe('ModelPicker manual model ID (custom provider)', () => {
  it('shows manual-entry empty-state copy and offers the typed query as a model ID under a seed fallback warning', () => {
    const onModelChange = vi.fn()
    renderCustomPicker({ onModelChange })

    expect(
      screen.getByText(
        /No live models available\. Type a model ID above and press Enter to use it manually\./i
      )
    ).toBeTruthy()

    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: '@cf/openai/gpt-oss-120b' } })
    const row = screen.getByRole('option', { name: /Use "@cf\/openai\/gpt-oss-120b"/i })
    fireEvent.click(row)
    expect(onModelChange).toHaveBeenCalledWith('custom', '@cf/openai/gpt-oss-120b')
  })

  it('picks the manual model ID with Enter when no option is active', () => {
    const onModelChange = vi.fn()
    renderCustomPicker({ onModelChange })

    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: '@cf/openai/gpt-oss-120b' } })
    fireEvent.keyDown(search, { key: 'Enter' })
    expect(onModelChange).toHaveBeenCalledWith('custom', '@cf/openai/gpt-oss-120b')
  })

  it('hides the manual row when the query exactly matches an existing option', () => {
    renderCustomPicker({
      optionsByProvider: {
        custom: [
          {
            value: 'custom::my-model',
            label: 'my-model',
            group: 'Custom OpenAI-compatible',
            meta: {
              id: 'my-model',
              inputModalities: ['text'],
              outputModalities: ['text'],
              supportsTools: true,
              supportsVision: false,
              supportsThinking: false
            }
          }
        ]
      }
    })

    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: 'my-model' } })
    expect(screen.getByRole('option', { name: /my-model/i })).toBeTruthy()
    expect(screen.queryByRole('option', { name: /Use "my-model"/i })).toBeNull()
  })

  it('does not offer a manual row for non-custom providers', () => {
    render(
      <ModelPicker
        providers={['ollama']}
        optionsByProvider={{ ...optionsByProvider, ollama: [] } as Record<
          import('@shared/ipc').ProviderId,
          ModelPickerOption[]
        >}
        seedsByProvider={{ ...seedsByProvider, ollama: [] } as Record<
          import('@shared/ipc').ProviderId,
          ModelPickerOption[]
        >}
        modelMetaByValue={{}}
        provider="ollama"
        model="qwen2.5"
        favoriteModels={[]}
        recentModels={[]}
        warningsByProvider={{
          ollama:
            'Cannot reach Ollama at http://127.0.0.1:11434. Showing seed defaults (not live models).'
        }}
        serviceTier="default"
        onModelChange={vi.fn()}
        onToggleFavorite={vi.fn()}
        onServiceTierChange={vi.fn()}
        onRefreshCatalog={vi.fn()}
        triggerClassName="test-trigger"
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Select model/i }))
    fireEvent.change(screen.getByLabelText('Search models'), {
      target: { value: 'some-typed-id' }
    })
    expect(screen.queryByRole('option', { name: /Use "some-typed-id"/i })).toBeNull()
    expect(screen.getByText(/No matches/i)).toBeTruthy()
  })

  it('still offers the manual row when the live catalog loaded and the query is unlisted', () => {
    const onModelChange = vi.fn()
    renderCustomPicker({
      optionsByProvider: {
        custom: [
          {
            value: 'custom::listed-model',
            label: 'listed-model',
            group: 'Custom OpenAI-compatible',
            meta: {
              id: 'listed-model',
              inputModalities: ['text'],
              outputModalities: ['text'],
              supportsTools: true,
              supportsVision: false,
              supportsThinking: false
            }
          }
        ]
      },
      warningsByProvider: { custom: null },
      onModelChange
    })

    const search = screen.getByLabelText('Search models')
    fireEvent.change(search, { target: { value: '@cf/openai/gpt-oss-120b' } })
    fireEvent.click(screen.getByRole('option', { name: /Use "@cf\/openai\/gpt-oss-120b"/i }))
    expect(onModelChange).toHaveBeenCalledWith('custom', '@cf/openai/gpt-oss-120b')
  })
})
