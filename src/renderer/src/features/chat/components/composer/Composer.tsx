import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent
} from 'react'
import type {
  AgentInteractionMode,
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ComposerSendExtras,
  ProviderId,
  SecretProvider,
  ServiceTier,
  SlashCommandDescriptor
} from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { resolveSlashCommandForSubmit } from '@shared/slashCommands'
import { isRetryableTurnFailure } from '@shared/errors'
import { Alert, Button, IconButton, cn, pushToast } from '@renderer/lib/ui'
import {
  draftTitle,
  saveTaskDraftFor,
  setBriefChecks,
  setBriefState,
  useBriefState
} from '@renderer/lib/drafts/taskDraftStore'
import { Icon } from '@renderer/lib/icons'
import { isSessionDragEvent } from '@renderer/lib/chat/chatPaneLayout'
import {
  CHAT_COLUMN,
  CHAT_GUTTER,
  COMPOSER_DOCK_COVER,
  COMPOSER_DOCK_RESERVE_VAR,
  COMPOSER_FLOAT_BODY,
  COMPOSER_FLOAT_DOCK,
  FLOATING_CHROME
} from '@renderer/lib/utils/layout'
import { ComposerMentionInput, type ComposerMentionInputHandle } from './ComposerMentionInput'
import { ComposerToolbar, ComposerToolbarTools, type ComposerVariant } from './ComposerToolbar'
import { ComposerAttachments } from './ComposerAttachments'
import {
  DictationErrorBanner,
  Waveform,
  formatElapsed,
  type DictationSettingsSection,
  type DictationStripState
} from './DictationSessionStrip'
import { TaskOptions } from './TaskOptions'
import { useComposerDraft } from './useComposerDraft'
import { hasComposerContent } from './mentionModel'
import { useComposerImages, MAX_IMAGES } from './useComposerImages'
import { useComposerFiles, ATTACHMENT_ACCEPT, MAX_FILES, isImageFile } from './useComposerFiles'
import { useComposerAudio, isAudioFile, MAX_AUDIO_FILES } from './useComposerAudio'
import { useComposerDictation, type DictationPhase } from './useComposerDictation'
import { useComposerModels } from './useComposerModels'
import { deriveModelReadiness, modelReadinessBlocksSend, modelReadinessSendReason } from './modelReadiness'
import { ModelReadinessBanner } from './ModelReadinessBanner'
import { pickAudioFallback, pickVisionFallback } from './composerModelUtils'
import {
  getWorkspaceHotUi,
  resolveHotComposerDraft,
  setWorkspaceHotComposerDraft,
  useWorkspaceHotComposerDraft
} from '@renderer/lib/hooks/workspaceHotUiStore'
import { clearComposerAttachments, composerAttachmentKey } from '@renderer/lib/hooks/composerAttachmentStore'
import { SlashCommandMenu } from './SlashCommandMenu'
import { NewTaskBrief, type NewTaskTargets } from '@renderer/features/task/NewTaskBrief'
import { useSlashCommands } from './useSlashCommands'
import { MentionMenu } from './MentionMenu'
import { useComposerMentions } from './useComposerMentions'
import { resolveComposerMentions } from './resolveMentions'
import { mentionMarker, type MentionMenuItem } from './mentionModel'
import {
  executeSlashResolveResult,
  type SlashClientHandlers
} from './slashCommandExecute'
import { resolveComposerPlaceholder, resolveLinePlaceholder } from './composerPlaceholder'
import { filesFromDataTransfer } from './dataTransferFiles'
import { focusComposerMessage, isMainComposerTarget, shortcutLabel } from '@renderer/lib/shortcuts'

const COMPOSER_FORM_LAYOUT = '@container relative flex flex-col gap-1.5 px-3 py-2'

function composerLayoutKind(variant: ComposerVariant): ComposerVariant {
  switch (variant) {
    case 'hero':
    case 'dock':
    case 'inline':
    case 'line':
    case 'brief':
      return variant
    default: {
      const _exhaustive: never = variant
      return _exhaustive
    }
  }
}

function resolveDictationStripState(d: {
  phase: DictationPhase
  error: string | null
  errorAction: DictationSettingsSection | null
  elapsedMs: number
  waveform: readonly number[]
}): DictationStripState | null {
  switch (d.phase) {
    case 'checking':
      return { kind: 'checking', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'recording':
      return { kind: 'listening', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'transcribing':
      return { kind: 'transcribing', elapsedMs: d.elapsedMs, waveform: d.waveform }
    case 'idle':
      return d.error
        ? { kind: 'error', message: d.error, settingsSection: d.errorAction }
        : null
    default: {
      const _exhaustive: never = d.phase
      return _exhaustive
    }
  }
}

/**
 * The instruction line's mic: its name says what pressing it does in each
 * dictation phase; the tooltip adds the chord and the engine.
 */
function lineMic(phase: DictationPhase, engineHint: string | null): { label: string; tip: string } {
  switch (phase) {
    case 'idle': {
      const chord = `Dictate (${shortcutLabel('dictation')})`
      return { label: 'Dictate', tip: engineHint ? `${chord} · ${engineHint}` : chord }
    }
    case 'checking':
      return { label: 'Starting dictation', tip: 'Starting dictation…' }
    case 'recording':
      return { label: 'Stop dictation', tip: 'Stop dictation and transcribe' }
    case 'transcribing':
      return { label: 'Transcribing', tip: 'Transcribing…' }
    default: {
      const _exhaustive: never = phase
      return _exhaustive
    }
  }
}

function notifyMcpUnavailable(
  command: SlashCommandDescriptor,
  handlers?: SlashClientHandlers
): void {
  const notice = command.description?.includes(' — ')
    ? command.description.split(' — ').slice(1).join(' — ')
    : command.availability === 'needs_auth'
      ? 'MCP server needs authentication — open Extensions to connect.'
      : 'MCP server not connected — open Extensions to reconnect.'
  handlers?.onNotice?.(notice)
  handlers?.onOpenMarketplace?.(command.mcpServerId)
}

export function Composer({
  provider,
  model,
  running,
  disabled,
  hasWorkspace,
  hasTranscript,
  ollamaBaseUrl,
  customOpenAiBaseUrl,
  modelsRefreshKey,
  secrets,
  draft,
  onDraftChange,
  workspacePath,
  onProviderModel,
  favoriteModels = [],
  recentModels = [],
  serviceTier = 'default',
  onToggleFavorite = () => {},
  onServiceTierChange = () => {},
  chatSettings,
  onChatSettingsChange,
  agentMode = 'agent',
  onAgentModeChange = () => {},
  agentProfileId = null,
  onAgentProfileChange = () => {},
  onSend,
  onStop,
  pendingFollowUps = [],
  onRemoveFollowUp,
  onEditFollowUp,
  onSendFollowUpNow,
  composerPlaceholder,
  bannerError,
  secondaryBannerError,
  errorCode,
  onRetryNetwork,
  incomplete,
  activeRunId,
  contextUsage,
  metaStore,
  onCompactContext,
  onDismissError,
  trailing,
  variant = 'dock',
  className,
  slashHandlers,
  seedImages,
  seedFiles,
  seedAudio,
  seedNativeFiles,
  onCancelEdit,
  onFocus,
  onEditLastUserMessage,
  runCount = 0,
  newTaskTargets,
  briefHeaderActions,
  taskFiles
}: {
  provider: ProviderId
  model: string
  running: boolean
  disabled?: boolean
  hasWorkspace?: boolean
  hasTranscript?: boolean
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<SecretProvider, boolean>
  draft?: string
  onDraftChange?: (draft: string) => void
  /** When set, draft is read from the hot UI store (avoids App re-renders on keystrokes). */
  workspacePath?: string | null
  onProviderModel: (provider: ProviderId, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: ServiceTier
  onToggleFavorite?: (provider: ProviderId, model: string) => void
  onServiceTierChange?: (tier: ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void
  agentProfileId?: string | null
  onAgentProfileChange?: (profileId: string | null) => void
  onSend: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: import('@shared/ipc').ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  pendingFollowUps?: import('@renderer/lib/hooks/createChatStreamController').PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  composerPlaceholder?: string
  bannerError?: string | null
  secondaryBannerError?: string | null
  errorCode?: string | null
  onRetryNetwork?: () => void
  incomplete?: import('@renderer/lib/hooks/createChatStreamController').IncompleteTurnState | null
  activeRunId?: string | null
  contextUsage?: import('./ContextMeter').ContextUsageState | null
  /** Prefer over contextUsage prop so meter patches do not re-render Composer. */
  metaStore?: import('../../chatStores').ChatMetaStore
  onCompactContext?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  onDismissError?: () => void
  /** Optional docked chrome below the shell. */
  trailing?: React.ReactNode
  variant?: ComposerVariant
  className?: string
  slashHandlers?: SlashClientHandlers
  /** One-shot attachment seed when mounting an inline edit composer. */
  seedImages?: string[]
  seedFiles?: AttachedFile[]
  seedAudio?: AttachedAudio[]
  seedNativeFiles?: AttachedNativeFile[]
  /** Escape / cancel while editing a prompt bubble. */
  onCancelEdit?: () => void
  onFocus?: () => void
  /** Dock and line: ArrowUp on empty draft or caret at start edits the last user prompt. */
  onEditLastUserMessage?: () => boolean
  /** Line only: runs the task has had — the placeholder names the next one. */
  runCount?: number
  /** Brief only: the workspaces a new task can move to. */
  newTaskTargets?: NewTaskTargets
  /** Brief only: the pane's controls, at the end of its header. */
  briefHeaderActions?: React.ReactNode
  /** Files this task read or edited, most recent first — the @ menu's recent files. */
  taskFiles?: readonly string[]
}) {
  const taRef = useRef<ComposerMentionInputHandle>(null)
  const focusInput = useCallback(() => taRef.current?.focus(), [])
  /** The New task brief's done-when checks, kept current while the brief is up. */
  const briefChecksRef = useRef<string[]>([])
  // Once the task has started the checks are its own; later sends carry none.
  useEffect(() => {
    if (variant !== 'brief') briefChecksRef.current = []
  }, [variant])
  const mentionAnchorRef = useRef<HTMLDivElement | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const workspacePathRef = useRef(workspacePath)
  workspacePathRef.current = workspacePath
  const inputLocked = Boolean(disabled)
  // Settings apply to the next invocation, so remain editable while a run is active.
  const settingsLocked = Boolean(disabled)
  const runIdForDraft = activeRunId ?? null
  const hotDraft = useWorkspaceHotComposerDraft(workspacePath, runIdForDraft)
  // Inline edit keeps its own draft. Dock uses per-run hot UI when a workspace is bound.
  const useHotComposerDraft =
    variant !== 'inline' && Boolean(workspacePath)
  const resolvedDraft = useHotComposerDraft ? hotDraft : (draft ?? '')

  // On workspace/run switch, seed hot draft from the controlled prop so remounts and
  // pane focus never show a stale sibling-run draft (or empty hot while prop has text).
  const seedKeyRef = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (variant === 'inline' || !workspacePath || draft === undefined) {
      return
    }
    const seedKey = `${workspacePath}::${runIdForDraft ?? ''}`
    if (seedKeyRef.current === seedKey) return
    seedKeyRef.current = seedKey
    const hot = getWorkspaceHotUi(workspacePath)
    const current = resolveHotComposerDraft(hot, runIdForDraft)
    if (current === draft) return
    // Prop may lag setContexts; never wipe a newer non-empty hot draft with ''.
    if (draft === '' && current !== '') return
    setWorkspaceHotComposerDraft(workspacePath, runIdForDraft, draft)
  }, [variant, workspacePath, runIdForDraft, draft])

  const [cursor, setCursor] = useState(0)
  const cursorRef = useRef(0)
  cursorRef.current = cursor
  const [editingFollowUpId, setEditingFollowUpId] = useState<string | null>(null)
  const [editingFollowUpText, setEditingFollowUpText] = useState('')
  const followUpEditRef = useRef<HTMLTextAreaElement>(null)

  // Entering edit mode moves focus into the textarea so typing works immediately.
  useEffect(() => {
    if (editingFollowUpId == null) return
    const el = followUpEditRef.current
    if (!el) return
    el.focus()
    el.setSelectionRange(el.value.length, el.value.length)
  }, [editingFollowUpId])

  const syncCursor = useCallback((): void => {
    const handle = taRef.current
    if (handle) setCursor(handle.getSelectionStart())
  }, [])

  // Dock attachments survive remounts per workspace+run (same keying as hot drafts).
  const attachmentKey =
    variant === 'inline' ? null : composerAttachmentKey(workspacePath, runIdForDraft)

  const {
    images,
    setImages,
    imageError,
    setImageError,
    onPickImages,
    removeImage
  } = useComposerImages(attachmentKey)

  const preferNativePdfRef = useRef(false)

  const {
    files,
    setFiles,
    nativeFiles,
    setNativeFiles,
    fileError,
    setFileError,
    extracting,
    addFiles,
    removeFile,
    removeNativeFile
  } = useComposerFiles({
    getPreferNativePdf: () => preferNativePdfRef.current,
    persistKey: attachmentKey
  })

  const { audio, setAudio, audioError, addAudio, removeAudio } = useComposerAudio(attachmentKey)

  // New task: its checks and the draft it continues live per workspace, so
  // leaving the page keeps them and a start made elsewhere can empty them.
  const briefWorkspace = variant === 'brief' ? (workspacePath ?? null) : null
  const briefState = useBriefState(briefWorkspace)
  const briefDraftIdRef = useRef(briefState.draftId)
  briefDraftIdRef.current = briefState.draftId
  const [savingDraft, setSavingDraft] = useState(false)
  /** Bumped after a save empties the page, so a half-typed check goes too. */
  const [briefClearToken, setBriefClearToken] = useState(0)

  const seededRef = useRef(false)
  useEffect(() => {
    if (seededRef.current) return
    seededRef.current = true
    if (seedImages?.length) setImages(seedImages.slice(0, MAX_IMAGES))
    if (seedFiles?.length) setFiles(seedFiles.slice(0, MAX_FILES))
    if (seedAudio?.length) setAudio(seedAudio)
    if (seedNativeFiles?.length) setNativeFiles(seedNativeFiles)
  }, [seedImages, seedFiles, seedAudio, seedNativeFiles, setImages, setFiles, setAudio, setNativeFiles])

  const slash = useSlashCommands({
    workspacePath,
    text: resolvedDraft,
    cursor,
    enabled: !inputLocked && Boolean(hasWorkspace),
    onListError: slashHandlers?.onNotice
  })

  const mentions = useComposerMentions({
    workspacePath,
    text: resolvedDraft,
    cursor,
    enabled: !inputLocked && Boolean(hasWorkspace) && !slash.open,
    taskFiles
  })

  const onMentionAccept = useCallback(
    (item: MentionMenuItem) => {
      const result = mentions.acceptItem(item)
      if (!result) return
      if (result.action === 'navigate') {
        mentions.setView(result.view)
        return
      }
      if (result.action === 'show-more') {
        mentions.showMore()
        return
      }
      onDraftChange?.(result.nextText)
      setCursor(result.nextCursor)
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(result.nextCursor)
        taRef.current?.focus()
      })
      mentions.dismiss()
    },
    [mentions, onDraftChange]
  )

  const sendWithMentions = useCallback(
    async (
      rawText: string,
      sendImages?: string[],
      sendFiles?: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean | void> => {
      try {
        // The brief's checks ride with the first send only.
        if (briefChecksRef.current.length > 0) {
          extras = { ...(extras ?? {}), doneWhen: briefChecksRef.current }
        }
        // Starting from a draft spends it: main removes it once the task exists.
        if (variant === 'brief' && briefDraftIdRef.current) {
          extras = { ...(extras ?? {}), draftId: briefDraftIdRef.current }
        }
        const boundWorkspace = workspacePath
        const resolved = await resolveComposerMentions({
          workspacePath: boundWorkspace,
          draft: rawText,
          existingFiles: sendFiles ?? [],
          existingImages: sendImages ?? [],
          runId: activeRunId ?? null,
          isCurrent: () => workspacePathRef.current === boundWorkspace
        })
        if (resolved.stale || workspacePathRef.current !== boundWorkspace) {
          return false
        }
        if (resolved.error) {
          setFileError(resolved.error)
          return false
        }
        const hasExtras = Boolean(extras?.audio?.length || extras?.nativeFiles?.length)
        if (
          !resolved.text.trim() &&
          !resolved.files.length &&
          !resolved.images.length &&
          !hasExtras
        ) {
          return false
        }
        const sent = await onSend(
          resolved.text,
          resolved.images.length ? resolved.images : undefined,
          resolved.files.length ? resolved.files : undefined,
          extras
        )
        // The task exists: the page starts over empty next time.
        if (sent !== false && variant === 'brief' && boundWorkspace) setBriefState(boundWorkspace, null)
        return sent
      } catch (err) {
        setFileError(err instanceof Error ? err.message : 'Send failed')
        return false
      }
    },
    [workspacePath, activeRunId, onSend, setFileError, variant]
  )

  const resolveSlashSubmitCommand = useCallback(
    async (triggerOrId: string): Promise<SlashCommandDescriptor | null> => {
      const commands = await slash.ensureCommands()
      const byId = commands.find((c) => c.id === triggerOrId)
      if (byId) return byId
      return resolveSlashCommandForSubmit(triggerOrId, commands, slash.activeCommand)
    },
    [slash]
  )

  const resolveAndExecute = useCallback(
    async (
      command: SlashCommandDescriptor,
      trailingText: string,
      sendImages: string[],
      sendFiles: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean> => {
      if (!window.vyotiq?.slashCommandsResolve) return false

      if (command.availability === 'not_installed' && command.packageId) {
        await slashHandlers?.onMarketplaceAction?.(command.packageId, 'install')
        await slash.reload()
        return false
      }
      if (command.availability === 'disabled' && command.packageId) {
        await slashHandlers?.onMarketplaceAction?.(command.packageId, 'enable')
        await slash.reload()
        return false
      }
      if (
        command.availability === 'disconnected' ||
        command.availability === 'needs_auth'
      ) {
        notifyMcpUnavailable(command, slashHandlers)
        return false
      }

      // Trailing text may include @mention markers (skill chip submit / typed after /cmd).
      const boundWorkspace = workspacePath
      const resolvedTrailing = await resolveComposerMentions({
        workspacePath: boundWorkspace,
        draft: trailingText,
        existingFiles: sendFiles,
        existingImages: sendImages,
        runId: activeRunId ?? null,
        isCurrent: () => workspacePathRef.current === boundWorkspace
      })
      if (resolvedTrailing.stale || workspacePathRef.current !== boundWorkspace) {
        return false
      }
      if (resolvedTrailing.error) {
        setFileError(resolvedTrailing.error)
        return false
      }

      const res = await window.vyotiq.slashCommandsResolve({
        id: command.id,
        workspacePath: workspacePath ?? null,
        trailingText: resolvedTrailing.text
      })
      if (!res.ok) {
        slashHandlers?.onNotice?.(res.error)
        return false
      }

      const outcome = await executeSlashResolveResult(res.data, {
        ...slashHandlers,
        onCompact: async (focus?: string) => {
          if (slashHandlers?.onCompact) {
            const r = await slashHandlers.onCompact(focus)
            return r !== false
          }
          if (onCompactContext) {
            const r = await onCompactContext(focus)
            return typeof r === 'object' && r && 'ok' in r ? r.ok !== false : r !== false
          }
          return false
        }
      })

      if (outcome === 'sent' && res.data.action === 'send') {
        if (command.id === 'builtin:goal') {
          if (running && agentMode !== 'agent') {
            slashHandlers?.onNotice?.(
              'Start /goal in Agent mode. Prefer a new chat while another mode is running.'
            )
            return false
          }
          if (!running && agentMode !== 'agent') {
            const modeOk = await Promise.resolve(slashHandlers?.onSetAgentMode?.('agent'))
            if (modeOk === false) return false
          }
        }
        const ok = await Promise.resolve(
          sendWithMentions(
            res.data.message,
            resolvedTrailing.images.length ? resolvedTrailing.images : undefined,
            resolvedTrailing.files.length ? resolvedTrailing.files : undefined,
            extras
          )
        )
        return ok !== false
      }
      if (outcome === 'pending') {
        await slash.reload()
        return false
      }
      if (outcome === 'failed') return false
      return true
    },
    [workspacePath, activeRunId, slashHandlers, onCompactContext, sendWithMentions, slash, setFileError, running, agentMode]
  )

  const onSlashAccept = useCallback(
    (command: SlashCommandDescriptor): void => {
      // Marketplace / connectivity CTAs — do not insert or send.
      if (command.availability === 'not_installed' && command.packageId) {
        void Promise.resolve(
          slashHandlers?.onMarketplaceAction?.(command.packageId, 'install')
        ).then(() => {
          void slash.reload()
        })
        return
      }
      if (command.availability === 'disabled' && command.packageId) {
        void Promise.resolve(
          slashHandlers?.onMarketplaceAction?.(command.packageId, 'enable')
        ).then(() => {
          void slash.reload()
        })
        return
      }
      if (
        command.availability === 'disconnected' ||
        command.availability === 'needs_auth'
      ) {
        notifyMcpUnavailable(command, slashHandlers)
        return
      }

      // All slash kinds → chip; user adds trailing text then sends.
      const token = slash.token
      const before = token ? resolvedDraft.slice(0, token.start) : resolvedDraft
      const after = token
        ? resolvedDraft.slice(token.end).replace(/^\s+/, '')
        : ''
      const insertion = `${mentionMarker({
        kind: 'slash',
        slashKind: command.kind,
        trigger: command.trigger,
        commandId: command.id
      })} `
      const nextText = `${before}${insertion}${after}`
      const nextCursor = before.length + insertion.length
      onDraftChange?.(nextText)
      setCursor(nextCursor)
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(nextCursor)
        taRef.current?.focus()
      })
      slash.dismiss()
    },
    [slash, resolvedDraft, onDraftChange, slashHandlers]
  )

  const onSlashSubmit = useCallback(
    async (
      command: SlashCommandDescriptor,
      trailingText: string,
      sendImages: string[],
      sendFiles: AttachedFile[],
      extras?: ComposerSendExtras
    ): Promise<boolean> => {
      return resolveAndExecute(command, trailingText, sendImages, sendFiles, extras)
    },
    [resolveAndExecute]
  )

  // Restore composer focus after a send. Runs for every submit path (Enter,
  // send button, slash) because the contentEditable never fires form submit.
  // The double rAF recovers focus after a hero → dock remount.
  const keepComposerFocus = useCallback((): void => {
    const active = document.activeElement
    const hadComposerFocus =
      (taRef.current?.el != null && active === taRef.current.el) ||
      isMainComposerTarget(active)
    if (!hadComposerFocus) return
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        // A dialog the send opened (the first-send approval question) took
        // focus on purpose; taking it back would strand the keyboard behind it.
        if (document.activeElement?.closest('[aria-modal="true"]')) return
        // Own editor first — document order can point at another pane's composer.
        const own = taRef.current?.el
        if (own && own.isConnected) {
          own.focus()
          return
        }
        if (focusComposerMessage()) return
        taRef.current?.focus()
      })
    })
  }, [])

  const [refreshingCatalog, setRefreshingCatalog] = useState(false)
  const [browsedProvider, setBrowsedProvider] = useState<ProviderId>(provider)

  useEffect(() => {
    setBrowsedProvider(provider)
  }, [provider])

  const {
    providers,
    optionsByProvider,
    seedsByProvider,
    modelMetaByValue,
    warningsByProvider,
    modelsWarning,
    catalog,
    filterOpts,
    refreshCatalog,
    catalogLoading: catalogFetchLoading
  } = useComposerModels({
    provider,
    model,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    modelsRefreshKey,
    hasWorkspace,
    hasImages: images.length > 0,
    hasAudio: audio.length > 0,
    browsedProvider,
    secrets
  })

  const catalogLoading = catalogFetchLoading || refreshingCatalog
  const readinessIssue = deriveModelReadiness({
    provider,
    model,
    secrets,
    ollamaBaseUrl,
    customOpenAiBaseUrl,
    catalogWarning: modelsWarning,
    liveCatalog: catalog.length > 0 ? catalog : null,
    catalogLoading
  })
  const readinessBlocksSend = modelReadinessBlocksSend(readinessIssue)

  /** Save as draft: the brief, its checks and attachments go aside; the page empties. */
  const saveBriefDraft = async (): Promise<void> => {
    const workspace = briefWorkspace
    if (!workspace || savingDraft) return
    const continuing = briefDraftIdRef.current
    setSavingDraft(true)
    const res = await saveTaskDraftFor({
      workspacePath: workspace,
      id: continuing,
      brief: text,
      doneWhen: briefChecksRef.current,
      attachments: { images, files, nativeFiles, audio }
    })
    setSavingDraft(false)
    if (!res.ok) {
      pushToast(`Couldn’t save the draft: ${res.error}`, 'error')
      return
    }
    setText('')
    if (attachmentKey) clearComposerAttachments(attachmentKey)
    setBriefState(workspace, null)
    setBriefClearToken((n) => n + 1)
    pushToast(continuing ? 'Draft updated' : 'Saved as a draft', { detail: draftTitle(res.data), icon: 'check' })
  }

  const { text, setText, canSend, submit, onKeyDown } = useComposerDraft({
    submitOnModEnter: variant === 'brief',
    draft: resolvedDraft,
    onDraftChange,
    images,
    setImages,
    setImageError,
    files,
    setFiles,
    nativeFiles,
    setNativeFiles,
    audio,
    setAudio,
    setFileError,
    disabled,
    sendBlocked: extracting || readinessBlocksSend,
    onSend: sendWithMentions,
    slashMenuOpen: slash.open,
    slashActiveCommand: slash.activeCommand,
    onSlashMove: slash.moveActive,
    onSlashDismiss: slash.dismiss,
    onSlashAccept,
    onSlashSubmit,
    resolveSlashSubmitCommand,
    onSlashResolveError: setFileError,
    mentionMenuOpen: mentions.open,
    mentionActiveItem: mentions.activeItem,
    onMentionMove: (delta: number) => {
      const len = mentions.items.length
      if (!len) return
      mentions.setActiveIndex((i) => Math.max(0, Math.min(len - 1, i + delta)))
    },
    onMentionDismiss: mentions.dismiss,
    onMentionAccept,
    onMentionBack: mentions.goBack,
    onEditLastUserMessage: variant === 'dock' || variant === 'line' ? onEditLastUserMessage : undefined,
    onCancelEdit: variant === 'inline' ? onCancelEdit : undefined,
    getCaretStart: () => taRef.current?.getSelectionStart() ?? 0,
    onSubmitted: keepComposerFocus
  })

  const getDictationCaret = useCallback((): number => {
    const handle = taRef.current
    if (!handle) return cursorRef.current
    if (document.activeElement === handle.el) return handle.getSelectionStart()
    return cursorRef.current
  }, [])

  const setDictationCaret = useCallback((offset: number): void => {
    setCursor(offset)
    // Listening unmounts the editor; wait until it remounts after transcribe.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        taRef.current?.setSelectionStart(offset)
        taRef.current?.focus()
      })
    })
  }, [])

  const dictation = useComposerDictation({
    text,
    setText,
    secrets,
    disabled: Boolean(disabled),
    shortcutActive: true,
    isShortcutTarget: () => {
      const el = taRef.current?.el ?? null
      if (!el) return false
      const active = document.activeElement
      return active === el || el.contains(active)
    },
    focusComposer: () => taRef.current?.focus(),
    getCaret: getDictationCaret,
    setCaret: setDictationCaret
  })


  preferNativePdfRef.current = Boolean(
    (
      modelMetaByValue?.[modelSelectionKey(provider, model)] ?? modelMetaByValue?.[model]
    )?.inputModalities?.includes('file')
  )


  /**
   * At most one fallback attempt per (provider, current model, fallback) triple.
   * `onProviderModel` and the catalog identity change on parent renders, so an
   * effect calling this on identity change could re-enter indefinitely when the
   * fallback selection never settles — the React #185 loop class.
   */
  const visionFallbackAttemptRef = useRef<string | null>(null)
  const audioFallbackAttemptRef = useRef<string | null>(null)

  const ensureVisionModel = useCallback((): void => {
    if (running) return
    const fallback = pickVisionFallback(catalog, model, {
      ...filterOpts,
      hasImages: true
    })
    if (!fallback || fallback === model) {
      visionFallbackAttemptRef.current = null
      return
    }
    const attemptKey = `${provider}::${model}::${fallback}`
    if (visionFallbackAttemptRef.current === attemptKey) return
    visionFallbackAttemptRef.current = attemptKey
    onProviderModel(provider, fallback)
  }, [running, catalog, model, filterOpts, onProviderModel, provider])

  const ensureAudioModel = useCallback((): void => {
    if (running) return
    const fallback = pickAudioFallback(catalog, model, {
      ...filterOpts,
      hasAudio: true
    })
    if (!fallback || fallback === model) {
      audioFallbackAttemptRef.current = null
      return
    }
    const attemptKey = `${provider}::${model}::${fallback}`
    if (audioFallbackAttemptRef.current === attemptKey) return
    audioFallbackAttemptRef.current = attemptKey
    onProviderModel(provider, fallback)
  }, [running, catalog, model, filterOpts, onProviderModel, provider])

  // Cover picker, draft restore, and any setImages path — not only onPickAttachments.
  useEffect(() => {
    if (images.length > 0) ensureVisionModel()
  }, [images.length, ensureVisionModel])

  useEffect(() => {
    if (audio.length > 0) ensureAudioModel()
  }, [audio.length, ensureAudioModel])

  const onPickAttachments = async (list: FileList | File[] | null): Promise<void> => {
    if (!list?.length) return
    const picked = Array.from(list)
    const imageFiles = picked.filter(isImageFile)
    const audioFiles = picked.filter((file) => !isImageFile(file) && isAudioFile(file))
    const documents = picked.filter((file) => !isImageFile(file) && !isAudioFile(file))
    if (imageFiles.length) await onPickImages(imageFiles)
    if (audioFiles.length) await addAudio(audioFiles)
    if (documents.length) await addFiles(documents)
  }

  const onAttachmentDragOver = (e: DragEvent<HTMLElement>): void => {
    if (inputLocked || !e.dataTransfer) return
    if (isSessionDragEvent(e.dataTransfer)) return
    if (!Array.from(e.dataTransfer.types).includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  const onAttachmentDrop = (e: DragEvent<HTMLElement>): void => {
    if (inputLocked || !e.dataTransfer) return
    if (isSessionDragEvent(e.dataTransfer)) return
    const dropped = filesFromDataTransfer(e.dataTransfer)
    if (!dropped.length) return
    e.preventDefault()
    void onPickAttachments(dropped)
  }

  const layout = composerLayoutKind(variant)
  const isDock = layout === 'dock'
  const isInline = layout === 'inline'
  const isLine = layout === 'line'
  const isBrief = layout === 'brief'

  useLayoutEffect(() => {
    if (isInline) taRef.current?.focus()
  }, [isInline])

  // Floating dock publishes its measured height so the transcript can reserve
  // scroll clearance (consumed by MessageList's scroll container).
  const dockRef = useRef<HTMLDivElement | null>(null)
  useLayoutEffect(() => {
    if (!isDock) return
    const el = dockRef.current
    if (!el) return
    const stage = el.closest<HTMLElement>('[data-chat-stage]')
    if (!stage) return
    const apply = (): void => {
      stage.style.setProperty(COMPOSER_DOCK_RESERVE_VAR, `${el.offsetHeight}px`)
    }
    apply()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(apply)
    observer.observe(el)
    return () => {
      observer.disconnect()
      stage.style.removeProperty(COMPOSER_DOCK_RESERVE_VAR)
    }
  }, [isDock])

  const imagesFull = images.length >= MAX_IMAGES
  const filesFull = files.length + nativeFiles.length >= MAX_FILES
  const audioFull = audio.length >= MAX_AUDIO_FILES
  const fileRoom = MAX_FILES - files.length - nativeFiles.length
  const audioRoom = MAX_AUDIO_FILES - audio.length
  // Per-bucket capacity on the plus button: full buckets state "full", open
  // buckets state remaining slots — a click never dead-ends silently. Shown
  // only once at least one bucket is full; the resting label stays untouched.
  const attachHint =
    imagesFull || filesFull || audioFull
      ? [
          imagesFull ? 'Images full' : null,
          filesFull ? 'Files full' : null,
          audioFull ? 'Audio full' : null,
          fileRoom > 0 ? `${fileRoom} file slot${fileRoom === 1 ? '' : 's'} left` : null,
          audioRoom > 0 ? `${audioRoom} audio left` : null
        ]
          .filter(Boolean)
          .join(' · ')
      : null

  const sendDisabledReason = !canSend
    ? disabled
      ? hasWorkspace
        ? 'Sending is unavailable right now.'
        : 'Open a workspace to send a message.'
      : readinessBlocksSend && readinessIssue
        ? modelReadinessSendReason(readinessIssue)
        : extracting
          ? 'Finish processing the attachment before sending.'
          : fileError || imageError || audioError
            ? 'Resolve the attachment issue before sending.'
            : isInline
              ? 'Enter a replacement message to resend.'
              : 'Type a message or attach a file to send.'
    : null

  const hasContent =
    hasComposerContent(text) ||
    images.length > 0 ||
    files.length > 0 ||
    nativeFiles.length > 0 ||
    audio.length > 0

  const slashListId = `slash-command-menu-${variant}`
  const mentionListId = `composer-mention-menu-${variant}`

  const dictationStripState = resolveDictationStripState({
    phase: dictation.phase,
    error: dictation.error,
    errorAction: dictation.errorAction,
    elapsedMs: dictation.elapsedMs,
    waveform: dictation.waveform
  })

  const dictationActive =
    dictationStripState?.kind === 'checking' ||
    dictationStripState?.kind === 'listening' ||
    dictationStripState?.kind === 'transcribing'

  // The composer is always two rows: a full-width field and a dedicated
  // control row beneath it. No stacked-mode latching — the field owns the
  // shell width at every size, single line or multiline.

  const composerShellChrome = cn(
    FLOATING_CHROME,
    isDock && 'pointer-events-auto'
  )

  const showRetry =
    Boolean(onRetryNetwork) &&
    isRetryableTurnFailure({ errorCode, incompleteReason: incomplete?.reason })

  if (isBrief) {
    const attachFullAll = imagesFull && filesFull && audioFull
    const attachLabel = attachFullAll
      ? 'Attachment limits reached'
      : attachHint
        ? `Attach files — ${attachHint}`
        : 'Attach files'
    const showReadiness = Boolean(readinessIssue && readinessIssue.kind !== 'manual_catalog' && hasWorkspace)
    const dictationBusy = dictation.phase === 'checking' || dictation.phase === 'transcribing'
    const hasAttachmentRow =
      images.length > 0 ||
      files.length > 0 ||
      nativeFiles.length > 0 ||
      audio.length > 0 ||
      Boolean(imageError || fileError || audioError) ||
      extracting
    return (
      <NewTaskBrief
        workspacePath={workspacePath ?? null}
        targets={
          newTaskTargets
            ? {
                workspaces: newTaskTargets.workspaces,
                // The brief goes with the task; nothing is left behind here.
                onMove: (path, brief) => {
                  setText('')
                  newTaskTargets.onMove(path, brief)
                }
              }
            : undefined
        }
        brief={text}
        banners={
          bannerError || secondaryBannerError || showReadiness || dictationStripState?.kind === 'error' ? (
            <div className="mb-4 flex flex-col gap-2">
              {secondaryBannerError ? <Alert>{secondaryBannerError}</Alert> : null}
              {bannerError ? <Alert onDismiss={onDismissError}>{bannerError}</Alert> : null}
              {dictationStripState?.kind === 'error' ? (
                <DictationErrorBanner
                  message={dictationStripState.message}
                  settingsSection={dictationStripState.settingsSection}
                  onDismiss={() => dictation.setError(null)}
                  onOpenSettings={slashHandlers?.onOpenSettings}
                />
              ) : null}
              {showReadiness && readinessIssue ? (
                <ModelReadinessBanner
                  issue={readinessIssue}
                  busy={catalogLoading}
                  onRecheck={() => {
                    void refreshCatalog({ forceRefresh: true, provider })
                  }}
                  onAddKey={() => {
                    slashHandlers?.onOpenSettings?.('providers')
                  }}
                />
              ) : null}
            </div>
          ) : null
        }
        fileInput={
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              void onPickAttachments(e.target.files)
              e.target.value = ''
            }}
          />
        }
        input={
          dictationActive ? (
            <div
              className="flex min-h-[132px] items-start gap-2"
              role="status"
              aria-live="polite"
              aria-label={dictation.phase === 'recording' ? 'Listening' : lineMic(dictation.phase, null).label}
              data-dictation-session={dictationStripState?.kind}
            >
              <Waveform samples={dictation.waveform} style={dictation.waveformStyle} />
              <span className="shrink-0 font-mono text-xs text-muted tnum" aria-hidden="true">
                {formatElapsed(dictation.elapsedMs)}
              </span>
            </div>
          ) : (
          <div
            ref={mentionAnchorRef}
            data-composer-input-wrap
            onDragOver={onAttachmentDragOver}
            onDrop={onAttachmentDrop}
          >
            <ComposerMentionInput
              ref={taRef}
              size="brief"
              newlineOnEnter
              ariaLabel="Brief"
              value={text}
              onChange={(next) => {
                setText(next)
                requestAnimationFrame(syncCursor)
              }}
              onKeyDown={(e) => {
                onKeyDown(e)
                requestAnimationFrame(syncCursor)
              }}
              onCaretChange={(offset) => setCursor(offset)}
              onPasteFiles={(pasted) => {
                void onPickAttachments(pasted)
              }}
              placeholder={
                composerPlaceholder?.trim() ||
                (hasWorkspace
                  ? 'Describe the task — the agent plans it, does it, and shows you the result'
                  : 'Open a workspace to start a task')
              }
              disabled={inputLocked}
              onFocus={onFocus}
              aria-expanded={slash.open || mentions.open}
              aria-controls={slash.open ? slashListId : mentions.open ? mentionListId : undefined}
              aria-autocomplete={slash.open || mentions.open ? 'list' : undefined}
              aria-activedescendant={
                slash.open && slash.activeCommand
                  ? `${slashListId}-opt-${slash.activeCommand.id}`
                  : mentions.open && mentions.activeItem
                    ? `${mentionListId}-opt-${mentions.activeItem.id}`
                    : undefined
              }
            />
          </div>
          )
        }
        mic={
          <IconButton
            icon={dictationActive ? (dictationBusy ? 'loader' : 'stop') : 'mic'}
            label={lineMic(dictation.phase, dictation.engineHint).label}
            title={lineMic(dictation.phase, dictation.engineHint).tip}
            size="md"
            tone="muted"
            active={dictation.phase === 'recording'}
            disabled={Boolean(disabled) || dictationBusy}
            aria-busy={dictationBusy || undefined}
            className={dictationBusy ? '[&_svg]:motion-safe:animate-spin' : undefined}
            onMouseDown={(e) => e.preventDefault()}
            onClick={dictation.toggle}
          />
        }
        attachments={
          hasAttachmentRow ? (
            <ComposerAttachments
              images={images}
              imageError={imageError}
              files={files}
              nativeFiles={nativeFiles}
              audio={audio}
              fileError={fileError}
              audioError={audioError}
              extracting={extracting}
              attachLocked={inputLocked}
              onRemove={removeImage}
              onRemoveFile={removeFile}
              onRemoveNativeFile={removeNativeFile}
              onRemoveAudio={removeAudio}
            />
          ) : null
        }
        menus={
          <>
            <SlashCommandMenu
              open={slash.open}
              commands={slash.filtered}
              mcpServers={slash.mcpServers}
              activeIndex={slash.activeIndex}
              onActiveIndexChange={slash.setActiveIndex}
              onPick={onSlashAccept}
              onDismiss={slash.dismiss}
              anchorRef={mentionAnchorRef}
              listId={slashListId}
              loading={slash.loading}
              listError={slash.listError}
            />
            <MentionMenu
              open={mentions.open}
              view={mentions.view}
              items={mentions.items}
              query={mentions.token?.query ?? ''}
              activeIndex={mentions.activeIndex}
              onActiveIndexChange={mentions.setActiveIndex}
              onPick={onMentionAccept}
              onDismiss={mentions.dismiss}
              onBack={mentions.goBack}
              anchorRef={mentionAnchorRef}
              listId={mentionListId}
              loading={mentions.loading}
            />
          </>
        }
        attachLabel={attachLabel}
        attachDisabled={inputLocked || attachFullAll}
        onAttach={() => fileRef.current?.click()}
        onMention={() => {
          // Typing @ is what opens the context menu; do the same at the caret.
          taRef.current?.insertText('@')
        }}
        options={{
          provider,
          model,
          providers,
          optionsByProvider,
          seedsByProvider,
          modelMetaByValue,
          warningsByProvider,
          favoriteModels,
          recentModels,
          serviceTier,
          secrets,
          ollamaBaseUrl,
          customOpenAiBaseUrl,
          onModelChange: onProviderModel,
          onToggleFavorite,
          onServiceTierChange,
          onRefreshCatalog: () => {
            setRefreshingCatalog(true)
            void refreshCatalog({ forceRefresh: true, provider: browsedProvider }).finally(() =>
              setRefreshingCatalog(false)
            )
          },
          onBrowseProvider: setBrowsedProvider,
          catalogLoading,
          agentMode,
          onAgentModeChange,
          chatSettings,
          onChatSettingsChange,
          onAddProvider: slashHandlers?.onOpenSettings ? () => slashHandlers.onOpenSettings?.('providers') : undefined,
          running,
          disabled: settingsLocked,
          focusInput
        }}
        canStart={canSend}
        startBlockedReason={sendDisabledReason}
        onChecksChange={(doneWhen) => {
          briefChecksRef.current = doneWhen
        }}
        checks={briefState.checks}
        onChecksEdit={(next) => {
          if (briefWorkspace) setBriefChecks(briefWorkspace, next)
        }}
        clearToken={briefClearToken}
        draft={
          briefWorkspace
            ? {
                onSave: () => void saveBriefDraft(),
                canSave:
                  text.trim().length > 0 ||
                  briefState.checks.length > 0 ||
                  images.length + files.length + nativeFiles.length + audio.length > 0,
                saving: savingDraft,
                continuing: briefState.draftId != null
              }
            : undefined
        }
        onStart={() => submit()}
        onOpenSettings={slashHandlers?.onOpenSettings ? (section) => slashHandlers.onOpenSettings?.(section) : undefined}
        headerActions={briefHeaderActions}
      />
    )
  }

  if (isLine) {
    const attachFullAll = imagesFull && filesFull && audioFull
    const attachLabel = attachFullAll
      ? 'Attachment limits reached'
      : attachHint
        ? `Attach files — ${attachHint}`
        : 'Attach files — or type @ for context'
    const dictationBusy = dictation.phase === 'checking' || dictation.phase === 'transcribing'
    const hasAttachmentRow =
      images.length > 0 ||
      files.length > 0 ||
      nativeFiles.length > 0 ||
      audio.length > 0 ||
      Boolean(imageError || fileError || audioError) ||
      extracting
    const showReadiness = Boolean(readinessIssue && readinessIssue.kind !== 'manual_catalog' && hasWorkspace)
    return (
      <div className={cn('shrink-0 border-t border-border bg-bg', className)} data-composer-line>
        {bannerError || secondaryBannerError ? (
          <div className="flex flex-col gap-2 border-b border-border px-4 py-2">
            {secondaryBannerError ? <Alert>{secondaryBannerError}</Alert> : null}
            {bannerError ? (
              <Alert onDismiss={onDismissError}>
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{bannerError}</span>
                  {showRetry ? (
                    <Button size="xs" onClick={onRetryNetwork}>
                      Retry
                    </Button>
                  ) : null}
                </div>
              </Alert>
            ) : null}
          </div>
        ) : null}

        {pendingFollowUps.length > 0 ? (
          <ul className="m-0 list-none p-0" data-follow-up-queue aria-label="Queued instructions">
            {pendingFollowUps.map((entry) =>
              editingFollowUpId === entry.id ? (
                <li key={entry.id} className="flex items-start gap-2 border-b border-border px-4 py-2">
                  <textarea
                    ref={followUpEditRef}
                    className="min-h-14 min-w-0 flex-1 resize-y rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-fg-strong outline-none focus-visible:vy-focus-ring"
                    value={editingFollowUpText}
                    onChange={(e) => setEditingFollowUpText(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') {
                        e.stopPropagation()
                        setEditingFollowUpId(null)
                      }
                    }}
                    aria-label="Edit queued follow-up"
                    rows={2}
                  />
                  <Button
                    size="xs"
                    variant="primary"
                    aria-label="Save queued follow-up edit"
                    disabled={!editingFollowUpText.trim()}
                    onClick={async () => {
                      const trimmed = editingFollowUpText.trim()
                      if (!trimmed) return
                      const ok = onEditFollowUp ? await onEditFollowUp(entry.id, trimmed) : true
                      if (ok) setEditingFollowUpId(null)
                    }}
                  >
                    Save
                  </Button>
                  <Button size="xs" variant="ghost" aria-label="Cancel queued follow-up edit" onClick={() => setEditingFollowUpId(null)}>
                    Cancel
                  </Button>
                </li>
              ) : (
                <li key={entry.id} className="flex h-8 items-center gap-2.5 border-b border-border px-4 text-xs">
                  <Icon name="enter" size={13} className="shrink-0 text-tertiary" />
                  <span className="shrink-0 text-tertiary">Queued</span>
                  <span className="min-w-0 flex-1 truncate text-secondary" title={entry.text}>
                    {entry.preview}
                  </span>
                  {onEditFollowUp ? (
                    <button
                      type="button"
                      aria-label="Edit queued follow-up"
                      onClick={() => {
                        setEditingFollowUpId(entry.id)
                        setEditingFollowUpText(entry.text)
                      }}
                      className="shrink-0 whitespace-nowrap rounded font-medium text-muted vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
                    >
                      Edit
                    </button>
                  ) : null}
                  {onSendFollowUpNow ? (
                    <button
                      type="button"
                      aria-label="Send queued follow-up now"
                      title="Interrupt the run and apply it now"
                      onClick={() => onSendFollowUpNow(entry.id)}
                      className="shrink-0 whitespace-nowrap rounded font-medium text-muted vy-transition hover:text-fg-strong focus-visible:vy-focus-ring"
                    >
                      Send now
                    </button>
                  ) : null}
                  {onRemoveFollowUp ? (
                    <IconButton
                      icon="close"
                      label="Remove queued follow-up"
                      size="xs"
                      tone="muted"
                      onClick={() => onRemoveFollowUp(entry.id)}
                    />
                  ) : null}
                </li>
              )
            )}
          </ul>
        ) : null}

        <form
          onSubmit={submit}
          data-composer-shell
          onDragOver={onAttachmentDragOver}
          onDrop={onAttachmentDrop}
        >
          <input
            ref={fileRef}
            type="file"
            accept={ATTACHMENT_ACCEPT}
            multiple
            className="hidden"
            aria-hidden
            tabIndex={-1}
            onChange={(e) => {
              void onPickAttachments(e.target.files)
              e.target.value = ''
            }}
          />
          {hasAttachmentRow || showReadiness || dictationStripState?.kind === 'error' ? (
            <div className="flex flex-col gap-2 px-4 pt-2">
              <ComposerAttachments
                images={images}
                imageError={imageError}
                files={files}
                nativeFiles={nativeFiles}
                audio={audio}
                fileError={fileError}
                audioError={audioError}
                extracting={extracting}
                attachLocked={inputLocked}
                onRemove={removeImage}
                onRemoveFile={removeFile}
                onRemoveNativeFile={removeNativeFile}
                onRemoveAudio={removeAudio}
              />
              {showReadiness && readinessIssue ? (
                <ModelReadinessBanner
                  issue={readinessIssue}
                  busy={catalogLoading}
                  onRecheck={() => {
                    void refreshCatalog({ forceRefresh: true, provider })
                  }}
                  onAddKey={() => {
                    slashHandlers?.onOpenSettings?.('providers')
                  }}
                />
              ) : null}
              {dictationStripState?.kind === 'error' ? (
                <DictationErrorBanner
                  message={dictationStripState.message}
                  settingsSection={dictationStripState.settingsSection}
                  onDismiss={() => dictation.setError(null)}
                  onOpenSettings={slashHandlers?.onOpenSettings}
                />
              ) : null}
            </div>
          ) : null}
          <div className="flex min-h-11 items-start gap-2.5 px-4 py-2" data-composer-row>
            <span aria-hidden="true" className="flex h-7 shrink-0 items-center font-mono text-md font-semibold text-accent">
              ›
            </span>
            {dictationActive ? (
              <div
                className="flex h-7 min-w-0 flex-1 items-center gap-2"
                role="status"
                aria-live="polite"
                aria-label={dictation.phase === 'recording' ? 'Listening' : lineMic(dictation.phase, null).label}
                data-dictation-session={dictationStripState?.kind}
              >
                <Waveform samples={dictation.waveform} style={dictation.waveformStyle} />
                <span className="shrink-0 font-mono text-xs text-muted tnum" aria-hidden="true">
                  {formatElapsed(dictation.elapsedMs)}
                </span>
              </div>
            ) : (
              <div ref={mentionAnchorRef} className="min-w-0 flex-1 py-1" data-composer-input-wrap>
                <ComposerMentionInput
                  ref={taRef}
                  size="sm"
                  ariaLabel="Instruction"
                  value={text}
                  onChange={(next) => {
                    setText(next)
                    requestAnimationFrame(syncCursor)
                  }}
                  onKeyDown={(e) => {
                    onKeyDown(e)
                    requestAnimationFrame(syncCursor)
                  }}
                  onCaretChange={(offset) => setCursor(offset)}
                  onPasteFiles={(pasted) => {
                    void onPickAttachments(pasted)
                  }}
                  placeholder={
                    composerPlaceholder?.trim() ||
                    resolveLinePlaceholder({
                      hasWorkspace: Boolean(hasWorkspace),
                      running,
                      agentMode,
                      runCount
                    })
                  }
                  disabled={inputLocked}
                  onFocus={onFocus}
                  aria-expanded={slash.open || mentions.open}
                  aria-controls={slash.open ? slashListId : mentions.open ? mentionListId : undefined}
                  aria-autocomplete={slash.open || mentions.open ? 'list' : undefined}
                  aria-activedescendant={
                    slash.open && slash.activeCommand
                      ? `${slashListId}-opt-${slash.activeCommand.id}`
                      : mentions.open && mentions.activeItem
                        ? `${mentionListId}-opt-${mentions.activeItem.id}`
                        : undefined
                  }
                />
              </div>
            )}
            {dictationActive ? (
              <IconButton
                icon="close"
                label="Cancel dictation"
                size="md"
                tone="muted"
                onMouseDown={(e) => e.preventDefault()}
                onClick={dictation.cancel}
              />
            ) : (
              <IconButton
                icon="paperclip"
                label={attachLabel}
                size="md"
                tone="muted"
                disabled={inputLocked || attachFullAll}
                data-composer-plus
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => fileRef.current?.click()}
              />
            )}
            <IconButton
              icon={dictationActive ? (dictationBusy ? 'loader' : 'stop') : 'mic'}
              label={lineMic(dictation.phase, dictation.engineHint).label}
              title={lineMic(dictation.phase, dictation.engineHint).tip}
              size="md"
              tone="muted"
              active={dictation.phase === 'recording'}
              disabled={Boolean(disabled) || dictationBusy}
              aria-busy={dictationBusy || undefined}
              className={dictationBusy ? '[&_svg]:motion-safe:animate-spin' : undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={dictation.toggle}
            />
            <TaskOptions
              provider={provider}
              model={model}
              providers={providers}
              optionsByProvider={optionsByProvider}
              seedsByProvider={seedsByProvider}
              modelMetaByValue={modelMetaByValue}
              warningsByProvider={warningsByProvider}
              favoriteModels={favoriteModels}
              recentModels={recentModels}
              serviceTier={serviceTier}
              secrets={secrets}
              ollamaBaseUrl={ollamaBaseUrl}
              customOpenAiBaseUrl={customOpenAiBaseUrl}
              onModelChange={onProviderModel}
              onToggleFavorite={onToggleFavorite}
              onServiceTierChange={onServiceTierChange}
              onRefreshCatalog={() => {
                setRefreshingCatalog(true)
                void refreshCatalog({ forceRefresh: true, provider: browsedProvider }).finally(() =>
                  setRefreshingCatalog(false)
                )
              }}
              onBrowseProvider={setBrowsedProvider}
              catalogLoading={catalogLoading}
              agentMode={agentMode}
              onAgentModeChange={onAgentModeChange}
              chatSettings={chatSettings}
              onChatSettingsChange={onChatSettingsChange}
              contextUsage={contextUsage}
              metaStore={metaStore}
              onCompactContext={onCompactContext}
              onAddProvider={slashHandlers?.onOpenSettings ? () => slashHandlers.onOpenSettings?.('providers') : undefined}
              running={running}
              disabled={settingsLocked}
              focusInput={focusInput}
            />
          </div>
        </form>

        {!dictationActive ? (
          <>
            <SlashCommandMenu
              open={slash.open}
              commands={slash.filtered}
              mcpServers={slash.mcpServers}
              activeIndex={slash.activeIndex}
              onActiveIndexChange={slash.setActiveIndex}
              onPick={onSlashAccept}
              onDismiss={slash.dismiss}
              anchorRef={mentionAnchorRef}
              listId={slashListId}
              loading={slash.loading}
              listError={slash.listError}
            />
            <MentionMenu
              open={mentions.open}
              view={mentions.view}
              items={mentions.items}
              query={mentions.token?.query ?? ''}
              activeIndex={mentions.activeIndex}
              onActiveIndexChange={mentions.setActiveIndex}
              onPick={onMentionAccept}
              onDismiss={mentions.dismiss}
              onBack={mentions.goBack}
              anchorRef={mentionAnchorRef}
              listId={mentionListId}
              loading={mentions.loading}
            />
          </>
        ) : null}
      </div>
    )
  }

  const composerFields = (
    <>
      <input
        ref={fileRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          void onPickAttachments(e.target.files)
          e.target.value = ''
        }}
      />

      {pendingFollowUps.length > 0 ? (
        <div
          className="flex flex-col gap-1.5"
          data-follow-up-queue
          aria-label="Queued follow-ups"
        >
          {pendingFollowUps.map((entry) => {
            const isEditing = editingFollowUpId === entry.id
            const queueAction =
              'shrink-0 rounded px-2 py-1 text-2xs font-medium text-muted vy-transition hover:bg-surface hover:text-fg'
            return (
              <div
                key={entry.id}
                className="flex flex-wrap items-start gap-2 rounded-lg border border-border bg-surface px-2 py-1.5 text-caption"
              >
                {isEditing ? (
                  <>
                    <textarea
                      ref={followUpEditRef}
                      className="min-h-[var(--vy-control-min-h)] min-w-[12rem] flex-1 resize-y rounded-md border border-border bg-bg px-2 py-1 text-md leading-snug text-fg"
                      value={editingFollowUpText}
                      onChange={(e) => setEditingFollowUpText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Escape') {
                          e.stopPropagation()
                          setEditingFollowUpId(null)
                        }
                      }}
                      aria-label="Edit queued follow-up"
                      rows={2}
                    />
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        type="button"
                        className={queueAction}
                        aria-label="Save queued follow-up edit"
                        disabled={!editingFollowUpText.trim()}
                        onClick={async () => {
                          const trimmed = editingFollowUpText.trim()
                          if (!trimmed) return
                          const ok = onEditFollowUp ? await onEditFollowUp(entry.id, trimmed) : true
                          if (ok) setEditingFollowUpId(null)
                        }}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className={queueAction}
                        aria-label="Cancel queued follow-up edit"
                        onClick={() => setEditingFollowUpId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 text-fg" title={entry.text}>
                      {entry.preview}
                    </span>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {onEditFollowUp ? (
                        <button
                          type="button"
                          className={queueAction}
                          aria-label="Edit queued follow-up"
                          onClick={() => {
                            setEditingFollowUpId(entry.id)
                            setEditingFollowUpText(entry.text)
                          }}
                        >
                          Edit
                        </button>
                      ) : null}
                      {onSendFollowUpNow ? (
                        <button
                          type="button"
                          className={queueAction}
                          aria-label="Send queued follow-up now"
                          onClick={() => onSendFollowUpNow(entry.id)}
                        >
                          Send now
                        </button>
                      ) : null}
                      {onRemoveFollowUp ? (
                        <button
                          type="button"
                          className={cn(queueAction, 'hover:text-danger')}
                          aria-label="Remove queued follow-up"
                          onClick={() => onRemoveFollowUp(entry.id)}
                        >
                          Remove
                        </button>
                      ) : null}
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : null}

      <ComposerAttachments
        images={images}
        imageError={imageError}
        files={files}
        nativeFiles={nativeFiles}
        audio={audio}
        fileError={fileError}
        audioError={audioError}
        extracting={extracting}
        attachLocked={inputLocked}
        onRemove={removeImage}
        onRemoveFile={removeFile}
        onRemoveNativeFile={removeNativeFile}
        onRemoveAudio={removeAudio}
      />

      {readinessIssue && readinessIssue.kind !== 'manual_catalog' && hasWorkspace ? (
        <ModelReadinessBanner
          issue={readinessIssue}
          busy={catalogLoading}
          onRecheck={() => {
            void refreshCatalog({ forceRefresh: true, provider })
          }}
          onAddKey={() => {
            slashHandlers?.onOpenSettings?.('providers')
          }}
        />
      ) : null}

      {dictationStripState?.kind === 'error' ? (
        <DictationErrorBanner
          message={dictationStripState.message}
          settingsSection={dictationStripState.settingsSection}
          onDismiss={() => dictation.setError(null)}
          onOpenSettings={slashHandlers?.onOpenSettings}
        />
      ) : null}

      {/* Full-width field — the draft owns the entire shell width at every
          size; tools and actions share a dedicated control row below it. */}
      {!dictationActive && (
        <div ref={mentionAnchorRef} className="w-full min-w-0" data-composer-input-wrap>
          <ComposerMentionInput
            ref={taRef}
            value={text}
            onChange={(next) => {
              setText(next)
              requestAnimationFrame(syncCursor)
            }}
            onKeyDown={(e) => {
              onKeyDown(e)
              requestAnimationFrame(syncCursor)
            }}
            onCaretChange={(offset) => setCursor(offset)}
            onPasteFiles={(files) => {
              void onPickAttachments(files)
            }}
            placeholder={resolveComposerPlaceholder({
              hasWorkspace: Boolean(hasWorkspace),
              running,
              agentMode,
              hasTranscript: Boolean(hasTranscript),
              override: composerPlaceholder
            })}
            disabled={inputLocked}
            onFocus={onFocus}
            aria-expanded={slash.open || mentions.open}
            aria-controls={slash.open ? slashListId : mentions.open ? mentionListId : undefined}
            aria-autocomplete={slash.open || mentions.open ? 'list' : undefined}
            aria-activedescendant={
              slash.open && slash.activeCommand
                ? `${slashListId}-opt-${slash.activeCommand.id}`
                : mentions.open && mentions.activeItem
                  ? `${mentionListId}-opt-${mentions.activeItem.id}`
                  : undefined
            }
          />
        </div>
      )}
      <div className="flex min-h-8 items-center justify-between gap-2" data-composer-row>
        {!dictationActive && (
          <ComposerToolbarTools
            locked={settingsLocked}
            workspacePath={workspacePath ?? null}
            attachDisabled={inputLocked}
            attachFull={imagesFull && filesFull && audioFull}
            attachHint={attachHint}
            onAttach={() => fileRef.current?.click()}
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
            onModelChange={onProviderModel}
            onToggleFavorite={onToggleFavorite}
            onServiceTierChange={onServiceTierChange}
            onRefreshCatalog={() => {
              setRefreshingCatalog(true)
              void refreshCatalog({ forceRefresh: true, provider: browsedProvider }).finally(() =>
                setRefreshingCatalog(false)
              )
            }}
            onBrowseProvider={setBrowsedProvider}
            catalogLoading={catalogLoading}
            agentMode={agentMode}
            onAgentModeChange={onAgentModeChange}
            agentProfileId={agentProfileId}
            onAgentProfileChange={onAgentProfileChange}
            running={running}
            focusInput={focusInput}
          />
        )}
        <ComposerToolbar
          variant={variant}
          disabled={disabled}
          // While dictation replaces the input, the toolbar is the row's only
          // child — flex so the waveform expands and the actions right-align.
          className={dictationActive ? 'flex-1' : undefined}
          modelMetaByValue={modelMetaByValue}
          provider={provider}
          model={model}
          chatSettings={chatSettings}
          onChatSettingsChange={onChatSettingsChange}
          running={running}
          canSend={canSend}
          hasContent={hasContent}
          sendDisabledReason={sendDisabledReason}
          onStop={onStop}
          contextUsage={contextUsage}
          metaStore={metaStore}
          onCompactContext={onCompactContext}
          onCancelEdit={isInline ? onCancelEdit : undefined}
          dictationPhase={dictation.phase}
          dictationEngineHint={dictation.engineHint}
          onDictationToggle={dictation.toggle}
          dictationWaveform={dictation.waveform}
          dictationElapsedMs={dictation.elapsedMs}
          dictationWaveformStyle={dictation.waveformStyle}
          onDictationCancel={dictation.cancel}
        />
      </div>

      {!dictationActive ? (
        <>
          <SlashCommandMenu
            open={slash.open}
            commands={slash.filtered}
            activeIndex={slash.activeIndex}
            onActiveIndexChange={slash.setActiveIndex}
            onPick={onSlashAccept}
            onDismiss={slash.dismiss}
            anchorRef={mentionAnchorRef}
                listId={slashListId}
                loading={slash.loading}
                listError={slash.listError}
              />

              <MentionMenu
                open={mentions.open}
                view={mentions.view}
                items={mentions.items}
                query={mentions.token?.query ?? ''}
                activeIndex={mentions.activeIndex}
                onActiveIndexChange={mentions.setActiveIndex}
                onPick={onMentionAccept}
                onDismiss={mentions.dismiss}
                onBack={mentions.goBack}
                anchorRef={mentionAnchorRef}
                listId={mentionListId}
                loading={mentions.loading}
              />
            </>
          ) : null}
    </>
  )

  return (
    <div
      ref={isDock ? dockRef : undefined}
      className={cn(
        isDock ? COMPOSER_FLOAT_DOCK : 'shrink-0 w-full pb-0 pt-0',
        // Same gutters as the transcript so the floating column's edges line up
        // exactly with the transcript column (edge to edge with the content).
        isDock ? CHAT_GUTTER : '',
        className
      )}
      data-composer-dock={isDock ? true : undefined}
      data-composer-hero={variant === 'hero' ? true : undefined}
      data-composer-inline={isInline ? true : undefined}
    >
      {/* Scroll-clipped body — reserves the transcript's scrollbar gutter so the
          centered column lines up exactly with the transcript column. */}
      <div className={cn(isDock && COMPOSER_FLOAT_BODY)}>
        <div
          className={cn(isDock && CHAT_COLUMN, isDock && COMPOSER_DOCK_COVER, 'flex flex-col gap-2')}
          data-composer-column={isDock ? true : undefined}
        >
        {(isDock || isInline) && (bannerError || secondaryBannerError) ? (
          <div className="pointer-events-auto flex shrink-0 flex-col gap-2">
            {secondaryBannerError ? (
              <Alert className="shrink-0">{secondaryBannerError}</Alert>
            ) : null}
            {bannerError ? (
              <Alert className="shrink-0" onDismiss={onDismissError}>
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{bannerError}</span>
                  {showRetry ? (
                    <button
                      type="button"
                      className="shrink-0 rounded-xl border border-border px-2 py-0.5 text-caption font-medium text-fg transition-colors hover:bg-surface"
                      onClick={onRetryNetwork}
                    >
                      Retry
                    </button>
                  ) : null}
                </div>
              </Alert>
            ) : null}
          </div>
        ) : null}

        {isDock ? (
          <div className="relative flex min-w-0 flex-col">
            <div
              className={composerShellChrome}
              data-composer-shell
              onDragOver={onAttachmentDragOver}
              onDrop={onAttachmentDrop}
            >
              <form onSubmit={submit} className={COMPOSER_FORM_LAYOUT}>
                {composerFields}
              </form>
            </div>
            {trailing}
          </div>
        ) : (
          <form
            onSubmit={submit}
            className={cn(COMPOSER_FORM_LAYOUT, composerShellChrome)}
            data-composer-shell
            onDragOver={onAttachmentDragOver}
            onDrop={onAttachmentDrop}
          >
            {composerFields}
          </form>
        )}
        </div>
      </div>
    </div>
  )
}
