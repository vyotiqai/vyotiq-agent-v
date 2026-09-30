import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import type {
  AgentInteractionMode,
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ComposerSendExtras,
  ModelInfo,
  ProviderIdAny,
  SecretProvider,
  ServiceTier,
  SlashCommandDescriptor
} from '@shared/ipc'
import { modelSelectionKey } from '@shared/domain/modelSelection'
import { resolveModelContextWindow } from '@shared/domain/modelContextWindows'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { resolveSlashCommandForSubmit } from '@shared/slashCommands'
import { isRetryableTurnFailure } from '@shared/errors'
import { Alert, Button, IconButton, cn, pushToast } from '@renderer/lib/ui'
import {
  draftTitle,
  saveTaskDraftFor,
  setBriefChecks,
  setBriefState,
  setBriefWorktree,
  useBriefState
} from '@renderer/lib/drafts/taskDraftStore'
import { isSessionDragEvent } from '@renderer/lib/chat/chatPaneLayout'
import { ComposerMentionInput, type ComposerMentionInputHandle } from './ComposerMentionInput'
import { ComposerAttachments } from './ComposerAttachments'
import { ModelPicker } from './ModelPicker'
import { ModeSwitch } from './ModePicker'
import { ContextMeter, type ContextUsageState } from './ContextMeter'
import { useResolvedContextUsage, useResolvedCostHint } from './useContextUsage'
import type { ChatMetaStore } from '../../chatStores'
import { useComposerDraft } from './useComposerDraft'
import { useComposerImages, MAX_IMAGES } from './useComposerImages'
import { useComposerFiles, ATTACHMENT_ACCEPT, MAX_FILES, isImageFile } from './useComposerFiles'
import { useComposerAudio, isAudioFile, MAX_AUDIO_FILES } from './useComposerAudio'
import { useTake } from './take/useTake'
import { TakeStrip } from './take/TakeStrip'
import { MicControl } from './take/MicControl'
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
import { resolveLinePlaceholder } from './composerPlaceholder'
import { filesFromDataTransfer } from './dataTransferFiles'
import { focusComposerMessage, isMainComposerTarget } from '@renderer/lib/shortcuts'

/**
 * Three surfaces, one anatomy: the field, what is attached to it, then one
 * control row — mode, model · effort, context, attach, mic, the action.
 * `line` is the task's instruction line, flush with the pane's bottom edge
 * (Send, or Queue while a run is live; Stop stays in the task header).
 * `brief` is the New task page, the same field and row in its box.
 * `inline` is Edit and rerun, in a box where the instruction was.
 */
export type ComposerVariant = 'inline' | 'line' | 'brief'

/** The inline editor's placeholder when the caller names none. */
const INLINE_PLACEHOLDER = 'Edit the instruction…'

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
  variant = 'line',
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
  provider: ProviderIdAny
  model: string
  running: boolean
  disabled?: boolean
  hasWorkspace?: boolean
  /** No longer read — every placeholder here is set by its variant. Callers still pass it. */
  hasTranscript?: boolean
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<SecretProvider, boolean>
  draft?: string
  onDraftChange?: (draft: string) => void
  /** When set, draft is read from the hot UI store (avoids App re-renders on keystrokes). */
  workspacePath?: string | null
  onProviderModel: (provider: ProviderIdAny, model: string) => void
  favoriteModels?: string[]
  recentModels?: string[]
  serviceTier?: ServiceTier
  onToggleFavorite?: (provider: ProviderIdAny, model: string) => void
  onServiceTierChange?: (tier: ServiceTier) => void
  chatSettings: EffectiveChatSettings
  onChatSettingsChange: (patch: ChatSettingsPatch) => void
  agentMode?: AgentInteractionMode
  onAgentModeChange?: (mode: AgentInteractionMode) => void

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
  /** Line only: ArrowUp on empty draft or caret at start edits the last user prompt. */
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
  // useId's colons would need escaping in a selector; the menus look ids up by getElementById.
  const listIdBase = useId().replace(/:/g, '')
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
  const briefWorktreeRef = useRef(Boolean(briefState.worktree))
  briefWorktreeRef.current = Boolean(briefState.worktree)
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
        // New worktree: App makes it and starts the task there.
        if (variant === 'brief' && briefWorktreeRef.current) {
          extras = { ...(extras ?? {}), worktree: true }
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
              'Start /goal in Agent mode. Prefer a new task while another mode is running.'
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
  // Rerun button, slash) because the contentEditable never fires form submit.
  // The double rAF recovers focus after a remount (a brief becoming a line).
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
  const [browsedProvider, setBrowsedProvider] = useState<ProviderIdAny>(provider)

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
    catalogLoading: catalogFetchLoading,
    customProviders
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
    customProviders,
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
    onEditLastUserMessage: variant === 'line' ? onEditLastUserMessage : undefined,
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
    // The field is read-only while a take writes into it; place the caret
    // once it is editable again.
    requestAnimationFrame(() => {
      taRef.current?.focus()
      taRef.current?.setSelectionStart(offset)
    })
  }, [])

  const isDictationTarget = useCallback((): boolean => {
    const el = taRef.current?.el ?? null
    if (!el) return false
    const active = document.activeElement
    return active === el || el.contains(active)
  }, [])

  const focusForDictation = useCallback(() => taRef.current?.focus(), [])

  // "Send" from a take: the words land in the draft first, then the draft
  // submits on the render that has them — `submit` reads the draft it was
  // rendered with.
  const sendAfterTakeRef = useRef(false)
  const submitRef = useRef(submit)
  submitRef.current = submit
  const requestSendAfterTake = useCallback(() => {
    sendAfterTakeRef.current = true
  }, [])
  useEffect(() => {
    if (!sendAfterTakeRef.current) return
    sendAfterTakeRef.current = false
    submitRef.current()
  }, [text])

  const take = useTake({
    surface: variant,
    workspacePath,
    text,
    setText,
    secrets,
    disabled: Boolean(disabled),
    getCaret: getDictationCaret,
    setCaret: setDictationCaret,
    isShortcutTarget: isDictationTarget,
    focusComposer: focusForDictation,
    requestSend: variant === 'brief' ? null : requestSendAfterTake,
    openSettings: slashHandlers?.onOpenSettings
  })
  /** A take is writing into the field: typing, attaching and menus wait. */
  const takeOpen = take.field.locked

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

  const isInline = variant === 'inline'
  const isLine = variant === 'line'
  const isBrief = variant === 'brief'

  useLayoutEffect(() => {
    if (isInline) taRef.current?.focus()
  }, [isInline])

  const imagesFull = images.length >= MAX_IMAGES
  const filesFull = files.length + nativeFiles.length >= MAX_FILES
  const audioFull = audio.length >= MAX_AUDIO_FILES
  const fileRoom = MAX_FILES - files.length - nativeFiles.length
  const audioRoom = MAX_AUDIO_FILES - audio.length
  // Per-bucket capacity on the paperclip: full buckets state "full", open
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
  const attachFullAll = imagesFull && filesFull && audioFull
  const attachLabel = attachFullAll
    ? 'Attachment limits reached'
    : attachHint
      ? `Attach files — ${attachHint}`
      : 'Attach files — or type @ for context'

  const sendDisabledReason = !canSend
    ? disabled
      ? hasWorkspace
        ? 'Starting is unavailable right now.'
        : 'Open a workspace to start a task'
      : readinessBlocksSend && readinessIssue
        ? modelReadinessSendReason(readinessIssue)
        : extracting
          ? 'Finish processing the attachment before starting.'
          : fileError || imageError || audioError
            ? 'Resolve the attachment issue before starting.'
            : isInline
              ? 'Edit the instruction to rerun it'
              : isBrief
                ? 'Write a brief or attach a file to start.'
                : 'Write an instruction or attach a file first.'
    : null

  const slashListId = `slash-command-menu-${variant}-${listIdBase}`
  const mentionListId = `composer-mention-menu-${variant}-${listIdBase}`

  const showRetry =
    Boolean(onRetryNetwork) &&
    isRetryableTurnFailure({ errorCode, incompleteReason: incomplete?.reason })

  const hasAttachmentRow =
    images.length > 0 ||
    files.length > 0 ||
    nativeFiles.length > 0 ||
    audio.length > 0 ||
    Boolean(imageError || fileError || audioError) ||
    extracting
  const showReadiness = Boolean(readinessIssue && readinessIssue.kind !== 'manual_catalog' && hasWorkspace)

  /** Shift+Enter on the line while a run is live: this one goes in now, not at the turn's end. */
  const steer = (): void => submit(undefined, { steer: true })

  const placeholder =
    composerPlaceholder?.trim() ||
    (isBrief
      ? !hasWorkspace
        ? 'Open a workspace to start a task'
        : agentMode === 'ask'
          ? 'Ask about this workspace — the agent reads and answers, and changes nothing'
          : 'Describe the task — the agent plans it, does it, and shows you the result'
      : isInline
        ? INLINE_PLACEHOLDER
        : resolveLinePlaceholder({ hasWorkspace: Boolean(hasWorkspace), running, agentMode, runCount }))

  // ── The pieces every variant is built from ────────────────────────────

  const fileInput = (
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
  )

  const field = (
    <div ref={mentionAnchorRef} className="min-w-0" data-composer-input-wrap>
      <ComposerMentionInput
        ref={taRef}
        size={isBrief ? 'brief' : 'sm'}
        newlineOnEnter={isBrief}
        ariaLabel={isBrief ? 'Brief' : 'Instruction'}
        value={take.field.value ?? text}
        readOnly={takeOpen}
        highlights={take.field.highlights}
        onChange={(next) => {
          if (takeOpen) return
          setText(next)
          requestAnimationFrame(syncCursor)
        }}
        onKeyDown={(e) => {
          if (
            isLine &&
            running &&
            e.key === 'Enter' &&
            e.shiftKey &&
            !e.ctrlKey &&
            !e.metaKey &&
            !e.altKey &&
            !e.nativeEvent.isComposing &&
            !slash.open &&
            !mentions.open
          ) {
            e.preventDefault()
            steer()
            return
          }
          onKeyDown(e)
          requestAnimationFrame(syncCursor)
        }}
        onCaretChange={(offset) => setCursor(offset)}
        onPasteFiles={(pasted) => {
          void onPickAttachments(pasted)
        }}
        placeholder={placeholder}
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

  const attachments = hasAttachmentRow ? (
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

  const readiness =
    showReadiness && readinessIssue ? (
      <ModelReadinessBanner
        issue={readinessIssue}
        busy={catalogLoading}
        // On the brief, Start task is the page's one primary.
        primary={!isBrief}
        onRecheck={() => {
          void refreshCatalog({ forceRefresh: true, provider })
        }}
        onAddKey={() => {
          slashHandlers?.onOpenSettings?.('providers')
        }}
      />
    ) : null

  const errorAlerts =
    bannerError || secondaryBannerError ? (
      <>
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
      </>
    ) : null

  const menus = takeOpen ? null : (
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
        error={mentions.error}
      />
    </>
  )

  /**
   * The control row, the same on every surface: how the task runs on the
   * left (mode, then model · effort), what goes with it on the right
   * (context used, attach, mic), then this surface's action. While a take is
   * open it owns the field, and its strip stands in for the row, with the mic
   * kept at the end. What a take leaves behind — words inserted (Undo), a
   * discarded take (Restore), a mic error — is a slim row above the
   * controls, which stay: the next thing is usually Send.
   *
   * Its wrapper is the size container, so a split pane (280px at the least)
   * sheds in steps rather than spilling: keycaps under 480px, the context
   * share and Send now under 400px, the effort under 320px — and below that
   * the right group wraps under the left.
   */
  const controls = (action: ReactNode, opts: { context: boolean; takeSendLabel: string | null }): ReactNode =>
    takeOpen ? (
      <div className="flex h-10 min-w-0 items-center gap-1 @max-[480px]:[&_span:has(>kbd)]:hidden" data-composer-controls>
        <TakeStrip take={take} sendLabel={opts.takeSendLabel} className="min-w-0 flex-1" />
        <MicControl take={take} />
      </div>
    ) : (
      <>
        {take.view ? (
          <TakeStrip take={take} sendLabel={opts.takeSendLabel} className="min-w-0 @max-[480px]:[&_span:has(>kbd)]:hidden" />
        ) : null}
        <div
          className="flex min-h-10 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 py-1.5 @max-[480px]:[&_span:has(>kbd)]:hidden"
          data-composer-controls
        >
          <div className="flex min-w-0 flex-[1_1_140px] items-center gap-1">
            <ModeSwitch mode={agentMode} onChange={onAgentModeChange} disabled={settingsLocked} />
            <ModelPicker
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
              chatSettings={chatSettings}
              onChatSettingsChange={onChatSettingsChange}
              contextUsage={contextUsage}
              metaStore={metaStore}
              onAddProvider={slashHandlers?.onOpenSettings ? () => slashHandlers.onOpenSettings?.('providers') : undefined}
              running={running}
              disabled={settingsLocked}
              focusInput={focusInput}
              placement={isBrief ? 'down' : 'up'}
            />
          </div>
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {opts.context ? (
              <ComposerContextMeter
                provider={provider}
                model={model}
                modelMetaByValue={modelMetaByValue}
                contextUsage={contextUsage}
                metaStore={metaStore}
                onCompactContext={onCompactContext}
                running={running}
              />
            ) : null}
            <IconButton
              icon="paperclip"
              label={attachLabel}
              size="md"
              tone="muted"
              disabled={inputLocked || attachFullAll}
              data-composer-attach
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => fileRef.current?.click()}
            />
            <MicControl take={take} />
            {action}
          </div>
        </div>
      </>
    )

  // Buttons never take focus from the field on press: the field is where the
  // next instruction is typed, and the keys do the same thing.
  const keepFocus = (e: ReactMouseEvent): void => e.preventDefault()
  const sendReady = canSend && !takeOpen

  if (isBrief) {
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
          errorAlerts || readiness ? (
            <div className="mb-4 flex flex-col gap-2">
              {errorAlerts}
              {readiness}
            </div>
          ) : null
        }
        fileInput={fileInput}
        input={field}
        attachments={attachments}
        controls={controls(null, { context: false, takeSendLabel: null })}
        menus={menus}
        onDragOver={onAttachmentDragOver}
        onDrop={onAttachmentDrop}
        approval={chatSettings.toolApproval ?? null}
        canStart={sendReady}
        startBlockedReason={takeOpen ? 'Insert or discard the dictation first' : sendDisabledReason}
        onChecksChange={(doneWhen) => {
          briefChecksRef.current = doneWhen
        }}
        checks={briefState.checks}
        onChecksEdit={(next) => {
          if (briefWorkspace) setBriefChecks(briefWorkspace, next)
        }}
        clearToken={briefClearToken}
        worktree={Boolean(briefState.worktree)}
        onWorktreeChange={(on) => {
          if (briefWorkspace) setBriefWorktree(briefWorkspace, on)
        }}
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
    const shift = window.vyotiq?.platform === 'darwin' ? '⇧' : 'Shift'
    const lineAction = (
      <>
        {running && sendReady ? (
          <Button
            size="sm"
            variant="ghost"
            kbd={[shift, '↵']}
            aria-label="Send now"
            aria-keyshortcuts="Shift+Enter"
            className="@max-[400px]:hidden"
            title="Send it into the live run now, instead of when this turn ends"
            onMouseDown={keepFocus}
            onClick={steer}
          >
            Send now
          </Button>
        ) : null}
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          kbd={['↵']}
          aria-label={running ? 'Queue' : 'Send'}
          aria-keyshortcuts="Enter"
          title={
            sendReady
              ? running
                ? 'Queue it — it starts when this run ends'
                : 'Send'
              : takeOpen
                ? 'Insert or discard the dictation first'
                : (sendDisabledReason ?? undefined)
          }
          disabled={!sendReady}
          onMouseDown={keepFocus}
        >
          {running ? 'Queue' : 'Send'}
        </Button>
      </>
    )
    return (
      <div className={cn('shrink-0 border-t border-border bg-bg', className)} data-composer-line>
        {errorAlerts ? <div className="flex flex-col gap-2 border-b border-border px-4 py-2">{errorAlerts}</div> : null}

        {pendingFollowUps.length > 0 ? (
          <ul className="m-0 list-none p-0" data-follow-up-queue aria-label="Queued instructions">
            {pendingFollowUps.map((entry) =>
              editingFollowUpId === entry.id ? (
                <li key={entry.id} className="flex items-start gap-2 border-b border-border/60 py-2 pl-4 pr-3">
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
                    aria-label="Edit queued instruction"
                    rows={2}
                  />
                  <Button size="xs" variant="ghost" aria-label="Cancel queued instruction edit" onClick={() => setEditingFollowUpId(null)}>
                    Cancel
                  </Button>
                  <Button
                    size="xs"
                    variant="secondary"
                    aria-label="Save queued instruction edit"
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
                </li>
              ) : (
                <li
                  key={entry.id}
                  className="flex h-9 items-center gap-2 border-b border-border/60 pl-4 pr-3 text-xs"
                  data-follow-up-offline={entry.offline ? '' : undefined}
                >
                  {/* Offline: kept here, starts when the connection is back — the words say so. */}
                  <span className="shrink-0 text-tertiary">{entry.offline ? 'Queued · offline' : 'Queued'}</span>
                  <span className="min-w-0 flex-1 truncate text-secondary" title={entry.text}>
                    {entry.preview}
                  </span>
                  {onEditFollowUp ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Edit queued instruction"
                      onClick={() => {
                        setEditingFollowUpId(entry.id)
                        setEditingFollowUpText(entry.text)
                      }}
                    >
                      Edit
                    </Button>
                  ) : null}
                  {onSendFollowUpNow && !entry.offline ? (
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label="Send queued instruction now"
                      title="Interrupt the run and apply it now"
                      onClick={() => onSendFollowUpNow(entry.id)}
                    >
                      Send now
                    </Button>
                  ) : null}
                  {onRemoveFollowUp ? (
                    <IconButton
                      icon="close"
                      label="Remove queued instruction"
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

        <form onSubmit={submit} data-composer-shell onDragOver={onAttachmentDragOver} onDrop={onAttachmentDrop}>
          {fileInput}
          {readiness ? <div className="px-4 pt-3">{readiness}</div> : null}
          <div className="px-4 pt-3">{field}</div>
          {attachments ? <div className="px-4 pt-2">{attachments}</div> : null}
          <div className="pb-1 pl-4 pr-3 @container">
            {controls(lineAction, { context: true, takeSendLabel: running ? 'Queue' : 'Send' })}
          </div>
        </form>

        {menus}
      </div>
    )
  }

  // Inline: Edit and rerun — the same field and control row in a box, where
  // the instruction was. Enter reruns, Esc cancels; the buttons say so too.
  const inlineAction = (
    <>
      {onCancelEdit ? (
        <Button size="sm" variant="ghost" kbd={['Esc']} aria-label="Cancel edit" onMouseDown={keepFocus} onClick={onCancelEdit}>
          Cancel
        </Button>
      ) : null}
      <Button
        type="submit"
        size="sm"
        variant="secondary"
        kbd={['↵']}
        aria-label="Rerun"
        aria-keyshortcuts="Enter"
        title={sendReady ? 'Rerun with the edited instruction' : (sendDisabledReason ?? undefined)}
        disabled={!sendReady}
        onMouseDown={keepFocus}
      >
        Rerun
      </Button>
    </>
  )

  return (
    <div className={cn('flex w-full flex-col gap-2', className)} data-composer-inline>
      {errorAlerts ? <div className="flex flex-col gap-2">{errorAlerts}</div> : null}

      <form
        onSubmit={submit}
        className="rounded-lg border border-border bg-bg vy-transition focus-within:border-border-strong"
        data-composer-shell
        onDragOver={onAttachmentDragOver}
        onDrop={onAttachmentDrop}
      >
        {fileInput}
        {readiness ? <div className="px-3 pt-3">{readiness}</div> : null}
        <div className="px-3 pt-2.5">{field}</div>
        {attachments ? <div className="px-3 pt-2">{attachments}</div> : null}
        {/* The line is hidden while an edit is open: the context reading and Compact come here. */}
        <div className="pb-1 pl-3 pr-2 @container">{controls(inlineAction, { context: true, takeSendLabel: 'Rerun' })}</div>
      </form>

      {menus}
    </div>
  )
}

/**
 * The share of the context this task has used, beside the controls — read
 * from the meta store so a usage patch re-renders the meter, not the
 * composer. Nothing until the first report.
 */
function ComposerContextMeter({
  provider,
  model,
  modelMetaByValue,
  contextUsage,
  metaStore,
  onCompactContext,
  running
}: {
  provider: ProviderIdAny
  model: string
  modelMetaByValue: Record<string, ModelInfo>
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: (focus?: string) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  running: boolean
}) {
  const usage = useResolvedContextUsage(metaStore, contextUsage)
  const advisoryHint = useResolvedCostHint(metaStore, null)
  const meta = modelMetaByValue[modelSelectionKey(provider, model)] ?? modelMetaByValue[model]
  const modelWindow = resolveModelContextWindow({ id: model, contextWindow: meta?.contextWindow }, provider) ?? null
  return (
    <ContextMeter
      usage={usage}
      modelWindow={modelWindow}
      onCompact={onCompactContext}
      compactDisabled={running}
      advisoryHint={advisoryHint}
      showPercent
    />
  )
}
