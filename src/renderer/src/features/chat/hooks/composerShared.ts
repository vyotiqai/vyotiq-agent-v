import { useCallback, useEffect, useState } from 'react'
import type { UiItem } from '@shared/transcript'
import type {
  AgentInteractionMode,
  AttachedAudio,
  AttachedFile,
  AttachedNativeFile,
  ChatMessage,
  ComposerSendExtras,
  ProviderId,
  SecretProvider,
  ServiceTier
} from '@shared/ipc'
import {
  contentAudios,
  contentDisplayText,
  contentFiles,
  contentImages,
  contentNativeFiles
} from '@shared/ipc'
import type { ChatSettingsPatch, EffectiveChatSettings } from '@shared/effectiveSettings'
import { userMessageEditDraft } from '../utils/slashEditDraft'
import type { ChatMetaStore } from '../chatStores'
import type { IncompleteTurnState, PendingFollowUpState } from '@renderer/lib/hooks/createChatStreamController'
import type { ContextUsageState } from '../components/composer/ContextMeter'
import type { SlashClientHandlers } from '../components/composer/slashCommandExecute'
import { useTranscriptShowsError } from '../components/ChatStreamLeaves'
import type { ChatItemsStore } from '../chatStores'
import { isRetryableTurnFailure } from '@shared/errors'
import type { TurnOutcome } from '@shared/transcript'

export type ChatErrorSurfaces = {
  hasTranscriptRunError: boolean
  chatBannerError: string | null
  turnFailed: boolean
  turnFailureLabel: string | null
}

export type ChatErrorSurfacesArgs = {
  error: string | null
  errorCode?: string | null
  incomplete?: IncompleteTurnState | null
  turnStatus?: TurnOutcome | null
}

/**
 * Single derivation of the banner / turn-failure presentation shared by
 * ChatView and SessionChatColumn — the suppression rule (composer banner off
 * when the latest turn already shows the same error as a run_error row) and the
 * failure-label vocabulary live here so the surfaces cannot drift.
 */
export function deriveChatErrorSurfaces(
  hasTranscriptRunError: boolean,
  args: ChatErrorSurfacesArgs
): ChatErrorSurfaces {
  const turnFailed = isRetryableTurnFailure({
    errorCode: args.errorCode,
    incompleteReason: args.incomplete?.reason
  })
  return {
    hasTranscriptRunError,
    chatBannerError: hasTranscriptRunError ? null : args.error,
    turnFailed,
    turnFailureLabel: turnFailed
      ? args.incomplete?.message ?? (args.error ?? 'Failed')
      : args.turnStatus === 'error'
        ? 'Failed'
        : null
  }
}

/** Store-subscribed variant for live chat surfaces. */
export function useChatErrorSurfaces(
  args: ChatErrorSurfacesArgs & { itemsStore?: ChatItemsStore; items: UiItem[] }
): ChatErrorSurfaces {
  const hasTranscriptRunError = useTranscriptShowsError(args.itemsStore, args.items, args.error)
  return deriveChatErrorSurfaces(hasTranscriptRunError, args)
}

export type ComposerEditSeeds = {
  images?: string[]
  files?: AttachedFile[]
  audio?: AttachedAudio[]
  nativeFiles?: AttachedNativeFile[]
}

type SendFn = (
  text: string,
  images?: string[],
  files?: AttachedFile[],
  extras?: ComposerSendExtras
) => boolean | void | Promise<boolean | void>

/** Shared prompt-edit draft state for ChatView and SessionChatColumn. */
export function useComposerEditState(args: {
  surfaceKey: string
  messages: ChatMessage[]
  onSend: SendFn
  onEditAndResend?: (
    editMessageIndex: number,
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onRevertToUserMessage?: (userMessageIndex: number) => boolean | Promise<boolean>
  onAfterRevert?: () => void
}) {
  const {
    surfaceKey,
    messages,
    onSend,
    onEditAndResend,
    onRevertToUserMessage,
    onAfterRevert
  } = args
  const [editingUserMessageIndex, setEditingUserMessageIndex] = useState<number | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [editSeeds, setEditSeeds] = useState<ComposerEditSeeds>({})

  useEffect(() => {
    setEditingUserMessageIndex(null)
    setEditDraft('')
    setEditSeeds({})
  }, [surfaceKey])

  const cancelPromptEdit = useCallback(() => {
    setEditingUserMessageIndex(null)
    setEditDraft('')
    setEditSeeds({})
  }, [])

  const beginPromptEdit = useCallback(
    (messageIndex: number) => {
      const msg = messages[messageIndex]
      if (!msg || msg.role !== 'user') return
      const images = contentImages(msg.content)
      const files = contentFiles(msg.content)
      const audio = contentAudios(msg.content)
      const nativeFiles = contentNativeFiles(msg.content)
      const rawText = contentDisplayText(msg.content)
      setEditDraft(userMessageEditDraft(rawText))
      setEditSeeds({
        images: images.length ? images : undefined,
        files: files.length ? files : undefined,
        audio: audio.length ? audio : undefined,
        nativeFiles: nativeFiles.length ? nativeFiles : undefined
      })
      setEditingUserMessageIndex(messageIndex)
    },
    [messages]
  )

  const submitPromptEdit = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: ComposerSendExtras
    ) => {
      if (editingUserMessageIndex == null || !onEditAndResend) return false
      const index = editingUserMessageIndex
      const ok = await onEditAndResend(index, text, images, files, extras)
      if (ok !== false) cancelPromptEdit()
      return ok
    },
    [editingUserMessageIndex, onEditAndResend, cancelPromptEdit]
  )

  const beginPromptRevert = useCallback(
    async (messageIndex: number) => {
      if (!onRevertToUserMessage) return
      // Confirmation (with the affected-file list) is owned by the handler —
      // do not add a second native confirm here.
      const ok = await onRevertToUserMessage(messageIndex)
      if (ok !== false) onAfterRevert?.()
    },
    [onRevertToUserMessage, onAfterRevert]
  )

  const sendFromDock = useCallback(
    async (
      text: string,
      images?: string[],
      files?: AttachedFile[],
      extras?: ComposerSendExtras
    ) => {
      // Dock stays usable while editing; sending a new turn exits edit mode.
      if (editingUserMessageIndex != null) cancelPromptEdit()
      return onSend(text, images, files, extras)
    },
    [editingUserMessageIndex, cancelPromptEdit, onSend]
  )

  return {
    editingUserMessageIndex,
    editDraft,
    setEditDraft,
    editSeeds,
    editing: editingUserMessageIndex != null,
    cancelPromptEdit,
    beginPromptEdit,
    submitPromptEdit,
    beginPromptRevert,
    sendFromDock
  }
}

export function lastUserMessageIndex(messages: readonly ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    // Skip loop-injected protocol turns (goal continue) — they are not
    // editable/revertable user prompts.
    if (messages[i]?.role === 'user' && !messages[i].synthetic) return i
  }
  return null
}

export type BuildComposerSendPropsInput = {
  provider: ProviderId
  model: string
  running: boolean
  hasWorkspace: boolean
  hasTranscript: boolean
  workspacePath: string | null
  ollamaBaseUrl?: string
  customOpenAiBaseUrl?: string
  modelsRefreshKey?: string | number
  secrets: Record<SecretProvider, boolean>
  draft?: string
  onDraftChange?: (draft: string) => void
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
  onSend: (
    text: string,
    images?: string[],
    files?: AttachedFile[],
    extras?: ComposerSendExtras
  ) => boolean | void | Promise<boolean | void>
  onStop: () => void
  pendingFollowUps?: PendingFollowUpState[]
  onRemoveFollowUp?: (id: string) => void
  onEditFollowUp?: (id: string, text: string) => boolean | Promise<boolean>
  onSendFollowUpNow?: (id: string) => void
  onContinue?: () => void
  incomplete?: IncompleteTurnState | null
  errorCode?: string | null
  bannerError: string | null
  secondaryBannerError: string | null
  activeRunId: string | null
  onDismissError?: () => void
  contextUsage?: ContextUsageState | null
  metaStore?: ChatMetaStore
  onCompactContext?: (
    focus?: string
  ) => Promise<{ ok: true; message: string } | { ok: false; message: string }>
  slashHandlers?: SlashClientHandlers
  sideRailPad?: boolean
  onFocus?: () => void
  onEditLastUserMessage?: () => boolean
}

/** Shared dock/hero composer prop bag for ChatView and SessionChatColumn. */
export function buildComposerSendProps(input: BuildComposerSendPropsInput) {
  return {
    provider: input.provider,
    model: input.model,
    running: input.running,
    disabled: !input.hasWorkspace,
    hasTranscript: input.hasTranscript,
    hasWorkspace: input.hasWorkspace,
    ollamaBaseUrl: input.ollamaBaseUrl,
    customOpenAiBaseUrl: input.customOpenAiBaseUrl,
    modelsRefreshKey: input.modelsRefreshKey,
    secrets: input.secrets,
    draft: input.draft,
    onDraftChange: input.onDraftChange,
    workspacePath: input.workspacePath,
    onProviderModel: input.onProviderModel,
    favoriteModels: input.favoriteModels,
    recentModels: input.recentModels,
    serviceTier: input.serviceTier,
    onToggleFavorite: input.onToggleFavorite,
    onServiceTierChange: input.onServiceTierChange,
    chatSettings: input.chatSettings,
    onChatSettingsChange: input.onChatSettingsChange,
    agentMode: input.agentMode,
    onAgentModeChange: input.onAgentModeChange,
    onSend: input.onSend,
    onStop: input.onStop,
    pendingFollowUps: input.pendingFollowUps,
    onRemoveFollowUp: input.onRemoveFollowUp,
    onEditFollowUp: input.onEditFollowUp,
    onSendFollowUpNow: input.onSendFollowUpNow,
    incomplete: input.incomplete,
    onRetryNetwork: input.onContinue,
    errorCode: input.errorCode,
    bannerError: input.bannerError,
    secondaryBannerError: input.secondaryBannerError,
    activeRunId: input.activeRunId,
    onDismissError: input.onDismissError,
    contextUsage: input.metaStore ? undefined : input.contextUsage,
    metaStore: input.metaStore,
    onCompactContext: input.onCompactContext,
    slashHandlers: input.slashHandlers,
    sideRailPad: input.sideRailPad,
    ...(input.onFocus ? { onFocus: input.onFocus } : {}),
    ...(input.onEditLastUserMessage
      ? { onEditLastUserMessage: input.onEditLastUserMessage }
      : {})
  }
}
