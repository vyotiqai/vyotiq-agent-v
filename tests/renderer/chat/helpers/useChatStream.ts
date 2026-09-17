import { useCallback, useEffect, useReducer, useRef, useSyncExternalStore } from 'react'
import {
  createChatStreamController,
  type ChatStreamController
} from '@renderer/lib/hooks/createChatStreamController'

/**
 * Thin React wrapper around {@link createChatStreamController} for tests and single-workspace use.
 * Production UI should prefer {@link useWorkspaceManager} for parallel workspace contexts.
 */
export function useChatStream(workspacePath: string | null) {
  const controllerRef = useRef<ChatStreamController | null>(null)
  const pathRef = useRef<string | null>(null)
  const [, forceRender] = useReducer((x: number) => x + 1, 0)

  // Create the controller once, lazily. Recreation on workspace switch happens
  // in an effect (below) — never during render, because dispose() synchronously
  // notifies subscribers and would run while React is still rendering.
  if (controllerRef.current === null) {
    controllerRef.current = createChatStreamController({ workspacePath: workspacePath ?? '' })
    pathRef.current = workspacePath
  }

  useEffect(() => {
    if (pathRef.current === workspacePath) return
    controllerRef.current?.dispose()
    controllerRef.current = createChatStreamController({ workspacePath: workspacePath ?? '' })
    pathRef.current = workspacePath
    forceRender()
  }, [workspacePath])

  useEffect(() => {
    return () => controllerRef.current?.dispose()
  }, [])

  const controller = controllerRef.current

  const subscribe = useCallback(
    (onStoreChange: () => void) => controller.subscribe(onStoreChange),
    [controller]
  )

  const getRevision = useCallback(() => controllerRef.current?.getRevision() ?? 0, [])

  useSyncExternalStore(subscribe, getRevision, getRevision)

  useEffect(() => {
    if (!window.vyotiq?.onChatEvent) return
    return window.vyotiq.onChatEvent((event) => {
      controllerRef.current?.handleEvent(event)
    })
  }, [controller])

  useEffect(() => {
    if (!window.vyotiq?.onToolApprovalRequest) return
    return window.vyotiq.onToolApprovalRequest((request) => {
      controllerRef.current?.handleApprovalRequest(request)
    })
  }, [controller])

  useEffect(() => {
    if (!window.vyotiq?.onAgentQuestionRequest) return
    return window.vyotiq.onAgentQuestionRequest((request) => {
      controllerRef.current?.handleQuestionRequest(request)
    })
  }, [controller])

  return {
    items: controller.items,
    messages: controller.messages,
    running: controller.running,
    runId: controller.runId,
    error: controller.error,
    errorCode: controller.errorCode,
    runNotice: controller.runNotice,
    compacting: controller.compacting,
    incomplete: controller.incomplete,
    networkWait: controller.networkWait,
    contextUsage: controller.contextUsage,
    turnUsage: controller.turnUsage,
    turnStatus: controller.turnStatus,
    runStartedAt: controller.runStartedAt,
    runTerminalTick: controller.runTerminalTick,
    pendingRun: controller.pendingRun,
    transcriptLoading: controller.transcriptLoading,
    transcriptHasEarlier: controller.transcriptHasEarlier,
    transcriptLoadingEarlier: controller.transcriptLoadingEarlier,
    collapsedTurnIndices: controller.collapsedTurnIndices,
    pendingFollowUps: controller.pendingFollowUps,
    clearError: controller.clearError.bind(controller),
    send: controller.send.bind(controller),
    editAndResend: controller.editAndResend.bind(controller),
    revertToUserMessage: controller.revertToUserMessage.bind(controller),
    previewRewindToUserMessage: controller.previewRewindToUserMessage.bind(controller),
    removeFollowUp: controller.removeFollowUp.bind(controller),
    editFollowUp: controller.editFollowUp.bind(controller),
    sendFollowUpNow: controller.sendFollowUpNow.bind(controller),
    stop: controller.stop.bind(controller),
    reset: controller.reset.bind(controller),
    loadTranscript: controller.loadTranscript.bind(controller),
    hydrateTranscript: controller.hydrateTranscript.bind(controller),
    loadEarlierMessages: controller.loadEarlierMessages.bind(controller),
    syncFromDisk: controller.syncFromDisk.bind(controller),
    loadToolContent: controller.loadToolContent.bind(controller),
    toggleTurnCollapsed: controller.toggleTurnCollapsed.bind(controller),
    handleApprovalRequest: controller.handleApprovalRequest.bind(controller),
    respondToApproval: controller.respondToApproval.bind(controller),
    handleQuestionRequest: controller.handleQuestionRequest.bind(controller),
    respondToQuestion: controller.respondToQuestion.bind(controller)
  }
}
