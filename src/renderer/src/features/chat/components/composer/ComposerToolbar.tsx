import { useCallback, useSyncExternalStore } from 'react'
import { Icon } from '@renderer/lib/icons'
import { Tooltip, cn } from '@renderer/lib/ui'
import { shortcutLabel } from '@renderer/lib/shortcuts'
import type { DictationWaveformStyle, ProviderId, ServiceTier } from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { resolveModelContextWindow } from '@shared/domain/modelContextWindows'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import { ContextMeter, type ContextUsageState } from './ContextMeter'
import { ComposerPlusButton } from './ComposerPlusButton'
import { ModelPicker } from './ModelPicker'
import { ModePicker } from './ModePicker'
import { ThinkingControls } from './ThinkingControls'
import { chromeIconButton, chromeLabelText } from './composerChrome'
import { Waveform, formatElapsed } from './DictationSessionStrip'
import type { DictationPhase } from './useComposerDictation'
import type { ModelPickerOption } from './composerModelUtils'
import type { ModelInfo } from '@shared/ipc'
import type { AgentInteractionMode } from '@shared/ipc'
import type { ChatMetaStore } from '../../chatStores'

function ThinkingControlsWithSteps({
  metaStore,
  usage,
  provider,
  model,
  modelMeta,
  chatSettings,
  onChatSettingsChange,
  disabled,
  running,
  className
}: {
  metaStore?: ChatMetaStore
  usage?: ContextUsageState | null
  provider: ProviderId
  model: string
  modelMeta?: ModelInfo | null
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  disabled?: boolean
  running?: boolean
  className?: string
}) {
  const resolved = useResolvedContextUsage(metaStore, usage)
  const runSteps = resolved?.stepUsage?.steps ?? 0
  return (
    <ThinkingControls
      provider={provider}
      model={model}
      modelMeta={modelMeta}
      chatSettings={chatSettings}
      onChatSettingsChange={onChatSettingsChange}
      disabled={disabled}
      running={running}
      runSteps={runSteps}
      className={className}
    />
  )
}

function useResolvedContextUsage(
  metaStore: ChatMetaStore | undefined,
  usage: ContextUsageState | null | undefined
): ContextUsageState | null {
  const subscribe = useCallback(
    (onStoreChange: () => void) => metaStore?.subscribeMeta(onStoreChange) ?? (() => {}),
    [metaStore]
  )
  const getRevision = useCallback(() => metaStore?.getMetaRevision() ?? 0, [metaStore])
  useSyncExternalStore(subscribe, getRevision, getRevision)
  return metaStore ? metaStore.getContextUsage() : (usage ?? null)
}

function useResolvedCostHint(
  metaStore: ChatMetaStore | undefined,
  costHint: string | null | undefined
): string | null {
  const subscribe = metaStore?.subscribeMeta ?? (() => () => {})
  const getRevision = metaStore?.getMetaRevision ?? (() => 0)
  useSyncExternalStore(subscribe, getRevision, getRevision)
  if (metaStore?.getCostHint) return metaStore.getCostHint()
  return costHint ?? null
}

function ContextMeterLeaf({
  metaStore,
  usage,
  modelWindow,
  onCompact,
  compactDisabled
}: {
  metaStore?: ChatMetaStore
  usage?: ContextUsageState | null
  modelWindow?: number | null
  onCompact?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  compactDisabled?: boolean
}) {
  const resolved = useResolvedContextUsage(metaStore, usage)
  const advisoryHint = useResolvedCostHint(metaStore, null)
  return (
    <ContextMeter
      usage={resolved}
      modelWindow={modelWindow}
      onCompact={onCompact}
      compactDisabled={compactDisabled}
      advisoryHint={advisoryHint}
    />
  )
}

const iconCtl = chromeIconButton

/** 32px primary composer action — Send / Stop / dictation confirm. */
const chromePrimaryButton =
  'inline-grid size-8 shrink-0 place-items-center rounded-md border-0 vy-transition disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'

/** Accent fill for the primary action — one filled control per state. */
const primaryAccent = 'bg-accent text-accent-fg hover:bg-fg-strong'

/** Muted variant — Send rendered disabled with a reason. */
const primaryMuted = 'cursor-not-allowed bg-surface-2 text-muted'

/** Size to content; truncate only when the middle zone is constrained. */
const modelPillTrigger = cn(
  'inline-flex h-7 max-w-full min-w-0 items-center gap-1.5 rounded-md border-0 bg-transparent px-1',
  chromeLabelText,
  'text-fg hover:bg-surface active:bg-surface',
  'vy-transition disabled:cursor-not-allowed disabled:opacity-[var(--vy-disabled-opacity)]'
)

/** Leading cluster root — attach, mode, and model pills sit before the input. */
const toolsRow = 'flex h-8 min-w-0 items-center gap-1 overflow-hidden'

/** Trailing action row — Think, context meter, Send/Stop. */
const toolbarRow = 'flex h-8 min-w-0 shrink-0 items-center gap-2'

/** Leading cluster — attach, mode, and model pills, placed before the input. */
export function ComposerToolbarTools({
  locked,
  attachDisabled,
  attachFull,
  attachHint,
  onAttach,
  providers,
  optionsByProvider,
  seedsByProvider,
  modelMetaByValue,
  provider,
  model,
  favoriteModels,
  recentModels,
  warningsByProvider,
  serviceTier,
  onModelChange,
  onToggleFavorite,
  onServiceTierChange,
  onRefreshCatalog,
  onBrowseProvider,
  catalogLoading,
  onModelPickerOpenChange,
  agentMode,
  onAgentModeChange,
  running,
  focusInput
}: {
  locked: boolean
  attachDisabled?: boolean
  attachFull?: boolean
  attachHint?: string | null
  onAttach: () => void
  providers: ProviderId[]
  optionsByProvider: Record<ProviderId, ModelPickerOption[]>
  seedsByProvider: Record<ProviderId, ModelPickerOption[]>
  modelMetaByValue: Record<string, ModelInfo>
  provider: ProviderId
  model: string
  favoriteModels: string[]
  recentModels: string[]
  warningsByProvider: Partial<Record<ProviderId, string | null>>
  serviceTier: ServiceTier
  onModelChange: (provider: ProviderId, model: string) => void
  onToggleFavorite: (provider: ProviderId, model: string) => void
  onServiceTierChange: (tier: ServiceTier) => void
  onRefreshCatalog: () => void
  onBrowseProvider?: (provider: ProviderId) => void
  catalogLoading?: boolean
  onModelPickerOpenChange?: (open: boolean) => void
  agentMode: AgentInteractionMode
  onAgentModeChange: (mode: AgentInteractionMode) => void
  running: boolean
  focusInput?: () => void
}) {
  return (
    <div className={toolsRow} data-composer-toolbar-tools>
      <ComposerPlusButton
        disabled={attachDisabled}
        attachFull={attachFull}
        attachHint={attachHint}
        onAttach={onAttach}
      />
      <ModePicker
        mode={agentMode}
        onModeChange={onAgentModeChange}
        disabled={locked}
        running={running}
        className="shrink-0"
      />
      <ModelPicker
        className="min-w-0 max-w-[6rem] @min-[380px]:max-w-[8rem] @min-[480px]:max-w-[12rem] @min-[640px]:max-w-[14rem]"
        triggerClassName={modelPillTrigger}
        providers={providers}
        optionsByProvider={optionsByProvider}
        seedsByProvider={seedsByProvider}
        modelMetaByValue={modelMetaByValue}
        provider={provider}
        model={model}
        favoriteModels={favoriteModels}
        recentModels={recentModels}
        warningsByProvider={warningsByProvider}
        serviceTier={serviceTier}
        onModelChange={onModelChange}
        onToggleFavorite={onToggleFavorite}
        onServiceTierChange={onServiceTierChange}
        onRefreshCatalog={onRefreshCatalog}
        onBrowseProvider={onBrowseProvider}
        catalogLoading={catalogLoading}
        disabled={locked}
        focusInput={focusInput}
        onOpenChange={onModelPickerOpenChange}
      />
    </div>
  )
}

export type ComposerVariant = 'hero' | 'dock' | 'inline'

function dictationMicLabel(phase: DictationPhase): string {
  switch (phase) {
    case 'idle':
      return 'Dictate'
    case 'checking':
      return 'Starting dictation'
    case 'recording':
      return 'Stop dictation'
    case 'transcribing':
      return 'Transcribing'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

function dictationMicTooltip(phase: DictationPhase, engineHint: string | null | undefined): string {
  switch (phase) {
    case 'idle': {
      const chord = `Dictate (${shortcutLabel('dictation')})`
      return engineHint ? `${chord} · ${engineHint}` : chord
    }
    case 'checking':
      return 'Starting…'
    case 'recording':
      return 'Stop dictation and transcribe'
    case 'transcribing':
      return 'Transcribing…'
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

/** Tooltip for the single adaptive action while a dictation session is live. */
function dictationActiveTooltip(phase: DictationPhase): string {
  switch (phase) {
    case 'checking':
      return 'Starting dictation…'
    case 'recording':
      return 'Stop dictation and transcribe'
    case 'transcribing':
      return 'Transcribing…'
    default:
      return 'Stop dictation and transcribe'
  }
}

function dictationActiveLabel(phase: DictationPhase): string {
  switch (phase) {
    case 'checking':
      return 'Starting dictation'
    case 'recording':
      return 'Stop dictation'
    case 'transcribing':
      return 'Transcribing'
    default:
      return 'Stop dictation'
  }
}

function dictationActiveStatusLabel(phase: DictationPhase): string {
  switch (phase) {
    case 'checking':
      return 'Starting dictation'
    case 'recording':
      return 'Listening'
    case 'transcribing':
      return 'Transcribing'
    default:
      return 'Listening'
  }
}

function dictationSessionKind(
  phase: DictationPhase
): 'checking' | 'listening' | 'transcribing' | null {
  switch (phase) {
    case 'checking':
      return 'checking'
    case 'recording':
      return 'listening'
    case 'transcribing':
      return 'transcribing'
    default:
      return null
  }
}

function composerToolbarKind(variant: ComposerVariant): 'inline' | 'standard' {
  switch (variant) {
    case 'inline':
      return 'inline'
    case 'hero':
    case 'dock':
      return 'standard'
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

/** Trailing actions cluster — Think, context meter, dictation state, Send/Stop. */
export function ComposerToolbar({
  variant,
  disabled,
  className,
  modelMetaByValue,
  provider,
  model,
  chatSettings,
  onChatSettingsChange,
  running,
  canSend,
  hasContent,
  sendDisabledReason,
  onStop,
  contextUsage,
  metaStore,
  onCompactContext,
  onCancelEdit,
  dictationPhase = 'idle',
  dictationEngineHint = null,
  onDictationToggle,
  dictationWaveform,
  dictationElapsedMs = 0,
  dictationWaveformStyle = 'bars',
  onDictationCancel
}: {
  variant: ComposerVariant
  disabled?: boolean
  /** Row-fit override — the dock passes `flex-1` while a dictation session replaces the input. */
  className?: string
  modelMetaByValue: Record<string, ModelInfo>
  provider: ProviderId
  model: string
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  running: boolean
  canSend: boolean
  hasContent: boolean
  sendDisabledReason?: string | null
  onStop: () => void
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  onCancelEdit?: () => void
  dictationPhase?: DictationPhase
  dictationEngineHint?: string | null
  onDictationToggle?: () => void
  dictationWaveform?: readonly number[]
  dictationElapsedMs?: number
  dictationWaveformStyle?: DictationWaveformStyle
  onDictationCancel?: () => void
}) {
  const isInline = composerToolbarKind(variant) === 'inline'

  const modelMeta =
    modelMetaByValue[modelSelectionKey(provider, model)] ?? modelMetaByValue[model]
  const modelWindow =
    resolveModelContextWindow(
      { id: model, contextWindow: modelMeta?.contextWindow },
      provider
    ) ?? null

  const sendTooltip = running
    ? `Stop (${shortcutLabel('stop')})`
    : !canSend
      ? (sendDisabledReason ??
        (isInline ? 'Enter a replacement message to resend.' : 'Type a message or attach a file to send.'))
      : isInline
        ? 'Resend edited message'
        : 'Send (Enter)'

  // One merged primary action shared by every composer state:
  //   running            → Stop the run
  //   dictation live     → Stop dictation and transcribe
  //   has content        → Send
  //   locked/blocked     → muted Send (disabled)
  //   idle + empty       → Dictate (mic)
  // The mic itself never disappears: whenever it is not the primary action it stays
  // mounted beside Send/Stop so dictation can keep appending to an existing draft.
  const dictationLive =
    dictationPhase === 'checking' ||
    dictationPhase === 'recording' ||
    dictationPhase === 'transcribing'
  const dictationBusy = dictationPhase === 'checking' || dictationPhase === 'transcribing'
  // Dictate is reachable whenever it is enabled and we are not already dictating —
  // including mid-run, so a follow-up can be composed while the agent runs.
  const dictationAllowed = !!onDictationToggle && !disabled && !dictationLive
  // Empty idle draft: the mic IS the primary action. Once the draft has any content,
  // Send takes the primary slot and the mic moves beside it instead of disappearing.
  const micIsPrimary = dictationAllowed && !running && !hasContent
  // Single-accent invariant: exactly one filled control per state. When the mic
  // is not the primary action it drops to quiet chrome beside Send/Stop.
  const micButton = (
    <Tooltip content={dictationMicTooltip(dictationPhase, dictationEngineHint)}>
      <button
        type="button"
        className={micIsPrimary ? cn(chromePrimaryButton, primaryAccent) : iconCtl}
        aria-label={dictationMicLabel(dictationPhase)}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDictationToggle}
      >
        <Icon name="mic" size={16} weight="bold" />
      </button>
    </Tooltip>
  )
  const primaryAction = running ? (
    <Tooltip content={sendTooltip}>
      <button
        type="button"
        className={cn(chromePrimaryButton, primaryAccent)}
        aria-label="Stop"
        onClick={onStop}
      >
        <Icon name="stop" size={16} weight="fill" />
      </button>
    </Tooltip>
  ) : dictationLive ? (
    <Tooltip content={dictationActiveTooltip(dictationPhase)}>
      <button
        type="button"
        className={cn(chromePrimaryButton, primaryAccent)}
        aria-label={dictationActiveLabel(dictationPhase)}
        aria-pressed={dictationPhase === 'recording'}
        aria-busy={dictationBusy || undefined}
        disabled={dictationBusy}
        onMouseDown={(e) => e.preventDefault()}
        onClick={onDictationToggle}
      >
        <Icon
          name={dictationBusy ? 'loader' : 'stop'}
          size={16}
          weight={dictationBusy ? undefined : 'fill'}
          className={dictationBusy ? 'motion-safe:animate-spin' : undefined}
        />
      </button>
    </Tooltip>
  ) : canSend ? (
    <Tooltip content={sendTooltip}>
      <button
        type="submit"
        className={cn(chromePrimaryButton, primaryAccent)}
        aria-label={isInline ? 'Resend' : 'Send'}
        onMouseDown={(event) => event.preventDefault()}
      >
        <Icon name="send" size={16} weight="fill" />
      </button>
    </Tooltip>
  ) : micIsPrimary ? (
    micButton
  ) : (
    <Tooltip content={sendTooltip}>
      <button
        type="submit"
        className={cn(chromePrimaryButton, primaryMuted)}
        aria-label={isInline ? 'Resend' : 'Send'}
        aria-disabled="true"
        title={sendTooltip}
        onClick={(event) => event.preventDefault()}
      >
        <Icon name="send" size={16} weight="fill" />
      </button>
    </Tooltip>
  )

  // The mic stays mounted beside Send/Stop whenever it is not the primary action,
  // so dictation can keep appending to an existing draft (or a mid-run follow-up).
  const dictateButton = dictationAllowed && !micIsPrimary ? micButton : null

  const sendOrStop = (
    <div className="flex items-center gap-1">
      {isInline && onCancelEdit ? (
        <Tooltip content="Cancel edit (Esc)">
          <button
            type="button"
            className={iconCtl}
            aria-label="Cancel edit"
            onClick={onCancelEdit}
          >
            <Icon name="close" size={16} />
          </button>
        </Tooltip>
      ) : null}
      {dictationLive && onDictationCancel ? (
        <Tooltip content="Cancel dictation">
          <button
            type="button"
            className={iconCtl}
            aria-label="Cancel dictation"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onDictationCancel}
          >
            <Icon name="close" size={16} />
          </button>
        </Tooltip>
      ) : null}
      {dictateButton}
      {primaryAction}
    </div>
  )

  const dictationKind = dictationSessionKind(dictationPhase)

  return (
    <div
      className={cn(toolbarRow, className)}
      data-composer-toolbar
      data-dictation-session={dictationKind ?? undefined}
      aria-busy={dictationBusy || undefined}
    >
      {dictationLive ? (
        <div
          className="flex h-8 min-w-0 flex-1 items-center gap-1.5"
          role="status"
          aria-live="polite"
          aria-label={dictationActiveStatusLabel(dictationPhase)}
          data-dictation-session={dictationKind ?? undefined}
        >
          <Waveform samples={dictationWaveform ?? []} style={dictationWaveformStyle} />
          <span
            className={cn(chromeLabelText, 'shrink-0 tabular-nums text-muted')}
            aria-hidden="true"
          >
            {formatElapsed(dictationElapsedMs)}
          </span>
        </div>
      ) : null}
      {!dictationLive && (
        <div className="hidden min-w-0 shrink-0 @min-[300px]:block">
          <ThinkingControlsWithSteps
            metaStore={metaStore}
            usage={contextUsage}
            provider={provider}
            model={model}
            modelMeta={modelMeta}
            chatSettings={chatSettings}
            onChatSettingsChange={onChatSettingsChange}
            disabled={disabled}
            running={running}
            className="shrink-0"
          />
        </div>
      )}
      <ContextMeterLeaf
        metaStore={metaStore}
        usage={contextUsage}
        modelWindow={modelWindow}
        onCompact={onCompactContext}
        compactDisabled={running}
      />
      {sendOrStop}
    </div>
  )
}
