import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  catalogProviderId,
  type ModelInfo,
  type ProviderIdAny,
  type SecretProvider,
  type ServiceTier,
  type ThinkingEffort
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { providerLabel, providerNeedsKey } from '@shared/domain/providers'
import { modelSelectionKey, parseModelSelectionKey } from '@shared/domain/modelSelection'
import { SERVICE_TIER_DESCRIPTIONS, SERVICE_TIER_LABELS } from '@shared/domain/serviceTier'
import { resolveModelPrice } from '@shared/pricing/modelPrices'
import { nextLowerThinkingEffort, shouldSuggestLowerThinkingEffort } from '@shared/utils/tokenCost'
import { Icon } from '@renderer/lib/icons'
import {
  Button,
  IconButton,
  MENU_ROW,
  MENU_ROW_ACTIVE,
  MENU_ROW_IDLE,
  MENU_ROW_SELECTED,
  MENU_ROW_TEXT,
  MENU_SURFACE,
  Segmented,
  cn
} from '@renderer/lib/ui'
import { ROW_HOVER, SELECTED } from '@renderer/lib/utils/layout'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { useCustomProviders } from '@renderer/lib/hooks/customProvidersStore'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import type { ChatMetaStore } from '../../chatStores'
import type { ContextUsageState } from './ContextMeter'
import { ProviderLogo } from './ProviderLogo'
import { clampComposerDropdownPanel } from './composerDropdownLayout'
import { formatModelDisplayName, supportedTiersForModel, type ModelPickerOption } from './composerModelUtils'
import {
  buildModes,
  modeIndex,
  modelShowsThinkingControls,
  resolveThinkingUiMeta
} from './ThinkingControls'
import { effortFootNote, effortNotes } from './effortCost'
import { useResolvedContextUsage } from './useContextUsage'

const PANEL_MAX_PX = 520

export type ModelPickerProps = {
  provider: ProviderIdAny
  model: string
  providers: ProviderIdAny[]
  optionsByProvider: Record<ProviderIdAny, ModelPickerOption[]>
  seedsByProvider: Record<ProviderIdAny, ModelPickerOption[]>
  modelMetaByValue: Record<string, ModelInfo>
  warningsByProvider: Partial<Record<ProviderIdAny, string | null>>
  favoriteModels: string[]
  recentModels: string[]
  serviceTier: ServiceTier
  /** Which providers hold a key — a keyless provider reads "local" or "no key". */
  secrets: Record<SecretProvider, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  onModelChange: (provider: ProviderIdAny, model: string) => void
  onToggleFavorite: (provider: ProviderIdAny, model: string) => void
  onServiceTierChange: (tier: ServiceTier) => void
  /** Refetches the browsed provider's catalog. */
  onRefreshCatalog: () => void
  onBrowseProvider: (provider: ProviderIdAny) => void
  catalogLoading?: boolean
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  /** The task's usage — a long run at high effort is offered one step down. */
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  /** Opens Settings → Providers. */
  onAddProvider?: () => void
  running: boolean
  disabled?: boolean
  focusInput?: () => void
  /** Up from a line at the pane's foot; down from the New task box at the page's top. */
  placement?: 'up' | 'down'
}

type Row = { provider: ProviderIdAny; opt: ModelPickerOption; manual?: boolean }

/** What a model can do, in words — for a hover title, never a row of glyphs. */
function capabilityWords(meta?: ModelInfo): string[] {
  if (!meta) return []
  const out: string[] = []
  if (meta.supportsThinking) out.push('thinks')
  if (meta.supportsVision || meta.inputModalities.includes('image')) out.push('sees images')
  if (meta.supportsTools) out.push('uses tools')
  if (meta.inputModalities.includes('audio')) out.push('hears audio')
  return out
}

/** Published input price per million tokens, when the price table knows the model. */
function inputPrice(provider: ProviderIdAny, model: string): string {
  const resolved = resolveModelPrice(provider, model)
  if (!resolved) return ''
  const n = resolved.price.input
  return n === 0 ? 'free' : `$${n.toFixed(2)}`
}

/** The model and its effort, for the trigger and the popover's foot. */
function useModelSummary(p: Pick<ModelPickerProps, 'provider' | 'model' | 'optionsByProvider' | 'modelMetaByValue' | 'chatSettings'>) {
  const selectedKey = modelSelectionKey(p.provider, p.model)
  const meta = p.modelMetaByValue[selectedKey] ?? p.modelMetaByValue[p.model]
  const modelName =
    p.optionsByProvider[p.provider]?.find((o) => o.value === selectedKey)?.label ?? formatModelDisplayName(p.model)
  const thinkingUi = resolveThinkingUiMeta(p.provider, p.model, meta)
  const effortModes = buildModes(
    thinkingUi.supportedThinkingEfforts,
    thinkingUi.thinkingCanDisable,
    thinkingUi.thinkingMode,
    thinkingUi.thinkingDefaultEffort
  )
  const showsEffort = modelShowsThinkingControls(p.provider, p.model, meta)
  const effortAt = modeIndex(effortModes, p.chatSettings.thinkingEnabled, p.chatSettings.thinkingEffort)
  const effort = showsEffort ? effortModes[effortAt] : undefined
  return { selectedKey, meta, modelName, thinkingUi, effortModes, showsEffort, effortAt, effort }
}

/**
 * The model and how hard it thinks: one quiet trigger in the composer's
 * control row ("qwen2.5 · High"). Its popover searches every provider, and
 * sets effort and speed for the model picked — the settings that belong to a
 * model sit with it. Mode and the context reading have their own controls.
 */
export function ModelPicker(props: ModelPickerProps) {
  const { provider, model, providers, optionsByProvider, seedsByProvider, modelMetaByValue, favoriteModels, recentModels } =
    props
  const { running, onBrowseProvider, onModelChange, focusInput } = props
  const locked = Boolean(props.disabled)
  const placement = props.placement ?? 'up'
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<ProviderIdAny>(provider)
  const customProviders = useCustomProviders()
  const [activeIndex, setActiveIndex] = useState(-1)
  const [dismissedLowerKey, setDismissedLowerKey] = useState<string | null>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const listId = useId()

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) {
        setQuery('')
        setActiveIndex(-1)
        setTab(provider)
        onBrowseProvider(provider)
      }
    },
    [provider, onBrowseProvider]
  )
  const { position, close } = useDropdownMenu({
    open,
    onOpenChange,
    triggerRef,
    panelRef,
    placement,
    align: 'start',
    disabled: locked,
    trapFocus: true,
    autoFocusFirst: true
  })

  const { selectedKey, meta, modelName, thinkingUi, effortModes, showsEffort, effortAt, effort } = useModelSummary(props)
  const tiers = supportedTiersForModel(provider, model, meta)
  // What each effort costs, said before it is picked: on the level's hover, and under the levels for the one set.
  const effortNoteList = effortNotes(effortModes, {
    provider,
    model,
    meta,
    onOffOnly: thinkingUi.thinkingMode === 'boolean'
  })

  // ── A long run at high effort: offer one step down, never apply it ────
  const usage = useResolvedContextUsage(props.metaStore, props.contextUsage)
  const runSteps = usage?.stepUsage?.steps ?? 0
  const lowerTarget =
    effort?.enabled && effort.effort
      ? (nextLowerThinkingEffort(effort.effort, thinkingUi.supportedThinkingEfforts) as ThinkingEffort | null)
      : null
  const lowerKey = effort?.enabled ? `${provider}:${model}:${effort.effort}` : null
  const lower =
    lowerTarget &&
    lowerKey !== dismissedLowerKey &&
    shouldSuggestLowerThinkingEffort({
      thinkingEnabled: Boolean(effort?.enabled),
      thinkingEffort: effort?.effort,
      steps: runSteps,
      thinkingMode: thinkingUi.thinkingMode
    })
      ? (effortModes.find((m) => m.enabled && m.effort === lowerTarget) ?? null)
      : null

  // ── Rows for the model list ───────────────────────────────────────────
  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    if (q) {
      // A model's own id or name wins; its group (the provider, or an
      // OpenRouter vendor) only answers when nothing matches directly — so
      // "llama" finds llama models, not every model an Ollama host serves,
      // and "anthropic" still finds Anthropic's.
      const direct: Row[] = []
      const byGroup: Row[] = []
      for (const p of providers) {
        for (const opt of optionsByProvider[p] ?? []) {
          const id = parseModelSelectionKey(opt.value)?.model ?? opt.value
          if (opt.label.toLowerCase().includes(q) || id.toLowerCase().includes(q)) direct.push({ provider: p, opt })
          else if (opt.group?.toLowerCase().includes(q)) byGroup.push({ provider: p, opt })
        }
      }
      const hits = direct.length > 0 ? direct : byGroup
      // A host without a model list (Custom, or an endpoint the user added)
      // takes a typed id as the model.
      if (catalogProviderId(tab) === 'custom') {
        const id = query.trim()
        const exists = hits.some(
          (h) => h.opt.value.toLowerCase() === id.toLowerCase() || h.opt.label.toLowerCase() === id.toLowerCase()
        )
        if (!exists) {
          hits.push({ provider: tab, opt: { value: modelSelectionKey(tab, id), label: `Use "${id}"` }, manual: true })
        }
      }
      return hits
    }
    // Favorites, then recent, then the provider's recommended models, then the rest.
    const base = optionsByProvider[tab] ?? []
    const byKey = new Map(base.map((o) => [o.value, o]))
    const seen = new Set<string>()
    const ordered: ModelPickerOption[] = []
    const take = (o: ModelPickerOption | undefined): void => {
      if (!o || seen.has(o.value)) return
      seen.add(o.value)
      ordered.push(o)
    }
    favoriteModels.forEach((k) => take(byKey.get(k)))
    recentModels.forEach((k) => take(byKey.get(k)))
    const seedIds = new Set((seedsByProvider[tab] ?? []).map((o) => o.value))
    base.filter((o) => seedIds.has(o.value)).forEach(take)
    base.forEach(take)
    return ordered.map((opt) => ({ provider: tab, opt }))
  }, [query, providers, optionsByProvider, tab, favoriteModels, recentModels, seedsByProvider])

  const browsedWarning = query.trim() ? null : (props.warningsByProvider[tab] ?? null)

  const noteFor = (p: ProviderIdAny): string | null => {
    if (props.secrets[p as SecretProvider]) return null
    const baseUrl =
      p === 'ollama'
        ? props.ollamaBaseUrl
        : p === 'custom'
          ? props.customOpenAiBaseUrl
          : customProviders.find((entry) => entry.id === p)?.baseUrl
    return providerNeedsKey(p, baseUrl) ? 'no key' : 'local'
  }

  const browse = (p: ProviderIdAny): void => {
    setQuery('')
    setActiveIndex(-1)
    setTab(p)
    onBrowseProvider(p)
  }

  const pick = (row: Row): void => {
    const parsed = parseModelSelectionKey(row.opt.value)
    if (!parsed) return
    onModelChange(parsed.provider, parsed.model)
    close(false)
    window.setTimeout(() => focusInput?.(), 0)
  }

  const onSearchKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (i < 0 ? 0 : (i + 1) % rows.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (rows.length) setActiveIndex((i) => (i <= 0 ? rows.length - 1 : i - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const row = rows[activeIndex]
      if (row) pick(row)
    }
  }

  const emptyText = catalogEmptyText({
    loading: props.catalogLoading,
    searching: Boolean(query.trim()),
    warning: browsedWarning,
    custom: catalogProviderId(tab) === 'custom',
    noProviders: providers.length === 0
  })

  const layout =
    open && position
      ? clampComposerDropdownPanel({
          position: { left: position.left, top: position.top, placement: position.placement },
          maxWidthPx: PANEL_MAX_PX,
          minHeightPx: 240
        })
      : null

  const hasFoot = showsEffort || tiers.length > 0

  const panel =
    open && position && layout ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Model and effort"
        data-model-picker-panel
        className={cn('fixed flex flex-col', position.placement === 'up' ? 'origin-bottom' : 'origin-top', MENU_SURFACE)}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: layout.left,
          width: layout.width,
          maxHeight: layout.maxHeight
        }}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pl-3 pr-2">
          <Icon name="search" size={14} className="shrink-0 text-muted" />
          <input
            role="combobox"
            aria-label="Search models"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={activeIndex >= 0 && rows[activeIndex] ? `${listId}-${activeIndex}` : undefined}
            placeholder="Search every provider"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
              setActiveIndex(e.target.value.trim() ? 0 : -1)
            }}
            onKeyDown={onSearchKeyDown}
            className="min-w-0 flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-tertiary"
          />
          <IconButton
            icon="retry"
            label={props.catalogLoading ? 'Refreshing the catalog…' : 'Refresh the catalog'}
            size="sm"
            tone="muted"
            disabled={props.catalogLoading}
            onClick={props.onRefreshCatalog}
          />
        </div>
        {browsedWarning ? (
          <p className="m-0 shrink-0 border-b border-border px-3 py-1.5 text-caption text-muted">{browsedWarning}</p>
        ) : null}
        <div className="flex h-[300px] min-h-0 shrink">
          <div className="scroll-thin w-40 shrink-0 space-y-px overflow-y-auto border-r border-border p-1.5">
            {providers.map((p) => {
              const on = !query.trim() && p === tab
              const note = noteFor(p)
              return (
                <button
                  key={p}
                  type="button"
                  aria-pressed={on}
                  onClick={() => browse(p)}
                  className={cn(
                    'flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm vy-transition focus-visible:vy-focus-ring',
                    on ? SELECTED : cn('text-secondary', ROW_HOVER)
                  )}
                >
                  <ProviderLogo id={p} size="sm" className="shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{providerLabel(p, customProviders)}</span>
                  {note ? <span className="shrink-0 text-caption text-tertiary">{note}</span> : null}
                </button>
              )
            })}
            {props.onAddProvider ? (
              <button
                type="button"
                onClick={() => {
                  close(false)
                  props.onAddProvider?.()
                }}
                className="flex h-8 w-full items-center rounded-md px-2 text-left text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
              >
                Add a provider…
              </button>
            ) : null}
          </div>
          <div className="scroll-thin min-w-0 flex-1 overflow-y-auto p-1.5">
            <div className="flex h-7 items-center gap-2 px-2 text-caption text-tertiary" aria-hidden="true">
              <span className="flex-1">Model</span>
              <span className="w-10 text-right">Context</span>
              <span className="w-12 text-right">$/M in</span>
            </div>
            <div id={listId} role="listbox" aria-label="Models">
              {rows.length === 0 ? (
                <p className="m-0 px-2 py-6 text-center text-xs text-tertiary" role="status">
                  {emptyText}
                </p>
              ) : null}
              {rows.map((row, i) => (
                <ModelRow
                  key={row.opt.value}
                  id={`${listId}-${i}`}
                  row={row}
                  selected={row.opt.value === selectedKey}
                  active={i === activeIndex}
                  favorite={favoriteModels.includes(row.opt.value)}
                  showProvider={Boolean(query.trim())}
                  onPick={() => pick(row)}
                  onHover={() => setActiveIndex(i)}
                  onToggleFavorite={() => {
                    const parsed = parseModelSelectionKey(row.opt.value)
                    if (parsed) props.onToggleFavorite(parsed.provider, parsed.model)
                  }}
                  modelMetaByValue={modelMetaByValue}
                />
              ))}
            </div>
          </div>
        </div>
        {hasFoot ? (
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-3 py-2.5">
            {showsEffort ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs text-muted">Effort</span>
                <Segmented
                  label="Effort"
                  value={String(effortAt)}
                  items={effortModes.map((m, i) => {
                    const note = effortNoteList[i]
                    return { id: String(i), label: m.short, title: note ? `${m.label}: ${note}` : m.label }
                  })}
                  onChange={(id) => {
                    const next = effortModes[Number(id)]
                    if (!next) return
                    props.onChatSettingsChange(
                      next.enabled ? { thinkingEnabled: true, thinkingEffort: next.effort } : { thinkingEnabled: false }
                    )
                  }}
                  disabled={locked}
                />
              </span>
            ) : null}
            {tiers.length > 0 ? (
              <span className="inline-flex items-center gap-2">
                <span className="text-xs text-muted">Speed</span>
                <Segmented
                  label="Speed"
                  value={props.serviceTier}
                  items={tiers.map((t) => ({ id: t, label: SERVICE_TIER_LABELS[t], title: SERVICE_TIER_DESCRIPTIONS[t] }))}
                  onChange={props.onServiceTierChange}
                  disabled={locked}
                />
              </span>
            ) : null}
            {effort ? (
              <p className="m-0 w-full text-caption text-tertiary" data-effort-note>
                {effortNoteList[effortAt] ? `${effort.label}: ${effortNoteList[effortAt]}.` : null}
                {effortNoteList[effortAt] && effort.enabled ? ' ' : null}
                {effort.enabled ? effortFootNote(provider, model) : null}
              </p>
            ) : null}
          </div>
        ) : null}
        {lower && effort ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted" role="status">
            <span className="min-w-0 flex-1">
              {runSteps} steps at {effort.label} — {lower.label} spends fewer reasoning tokens on each one.
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={locked}
              onClick={() => {
                if (lower.enabled) props.onChatSettingsChange({ thinkingEnabled: true, thinkingEffort: lower.effort })
              }}
            >
              Use {lower.short}
            </Button>
            <IconButton icon="close" label="Dismiss" size="xs" tone="muted" onClick={() => setDismissedLowerKey(lowerKey)} />
          </div>
        ) : null}
        {running ? (
          <p className="m-0 shrink-0 border-t border-border px-3 py-2 text-caption text-tertiary">
            Changes apply from your next instruction — this run keeps its settings.
          </p>
        ) : null}
      </div>
    ) : null

  const provName = providerLabel(provider, customProviders)
  const can = capabilityWords(meta)
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={locked}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-label={`Model: ${modelName}${effort ? `, ${effort.label} effort` : ''}`}
        title={[`${provName} · ${modelName}`, ...can].join(' · ')}
        data-model-picker
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex h-7 min-w-0 shrink items-center gap-1.5 rounded-md px-2 text-xs vy-transition focus-visible:vy-focus-ring disabled:vy-disabled-state',
          open ? 'bg-surface text-fg' : 'text-secondary hover:bg-surface hover:text-fg'
        )}
      >
        <span className="min-w-0 truncate">{modelName}</span>
        {effort ? <span className="shrink-0 text-tertiary @max-[320px]:hidden">· {effort.short}</span> : null}
        <Icon name="chevron" size={10} className="shrink-0 text-tertiary" />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </>
  )
}

function catalogEmptyText(s: {
  loading?: boolean
  searching: boolean
  warning: string | null
  custom: boolean
  noProviders: boolean
}): string {
  if (s.noProviders) return 'No providers yet — add one to pick a model.'
  if (s.loading) return 'Loading models…'
  if (s.searching) return 'No models match.'
  if (s.warning) {
    return s.custom ? 'No live models. Type a model id above to use it.' : 'No live models. Fix the issue above or refresh.'
  }
  return 'This provider lists no models.'
}

function ModelRow({
  id,
  row,
  selected,
  active,
  favorite,
  showProvider,
  onPick,
  onHover,
  onToggleFavorite,
  modelMetaByValue
}: {
  id: string
  row: Row
  selected: boolean
  active: boolean
  favorite: boolean
  showProvider: boolean
  onPick: () => void
  onHover: () => void
  onToggleFavorite: () => void
  modelMetaByValue: Record<string, ModelInfo>
}) {
  const parsed = parseModelSelectionKey(row.opt.value)
  const modelId = parsed?.model ?? row.opt.value
  const meta = row.opt.meta ?? modelMetaByValue[row.opt.value]
  const title = [row.opt.label !== modelId ? `${row.opt.label} · ${modelId}` : modelId, ...capabilityWords(meta)].join(
    ' · '
  )
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      tabIndex={-1}
      data-model-row={row.opt.value}
      onClick={onPick}
      onMouseEnter={onHover}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onPick()
        }
      }}
      className={cn(
        MENU_ROW,
        'group',
        active ? MENU_ROW_ACTIVE : MENU_ROW_IDLE,
        selected ? MENU_ROW_SELECTED : MENU_ROW_TEXT
      )}
    >
      {showProvider && !row.manual ? (
        <ProviderLogo id={row.provider} subProvider={row.opt.subProvider} size="sm" className="shrink-0" />
      ) : null}
      <span
        className={cn('min-w-0 flex-1 truncate font-mono text-xs', selected ? 'text-fg-strong' : 'text-fg')}
        title={title}
      >
        {row.manual ? row.opt.label : modelId}
        {capabilityWords(meta).length > 0 ? <span className="sr-only">{`, ${capabilityWords(meta).join(', ')}`}</span> : null}
      </span>
      {selected ? <Icon name="check" size={12} className="shrink-0 text-fg-strong" /> : null}
      {row.manual ? null : (
        <button
          type="button"
          aria-label={favorite ? `Remove ${modelId} from favourites` : `Add ${modelId} to favourites`}
          aria-pressed={favorite}
          onMouseDown={(e) => e.preventDefault()}
          onClick={(e) => {
            e.stopPropagation()
            onToggleFavorite()
          }}
          className={cn(
            'inline-grid size-5 shrink-0 place-items-center rounded text-muted vy-transition hover:text-fg focus-visible:vy-focus-ring',
            favorite ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
          )}
        >
          <Icon name="star" size={12} weight={favorite ? 'fill' : 'regular'} />
        </button>
      )}
      <span className="w-10 shrink-0 text-right font-mono text-caption text-muted tnum">
        {meta?.contextWindow ? formatTokens(meta.contextWindow) : ''}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-caption text-muted tnum">
        {parsed && !row.manual ? inputPrice(parsed.provider, parsed.model) : ''}
      </span>
    </div>
  )
}
