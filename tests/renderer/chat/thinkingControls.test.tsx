/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ThinkingControls, modelShowsThinkingControls } from '@renderer/features/chat/components/composer/ThinkingControls'
import type { EffectiveChatSettings } from '@shared/effectiveSettings'
import { seedModelsFor } from '@shared/providers'
import type { ModelInfo } from '@shared/ipc/schemas/providers'
import { loadOpenCodeGoCatalog } from '@shared/domain/opencodeGoCatalog'

afterEach(() => {
  cleanup()
})

const chatSettings: EffectiveChatSettings = {
  provider: 'openai',
  model: 'gpt-5.6',
  keepRecentTurns: 12,
  thinkingEnabled: true,
  thinkingEffort: 'medium',
  showThinking: true
}

function thinkingButton(): HTMLElement {
  return screen.getByRole('button', { name: /Thinking/i })
}

describe('ThinkingControls', () => {
  it('is hidden for non-thinking models', () => {
    const { container } = render(
      <ThinkingControls
        provider="openai"
        model="gpt-4o"
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('stays visible but locked while the agent is running', () => {
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
        running
      />
    )
    const button = screen.getByRole('button', { name: /locked while running/i })
    expect(button).toBeTruthy()
    expect(button).toHaveProperty('disabled', true)
  })

  it('cycles effort forward on click', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
      />
    )

    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'high'
    })
  })

  it('cycles to off after max', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'max' }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )

    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({ thinkingEnabled: false })
  })

  it('enables thinking from off on click', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEnabled: false }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )

    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'minimal'
    })
  })

  it('cycles backward with shift-click', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
      />
    )

    fireEvent.click(thinkingButton(), { shiftKey: true })
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'low'
    })
  })

  it('survives switching between thinking and non-thinking models', () => {
    const onChatSettingsChange = vi.fn()
    const { container, rerender } = render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
      />
    )

    expect(thinkingButton()).toBeTruthy()

    rerender(
      <ThinkingControls
        provider="openai"
        model="gpt-4o"
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    expect(container.firstChild).toBeNull()

    rerender(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    expect(thinkingButton()).toBeTruthy()
  })

  it('shows control when catalog marks supportsThinking even if id heuristic would miss', () => {
    const { container } = render(
      <ThinkingControls
        provider="openrouter"
        model="some-vendor/custom-reasoner-v2"
        modelMeta={{
          id: 'some-vendor/custom-reasoner-v2',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          supportedThinkingEfforts: ['low', 'medium', 'high'],
          thinkingCanDisable: true
        }}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
      />
    )
    expect(container.firstChild).not.toBeNull()
  })

  it('shows Think when catalog supportsThinking is false for known DeepSeek reasoner', () => {
    const model = 'deepseek-ai/DeepSeek-V4-Flash-0731'
    expect(
      modelShowsThinkingControls('custom', model, {
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        supportsThinking: false
      })
    ).toBe(true)

    const { container } = render(
      <ThinkingControls
        provider="custom"
        model={model}
        modelMeta={{
          id: model,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false
        }}
        chatSettings={{ ...chatSettings, provider: 'custom', model }}
        onChatSettingsChange={vi.fn()}
      />
    )
    expect(container.firstChild).not.toBeNull()
    expect(thinkingButton().textContent).toMatch(/Med/)
  })

  it('hides Think when catalog supportsThinking is false for unknown model ids', () => {
    const model = 'some-vendor/plain-chat-v1'
    expect(
      modelShowsThinkingControls('custom', model, {
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        supportsThinking: false
      })
    ).toBe(false)

    const { container } = render(
      <ThinkingControls
        provider="custom"
        model={model}
        modelMeta={{
          id: model,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false
        }}
        chatSettings={{ ...chatSettings, provider: 'custom', model }}
        onChatSettingsChange={vi.fn()}
      />
    )
    expect(container.firstChild).toBeNull()
  })

  it('shows Think when meta arrives via provider::model selection key path', () => {
    // Mirrors ComposerToolbar: modelMetaByValue[modelSelectionKey(provider, model)]
    const model = 'vendor/heuristic-miss-reasoner'
    const key = `openrouter::${model}`
    const modelMetaByValue: Record<string, import('@shared/ipc').ModelInfo> = {
      [key]: {
        id: model,
        inputModalities: ['text'],
        outputModalities: ['text'],
        supportsTools: true,
        supportsVision: false,
        supportsThinking: true,
        supportedThinkingEfforts: ['low', 'medium', 'high'],
        thinkingCanDisable: true
      }
    }
    const modelMeta = modelMetaByValue[key] ?? modelMetaByValue[model]
    const { container } = render(
      <ThinkingControls
        provider="openrouter"
        model={model}
        modelMeta={modelMeta}
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
      />
    )
    expect(container.firstChild).not.toBeNull()
    expect(thinkingButton().textContent).toMatch(/Med/)
  })

  it('hides Off when thinkingCanDisable is false', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="xai"
        model="grok-4.5"
        modelMeta={{
          id: 'grok-4.5',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          supportedThinkingEfforts: ['low', 'medium', 'high'],
          thinkingCanDisable: false,
          thinkingDefaultEffort: 'high'
        }}
        chatSettings={{ ...chatSettings, thinkingEffort: 'high', provider: 'xai', model: 'grok-4.5' }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    fireEvent.click(thinkingButton())
    // Cycles high → low (no Off); first after high in [low, medium, high] wrap is low
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'low'
    })
  })

  it('cycles only catalog-supported efforts', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openrouter"
        model="google/gemini-3-pro"
        modelMeta={{
          id: 'google/gemini-3-pro',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          supportedThinkingEfforts: ['low', 'high']
        }}
        chatSettings={{ ...chatSettings, thinkingEffort: 'low' }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'high'
    })
  })

  it('hides Ollama Think only when catalog confirms supportsThinking false', () => {
    for (const model of ['glm-5.2', 'gemma4:31b-cloud', 'minimax-m2.5:cloud'] as const) {
      expect(
        modelShowsThinkingControls('ollama', model, {
          id: model,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: false
        })
      ).toBe(false)
    }
  })

  it('shows Ollama Think when catalog thinking is unset or meta is missing', () => {
    for (const model of ['glm-5.2', 'gemma4:31b-cloud', 'minimax-m2.5:cloud'] as const) {
      expect(modelShowsThinkingControls('ollama', model)).toBe(true)
      expect(
        modelShowsThinkingControls('ollama', model, {
          id: model,
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false
        })
      ).toBe(true)
    }
  })

  it('shows Off/Low/Med/High/Max for Ollama when catalog returns thinking capabilities', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="ollama"
        model="deepseek-v3.1:671b-cloud"
        modelMeta={{
          id: 'deepseek-v3.1:671b-cloud',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingMode: 'effort',
          thinkingCanDisable: true,
          supportedThinkingEfforts: ['low', 'medium', 'high', 'max'],
          thinkingDefaultEffort: 'medium'
        }}
        chatSettings={{
          ...chatSettings,
          provider: 'ollama',
          model: 'deepseek-v3.1:671b-cloud',
          thinkingEnabled: false
        }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    expect(thinkingButton().textContent).toMatch(/Off/)
    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'low'
    })
  })

  it('cycles Ollama GPT-OSS low/medium/high without Off or max', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="ollama"
        model="gpt-oss:120b-cloud"
        modelMeta={{
          id: 'gpt-oss:120b-cloud',
          inputModalities: ['text'],
          outputModalities: ['text'],
          supportsTools: true,
          supportsVision: false,
          supportsThinking: true,
          thinkingMode: 'effort',
          thinkingCanDisable: false,
          supportedThinkingEfforts: ['low', 'medium', 'high'],
          thinkingDefaultEffort: 'medium'
        }}
        chatSettings={{
          ...chatSettings,
          provider: 'ollama',
          model: 'gpt-oss:120b-cloud',
          thinkingEffort: 'high'
        }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    expect(thinkingButton().textContent).toMatch(/High/)
    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'low'
    })
  })

  it('uses GPT-OSS cannot-disable heuristic before catalog arrives', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="ollama"
        model="gpt-oss:120b-cloud"
        chatSettings={{
          ...chatSettings,
          provider: 'ollama',
          model: 'gpt-oss:120b-cloud',
          thinkingEffort: 'high'
        }}
        onChatSettingsChange={onChatSettingsChange}
      />
    )
    fireEvent.click(thinkingButton())
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'low'
    })
  })

  it('does not clip short Think label with overflow-hidden', () => {
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={chatSettings}
        onChatSettingsChange={vi.fn()}
      />
    )
    const button = thinkingButton()
    expect(button.className).not.toMatch(/\btruncate\b/)
    const label = button.querySelector('span')
    expect(label).toBeTruthy()
    expect(label!.className).not.toMatch(/\btruncate\b/)
    expect(label!.className).toMatch(/leading-tight/)
    expect(button.textContent).toMatch(/Med/)
  })

  it('shows Lower chip on high effort after long-run step threshold', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'high' }}
        onChatSettingsChange={onChatSettingsChange}
        runSteps={10}
      />
    )
    const lower = screen.getByRole('button', { name: /Lower thinking effort to Med/i })
    fireEvent.click(lower)
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'medium'
    })
  })

  it('hides Lower chip below step threshold and for medium effort', () => {
    const { rerender } = render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'high' }}
        onChatSettingsChange={vi.fn()}
        runSteps={9}
      />
    )
    expect(screen.queryByRole('button', { name: /Lower thinking effort/i })).toBeNull()

    rerender(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'medium' }}
        onChatSettingsChange={vi.fn()}
        runSteps={20}
      />
    )
    expect(screen.queryByRole('button', { name: /Lower thinking effort/i })).toBeNull()
  })

  it('dismisses Lower chip without changing settings', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'max' }}
        onChatSettingsChange={onChatSettingsChange}
        runSteps={12}
      />
    )
    fireEvent.click(screen.getByRole('button', { name: /Dismiss lower-thinking suggestion/i }))
    expect(onChatSettingsChange).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: /Lower thinking effort/i })).toBeNull()
  })

  it('allows Lower while running so next message can use queued effort', () => {
    const onChatSettingsChange = vi.fn()
    render(
      <ThinkingControls
        provider="openai"
        model="gpt-5.6"
        chatSettings={{ ...chatSettings, thinkingEffort: 'xhigh' }}
        onChatSettingsChange={onChatSettingsChange}
        running
        runSteps={15}
      />
    )
    expect(screen.getByRole('button', { name: /locked while running/i })).toHaveProperty(
      'disabled',
      true
    )
    fireEvent.click(screen.getByRole('button', { name: /Lower thinking effort to High/i }))
    expect(onChatSettingsChange).toHaveBeenCalledWith({
      thinkingEnabled: true,
      thinkingEffort: 'high'
    })
  })

  describe('OpenCode Go (opencode)', () => {
    // The Go catalog (ids + effort ladders) resolves live from models.dev with a
    // module-level cache that is EMPTY in a fresh vitest process. Seed it before
    // reading seedModelsFor, and build goMeta after seeding — collection-time
    // evaluation would capture an empty model list (documented pitfall; see
    // seedModelsPlaceholder.test.ts / opencodeProvider.test.ts).
    let goMeta: Map<string, ModelInfo>
    beforeAll(async () => {
      await loadOpenCodeGoCatalog()
      goMeta = new Map(seedModelsFor('opencode').map((m) => [m.id, m]))
    }, 30_000)
    const goSettings: EffectiveChatSettings = {
      ...chatSettings,
      provider: 'opencode',
      model: 'longcat-2.0'
    }

    it('shows the toggle for every seeded Go model via catalog meta', () => {
      for (const id of goMeta.keys()) {
        expect(modelShowsThinkingControls('opencode', id, goMeta.get(id)!)).toBe(true)
      }
    })

    it('shows the toggle even while catalog meta is still loading', () => {
      for (const id of goMeta.keys()) {
        expect(modelShowsThinkingControls('opencode', id, null)).toBe(true)
      }
    })

    it('renders the chat-transport ladder Off/Low/Medium/High and wraps high to Off', () => {
      const onChatSettingsChange = vi.fn()
      const meta = goMeta.get('longcat-2.0')
      // medium advances to high…
      render(
        <ThinkingControls
          provider="opencode"
          model="longcat-2.0"
          modelMeta={meta}
          chatSettings={{ ...goSettings, thinkingEnabled: true, thinkingEffort: 'medium' }}
          onChatSettingsChange={onChatSettingsChange}
        />
      )
      fireEvent.click(thinkingButton())
      expect(onChatSettingsChange).toHaveBeenCalledWith({
        thinkingEnabled: true,
        thinkingEffort: 'high'
      })
      cleanup()
      // …and high wraps to Off — no xhigh/max on the chat-completions transport.
      const onWrap = vi.fn()
      render(
        <ThinkingControls
          provider="opencode"
          model="longcat-2.0"
          modelMeta={meta}
          chatSettings={{ ...goSettings, thinkingEnabled: true, thinkingEffort: 'high' }}
          onChatSettingsChange={onWrap}
        />
      )
      fireEvent.click(thinkingButton())
      expect(onWrap).toHaveBeenCalledWith({ thinkingEnabled: false })
    })

    it('renders the messages-transport ladder including max for MiniMax', () => {
      render(
        <ThinkingControls
          provider="opencode"
          model="minimax-m3"
          modelMeta={goMeta.get('minimax-m3')}
          chatSettings={{ ...goSettings, model: 'minimax-m3', thinkingEffort: 'max' }}
          onChatSettingsChange={vi.fn()}
        />
      )
      expect(thinkingButton()).toBeTruthy()
      expect(screen.getByRole('button', { name: /Thinking Max/i })).toBeTruthy()
    })
  })
})
