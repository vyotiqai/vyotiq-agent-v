import { useCallback, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import type {
  AgentInteractionMode,
  ModelInfo,
  ProviderId,
  SecretProvider,
  ServiceTier,
  ThinkingEffort
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { providerLabel, providerNeedsKey } from '@shared/domain/providers'
import { modelSelectionKey, parseModelSelectionKey } from '@shared/domain/modelSelection'
import { resolveModelContextWindow } from '@shared/domain/modelContextWindows'
import { SERVICE_TIER_DESCRIPTIONS, SERVICE_TIER_LABELS } from '@shared/domain/serviceTier'
import { resolveModelPrice } from '@shared/pricing/modelPrices'
import { alignContextUsageToModelWindow } from '@shared/utils/contextUsage'
import { nextLowerThinkingEffort, shouldSuggestLowerThinkingEffort } from '@shared/utils/tokenCost'
import { Icon, type IconName } from '@renderer/lib/icons'
import { Button, IconButton, MENU_SURFACE, Ring, Segmented, cn } from '@renderer/lib/ui'
import { useDropdownMenu } from '@renderer/lib/hooks/useDropdownMenu'
import { formatTokens } from '@renderer/lib/utils/formatTokens'
import type { ChatMetaStore } from '../../chatStores'
import { ContextMeterPanel, contextMeterLabels, usageMetrics, type ContextUsageState } from './ContextMeter'
import { MODES, nextMode, useCycleModeShortcut } from './ModePicker'
import { ProviderLogo } from './ProviderLogo'
import { clampComposerDropdownPanel } from './composerDropdownLayout'
import { formatModelDisplayName, supportedTiersForModel, type ModelPickerOption } from './composerModelUtils'
import { buildModes, modeIndex, modelShowsThinkingControls, resolveThinkingUiMeta } from './ThinkingControls'
import { useResolvedContextUsage, useResolvedCostHint } from './useContextUsage'

const PANEL_MAX_PX = 560

export type TaskOptionsProps = {
  provider: ProviderId
  model: string
  providers: ProviderId[]
  optionsByProvider: Record<ProviderId, ModelPickerOption[]>
  seedsByProvider: Record<ProviderId, ModelPickerOption[]>
  modelMetaByValue: Record<string, ModelInfo>
  warningsByProvider: Partial<Record<ProviderId, string | null>>
  favoriteModels: string[]
  recentModels: string[]
  serviceTier: ServiceTier
  /** Which providers hold a key — a keyless provider reads "local" or "no key". */
  secrets: Record<SecretProvider, boolean>
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  onModelChange: (provider: ProviderId, model: string) => void
  onToggleFavorite: (provider: ProviderId, model: string) => void
  onServiceTierChange: (tier: ServiceTier) => void
  /** Refetches the browsed provider's catalog. */
  onRefreshCatalog: () => void
  onBrowseProvider: (provider: ProviderId) => void
  catalogLoading?: boolean
  agentMode: AgentInteractionMode
  onAgentModeChange: (mode: AgentInteractionMode) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: (focus?: string) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  /** Opens Settings → Providers. */
  onAddProvider?: () => void
  running: boolean
  disabled?: boolean
  focusInput?: () => void
  /**
   * `token`: mode · model · effort on the instruction line (the default).
   * `model`: the model's name as a select, for the New task brief, opening
   * below it.
   */
  trigger?: 'token' | 'model'
}

type Row = { provider: ProviderId; opt: ModelPickerOption; manual?: boolean }

export function capabilities(meta?: ModelInfo): Array<{ icon: IconName; label: string }> {
  if (!meta) return []
  const out: Array<{ icon: IconName; label: string }> = []
  if (meta.supportsThinking) out.push({ icon: 'memory', label: 'Thinks' })
  if (meta.supportsVision || meta.inputModalities.includes('image')) out.push({ icon: 'eye', label: 'Sees images' })
  if (meta.supportsTools) out.push({ icon: 'tool', label: 'Uses tools' })
  if (meta.inputModalities.includes('audio')) out.push({ icon: 'speaker', label: 'Hears audio' })
  return out
}

/** Published input price per million tokens, when the price table knows the model. */
function inputPrice(provider: ProviderId, model: string): string {
  const resolved = resolveModelPrice(provider, model)
  if (!resolved) return ''
  const n = resolved.price.input
  return n === 0 ? 'free' : `$${n.toFixed(2)}`
}

/**
 * Mode, model and effort as one quiet token on the instruction line, led by
 * the share of the context this task has used. One popover sets all three;
 * the context breakdown and Compact open from its foot.
 */
export function TaskOptions(props: TaskOptionsProps) {
  const {
    provider,
    model,
    providers,
    optionsByProvider,
    seedsByProvider,
    modelMetaByValue,
    favoriteModels,
    recentModels,
    agentMode,
    chatSettings,
    running,
    onBrowseProvider,
    onAgentModeChange,
    onModelChange,
    focusInput
  } = props
  const locked = Boolean(props.disabled)
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<'models' | 'context'>('models')
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<ProviderId>(provider)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [dismissedLowerKey, setDismissedLowerKey] = useState<string | null>(null)
  const [compacting, setCompacting] = useState(false)
  const [compactMessage, setCompactMessage] = useState<string | null>(null)
  const [compactFailed, setCompactFailed] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()
  const listId = useId()

  const onOpenChange = useCallback(
    (next: boolean) => {
      setOpen(next)
      if (next) {
        setView('models')
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
    placement: props.trigger === 'model' ? 'down' : 'up',
    align: props.trigger === 'model' ? 'start' : 'end',
    disabled: locked,
    trapFocus: true,
    autoFocusFirst: true
  })

  const advanceMode = useCallback(
    (reverse: boolean) => onAgentModeChange(nextMode(agentMode, reverse)),
    [agentMode, onAgentModeChange]
  )
  useCycleModeShortcut(rootRef, locked, advanceMode)

  // ── What is selected ──────────────────────────────────────────────────
  const selectedKey = modelSelectionKey(provider, model)
  const meta = modelMetaByValue[selectedKey] ?? modelMetaByValue[model]
  const modelName =
    optionsByProvider[provider]?.find((o) => o.value === selectedKey)?.label ?? formatModelDisplayName(model)
  const thinkingUi = resolveThinkingUiMeta(provider, model, meta)
  const effortModes = buildModes(
    thinkingUi.supportedThinkingEfforts,
    thinkingUi.thinkingCanDisable,
    thinkingUi.thinkingMode,
    thinkingUi.thinkingDefaultEffort
  )
  const showsEffort = modelShowsThinkingControls(provider, model, meta)
  const effortAt = modeIndex(effortModes, chatSettings.thinkingEnabled, chatSettings.thinkingEffort)
  const effort = showsEffort ? effortModes[effortAt] : undefined
  const tiers = supportedTiersForModel(provider, model, meta)
  const modeLabel = MODES.find((m) => m.value === agentMode)?.label ?? agentMode
  const label = [modeLabel, modelName, effort?.short].filter(Boolean).join(' · ')

  // ── Context used by this task ─────────────────────────────────────────
  const usage = useResolvedContextUsage(props.metaStore, props.contextUsage)
  const advisoryHint = useResolvedCostHint(props.metaStore, null)
  const modelWindow = resolveModelContextWindow({ id: model, contextWindow: meta?.contextWindow }, provider) ?? null
  const aligned = usage && modelWindow && modelWindow > 0 ? alignContextUsageToModelWindow(usage, modelWindow) : usage
  const ctx = aligned && aligned.window > 0 ? usageMetrics(aligned) : null

  // ── A long run at high effort: offer one step down, never apply it ────
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

  // ── Rows for the model table ──────────────────────────────────────────
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
      // A host without a model list (Custom) takes a typed id as the model.
      if (tab === 'custom') {
        const id = query.trim()
        const exists = hits.some(
          (h) => h.opt.value.toLowerCase() === id.toLowerCase() || h.opt.label.toLowerCase() === id.toLowerCase()
        )
        if (!exists) {
          hits.push({ provider: 'custom', opt: { value: modelSelectionKey('custom', id), label: `Use "${id}"` }, manual: true })
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

  const noteFor = (p: ProviderId): string | null => {
    if (props.secrets[p as SecretProvider]) return null
    const baseUrl = p === 'ollama' ? props.ollamaBaseUrl : p === 'custom' ? props.customOpenAiBaseUrl : undefined
    return providerNeedsKey(p, baseUrl) ? 'no key' : 'local'
  }

  const browse = (p: ProviderId): void => {
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

  const runCompaction = async (): Promise<void> => {
    if (!props.onCompactContext || compacting || running) return
    setCompacting(true)
    setCompactMessage(null)
    setCompactFailed(false)
    try {
      const result = await props.onCompactContext()
      setCompactMessage(result.message)
      setCompactFailed(!result.ok)
    } finally {
      setCompacting(false)
    }
  }

  const emptyText = catalogEmptyText({
    loading: props.catalogLoading,
    searching: Boolean(query.trim()),
    warning: browsedWarning,
    custom: tab === 'custom',
    noProviders: providers.length === 0
  })

  const layout =
    open && position
      ? clampComposerDropdownPanel({
          position: {
            left: props.trigger === 'model' ? position.left : position.left - PANEL_MAX_PX,
            top: position.top,
            placement: position.placement
          },
          maxWidthPx: PANEL_MAX_PX,
          minHeightPx: 240
        })
      : null

  const panel =
    open && position && layout ? (
      <div
        ref={panelRef}
        id={panelId}
        role="dialog"
        aria-label="Mode, model and effort"
        data-task-options-panel
        className={cn('fixed flex flex-col', position.placement === 'up' ? 'origin-bottom' : 'origin-top', MENU_SURFACE)}
        style={{
          top: position.placement === 'up' ? undefined : position.top,
          bottom: position.placement === 'up' ? window.innerHeight - position.top : undefined,
          left: layout.left,
          width: layout.width,
          maxHeight: layout.maxHeight
        }}
      >
        {view === 'context' && aligned ? (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-2">
              <IconButton icon="arrowLeft" label="Back to models" size="sm" tone="muted" onClick={() => setView('models')} />
              <span className="text-sm font-medium text-fg-strong">Context</span>
            </div>
            <div className="flex min-h-0 flex-1 flex-col">
              <ContextMeterPanel
                usage={aligned}
                onCompact={props.onCompactContext ? () => void runCompaction() : undefined}
                compacting={compacting}
                compactDisabled={running}
                compactMessage={compactMessage}
                compactFailed={compactFailed}
                advisoryHint={advisoryHint}
              />
            </div>
          </>
        ) : (
          <>
            <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
              <Icon name="search" size={15} className="shrink-0 text-muted" />
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
              <div className="scroll-thin w-44 shrink-0 space-y-px overflow-y-auto border-r border-border p-1.5">
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
                        on ? 'bg-surface-2 text-fg-strong' : 'text-secondary hover:bg-surface'
                      )}
                    >
                      <ProviderLogo id={p} size="sm" className="shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{providerLabel(p)}</span>
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
                    className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
                  >
                    <Icon name="plus" size={13} />
                    Add a provider
                  </button>
                ) : null}
              </div>
              <div className="scroll-thin min-w-0 flex-1 overflow-y-auto p-1.5">
                <div className="flex h-7 items-center gap-3 px-2 text-caption text-tertiary" aria-hidden="true">
                  <span className="flex-1">Model</span>
                  <span className="w-16">Can</span>
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
          </>
        )}
        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-3 py-2.5">
          <span className="text-xs text-muted">Mode</span>
          <Segmented
            label="Mode"
            value={agentMode}
            items={MODES.map((m) => ({ id: m.value, label: m.label }))}
            onChange={onAgentModeChange}
            disabled={locked}
          />
          {showsEffort ? (
            <>
              <span className="text-xs text-muted">Effort</span>
              <Segmented
                label="Effort"
                value={String(effortAt)}
                items={effortModes.map((m, i) => ({ id: String(i), label: m.short, title: m.label }))}
                onChange={(id) => {
                  const next = effortModes[Number(id)]
                  if (!next) return
                  props.onChatSettingsChange(
                    next.enabled ? { thinkingEnabled: true, thinkingEffort: next.effort } : { thinkingEnabled: false }
                  )
                }}
                disabled={locked}
              />
            </>
          ) : null}
          {tiers.length > 0 ? (
            <>
              <span className="text-xs text-muted">Speed</span>
              <Segmented
                label="Speed"
                value={props.serviceTier}
                items={tiers.map((t) => ({ id: t, label: SERVICE_TIER_LABELS[t], title: SERVICE_TIER_DESCRIPTIONS[t] }))}
                onChange={props.onServiceTierChange}
                disabled={locked}
              />
            </>
          ) : null}
          {ctx && aligned && view === 'models' ? (
            <button
              type="button"
              onClick={() => setView('context')}
              aria-label={contextMeterLabels(aligned, advisoryHint).aria}
              title={contextMeterLabels(aligned, advisoryHint).title}
              data-context-meter
              className="ml-auto inline-flex h-7 items-center gap-1.5 rounded-md px-1.5 text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
            >
              <Ring value={ctx.ratio} size={12} stroke={1.75} />
              <span className="font-mono tnum">{ctx.displayPct}%</span>
              context
              <Icon name="chevronRight" size={10} className="text-tertiary" />
            </button>
          ) : null}
        </div>
        {lower && effort ? (
          <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2 text-caption text-muted" role="status">
            <Icon name="arrowDown" size={12} className="shrink-0" />
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

  if (props.trigger === 'model') {
    return (
      <div ref={rootRef} className="flex min-w-0 shrink items-center">
        <button
          ref={triggerRef}
          type="button"
          disabled={locked}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          aria-label={`Model: ${modelName}`}
          data-task-options
          onClick={() => setOpen((v) => !v)}
          className="inline-flex h-8 w-60 min-w-0 items-center gap-2 rounded-md border border-border bg-bg px-2.5 font-mono text-xs text-fg vy-transition hover:border-border-strong focus-visible:vy-focus-ring disabled:vy-disabled-state"
        >
          <span className="min-w-0 flex-1 truncate text-left">{modelName}</span>
          <Icon name="chevron" size={10} className="shrink-0 text-tertiary" />
        </button>
        {panel ? createPortal(panel, document.body) : null}
      </div>
    )
  }

  return (
    <div ref={rootRef} className="flex min-w-0 shrink items-center">
      <button
        ref={triggerRef}
        type="button"
        disabled={locked}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={
          ctx ? `Mode, model and effort · ${ctx.displayPct}% of the context used by this task` : 'Mode, model and effort'
        }
        data-task-options
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-md px-1.5 text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring disabled:vy-disabled-state"
      >
        {ctx ? (
          <>
            <Ring value={ctx.ratio} size={12} stroke={1.75} />
            <span className="font-mono tnum">{ctx.displayPct}%</span>
            <span className="sr-only">of the context used,</span>
            <span aria-hidden="true" className="text-tertiary">
              ·
            </span>
          </>
        ) : null}
        <span className="min-w-0 truncate">{label}</span>
        <Icon name="chevron" size={10} className="shrink-0 text-tertiary" />
      </button>
      {panel ? createPortal(panel, document.body) : null}
    </div>
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
        'group flex h-8 cursor-pointer items-center gap-3 rounded-md px-2',
        selected ? 'bg-accent-soft' : active ? 'bg-surface' : 'hover:bg-surface'
      )}
    >
      {showProvider && !row.manual ? (
        <ProviderLogo id={row.provider} subProvider={row.opt.subProvider} size="sm" className="shrink-0" />
      ) : null}
      <span
        className={cn('min-w-0 flex-1 truncate font-mono text-xs', selected ? 'text-fg-strong' : 'text-fg')}
        title={row.opt.label !== modelId ? `${row.opt.label} · ${modelId}` : modelId}
      >
        {row.manual ? row.opt.label : modelId}
      </span>
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
      <span className="flex w-16 shrink-0 gap-1 text-tertiary">
        {capabilities(meta).map((c) => (
          <span key={c.icon} title={c.label}>
            <Icon name={c.icon} size={12} />
            <span className="sr-only">{c.label}</span>
          </span>
        ))}
      </span>
      <span className="w-10 shrink-0 text-right font-mono text-caption text-muted tnum">
        {meta?.contextWindow ? formatTokens(meta.contextWindow) : ''}
      </span>
      <span className="w-12 shrink-0 text-right font-mono text-caption text-muted tnum">
        {parsed && !row.manual ? inputPrice(parsed.provider, parsed.model) : ''}
      </span>
    </div>
  )
}
