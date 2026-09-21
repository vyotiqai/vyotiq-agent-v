import { useCallback, useEffect, useMemo, useState } from 'react'
import { Badge, Button, Input, Menu, cn, type MenuOption } from '@renderer/lib/ui'
import { useModelCatalog } from '@renderer/lib/hooks/useModelCatalog'
import { providerLabel, providerOptionsForConfigured } from '@shared/providers'
import type { ProviderId } from '@shared/ipc'

/**
 * The teammate's pinned provider and model.
 *
 * The run loop has honoured this all along — `resolveTurnModel` takes it as
 * `profilePin`, which outranks the renderer's ambient default and loses only
 * to a model the user picks by hand for that run — but nothing could set it.
 *
 * The composer's `ModelPicker` is not reusable here: it needs favourites,
 * recents, seeds, per-model metadata and a service tier, all owned by composer
 * state. This uses the shared seams instead, and offers only providers that
 * actually have a key, because a pin on an unconfigured provider is a run that
 * fails at send.
 */

export type ModelPin = { provider: ProviderId; model: string }

const NO_PIN = '__none__'

/**
 * A half-made pin — a provider chosen, no model id yet — resolved to "no pin".
 *
 * Picking a provider emits `{ provider, model: '' }` so the model menu has
 * something to hang off, and the control says out loud that such a pin is
 * ignored. `AgentProfileModelSchema` disagrees: it requires a non-empty
 * `model`, so sending one fails the entire save on a Zod error rather than
 * being ignored. Every writer runs its draft through this first, so the
 * contract the control advertises is the one the save honours.
 */
export function usablePin(pin: ModelPin | undefined): ModelPin | undefined {
  return pin && pin.model.trim() ? pin : undefined
}

export function TeammateModelPin({
  value,
  onChange,
  secrets,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  disabled
}: {
  value: ModelPin | undefined
  onChange: (next: ModelPin | undefined) => void
  secrets: Record<string, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  disabled?: boolean
}) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)
  const [catalogFailed, setCatalogFailed] = useState(false)

  const providerOptions = useMemo(
    () =>
      providerOptionsForConfigured(secrets, {
        ollamaBaseUrl,
        customOpenAiBaseUrl,
        // A pin already set on a provider whose key has since been removed must
        // stay visible and clearable, not silently disappear from the menu.
        ...(value ? { alwaysInclude: [value.provider] } : {})
      }),
    [secrets, ollamaBaseUrl, customOpenAiBaseUrl, value]
  )

  const configured = useMemo(
    () => new Set(providerOptionsForConfigured(secrets, { ollamaBaseUrl, customOpenAiBaseUrl }).map((o) => o.value)),
    [secrets, ollamaBaseUrl, customOpenAiBaseUrl]
  )
  const pinnedProviderUnconfigured = Boolean(value && !configured.has(value.provider))

  const { refresh } = useModelCatalog(value?.provider ?? 'openai', {
    ollamaBaseUrl,
    customOpenAiBaseUrl
  })

  const loadModels = useCallback(
    async (provider: ProviderId): Promise<void> => {
      setLoading(true)
      setCatalogFailed(false)
      const res = await refresh({ provider, forceRefresh: false })
      setLoading(false)
      if (!res.ok) {
        setModels([])
        setCatalogFailed(true)
        return
      }
      setModels(res.models.map((m) => m.id))
    },
    [refresh]
  )

  // Only fetch once a provider is actually pinned. An unpinned teammate must
  // not cost a provider round-trip every time its detail opens.
  useEffect(() => {
    if (!value?.provider) {
      setModels([])
      setCatalogFailed(false)
      return
    }
    void loadModels(value.provider)
    // loadModels is stable per provider; re-running on every identity change
    // would refetch the catalog on each keystroke elsewhere in the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value?.provider])

  const providerMenuOptions: MenuOption[] = [
    { value: NO_PIN, label: 'No pinned model' },
    ...providerOptions.map((o) => ({ value: o.value, label: o.label }))
  ]

  const modelMenuOptions: MenuOption[] = models.map((id) => ({ value: id, label: id }))
  // A model the catalog does not list — hand-typed, or newly released — still
  // belongs in the menu as the current choice rather than reading as unset.
  if (value?.model && !models.includes(value.model)) {
    modelMenuOptions.unshift({ value: value.model, label: value.model })
  }

  return (
    <div className="flex w-full flex-col items-stretch gap-2">
      <Menu
        value={value?.provider ?? NO_PIN}
        options={providerMenuOptions}
        aria-label="Pinned provider"
        placement="down"
        disabled={disabled}
        onChange={(next) => {
          if (next === NO_PIN) {
            onChange(undefined)
            return
          }
          onChange({ provider: next as ProviderId, model: '' })
        }}
      />

      {value ? (
        <>
          {loading ? (
            <p className="m-0 text-2xs text-muted" role="status">
              Loading models from {providerLabel(value.provider)}…
            </p>
          ) : catalogFailed || modelMenuOptions.length === 0 ? (
            // The catalog is unreachable for plenty of ordinary reasons — an
            // offline machine, a local server that is not running. Typing the
            // id still produces a valid pin, so do not dead-end here.
            <Input
              value={value.model}
              placeholder="Model id"
              aria-label="Pinned model"
              disabled={disabled}
              onChange={(e) => onChange({ provider: value.provider, model: e.target.value })}
            />
          ) : (
            <Menu
              value={value.model}
              options={modelMenuOptions}
              aria-label="Pinned model"
              placement="down"
              searchable
              disabled={disabled}
              onChange={(next) => onChange({ provider: value.provider, model: next })}
            />
          )}

          {pinnedProviderUnconfigured ? (
            <div className={cn('flex flex-wrap items-center justify-end gap-2')}>
              <Badge tone="warning">{providerLabel(value.provider)} has no key</Badge>
              <Button variant="subtle" onClick={() => onChange(undefined)} disabled={disabled}>
                Clear pin
              </Button>
            </div>
          ) : null}

          {!value.model && !loading ? (
            <p className="m-0 text-2xs text-warning" role="status">
              Pick a model, or the pin is ignored.
            </p>
          ) : null}
        </>
      ) : null}
    </div>
  )
}
