import type { ComponentProps } from 'react'
import { ChatView } from '@renderer/features/chat/ChatView'
import { SessionChatColumn } from '@renderer/features/chat/SessionChatColumn'
import type { ChatPane } from '@renderer/lib/chat/chatPaneLayout'

type ChatViewProps = ComponentProps<typeof ChatView>
type ColumnProps = ComponentProps<typeof SessionChatColumn>
type MultiPane = ChatViewProps['multiPane']

/** What the host hands each pane; a test never passes these itself. */
type HostWired =
  | 'onShowInspector'
  | 'onOpenChanges'
  | 'onOpenWorkspaceFile'
  | 'showPageHeading'
  | 'approvalAutoFocus'

export type PaneChatViewProps = Omit<ChatViewProps, 'multiPane'> &
  Omit<ColumnProps, HostWired> & {
    /** Parts of the pane config to override (a drop handler, a split). */
    multiPane?: Partial<MultiPane>
  }

export const PANE_ID = 'pane-1'

/**
 * ChatView as the app mounts it: one pane whose body is SessionChatColumn,
 * wired the way App's renderPaneSession wires it. ChatView is only the pane
 * host — a record or composer of its own never ships — so a test that
 * rendered it bare exercised a surface the app never showed. Inspector
 * props go to ChatView; everything else is the pane column's.
 */
export function PaneChatView({ multiPane: overrides, ...props }: PaneChatViewProps) {
  const {
    taskTitle,
    canUndoWrites,
    undoBusy,
    onUndoWrites,
    writeFileResolutions,
    writeResolvablePaths,
    writeConflictedPaths,
    writeCheckpointFiles,
    onKeepWriteFile,
    onDiscardWriteFile,
    onKeepAllWrites,
    resolveBlockedReason,
    loadError,
    paneCount,
    onPaneCapacityChange,
    openChangesRequest,
    openChangesScope,
    onOpenChangesRequestHandled,
    ...column
  } = props
  const pane: ChatPane = {
    paneId: PANE_ID,
    workspacePath: column.workspacePath ?? '',
    runId: column.activeRunId
  }
  const multiPane: MultiPane = {
    panes: [pane],
    focusedPaneId: pane.paneId,
    sizes: [1],
    onFocusPane: () => {},
    onClosePane: () => {},
    onSizesChange: () => {},
    onSessionDrop: () => false,
    getPaneTitle: () => 'Task',
    renderPane: (_pane, options) => (
      <SessionChatColumn
        {...column}
        showPageHeading={false}
        approvalAutoFocus={options.focused}
        onShowInspector={options.onShowInspector}
        onOpenChanges={options.onOpenChanges}
        onOpenWorkspaceFile={options.onOpenWorkspaceFile}
        runActions={{
          ...column.runActions,
          onSplit: options.onSplit,
          onClosePane: options.multi ? options.onClose : undefined
        }}
      />
    ),
    ...overrides
  }
  return (
    <ChatView
      items={column.items}
      itemsStore={column.itemsStore}
      running={column.running}
      invokeId={column.invokeId}
      pendingRun={column.pendingRun}
      workspacePath={column.workspacePath}
      activeRunId={column.activeRunId}
      headingRef={column.headingRef}
      onSend={column.onSend}
      onStop={column.onStop}
      taskTitle={taskTitle}
      canUndoWrites={canUndoWrites}
      undoBusy={undoBusy}
      onUndoWrites={onUndoWrites}
      writeFileResolutions={writeFileResolutions}
      writeResolvablePaths={writeResolvablePaths}
      writeConflictedPaths={writeConflictedPaths}
      writeCheckpointFiles={writeCheckpointFiles}
      onKeepWriteFile={onKeepWriteFile}
      onDiscardWriteFile={onDiscardWriteFile}
      onKeepAllWrites={onKeepAllWrites}
      resolveBlockedReason={resolveBlockedReason}
      loadError={loadError}
      paneCount={paneCount}
      onPaneCapacityChange={onPaneCapacityChange}
      openChangesRequest={openChangesRequest}
      openChangesScope={openChangesScope}
      onOpenChangesRequestHandled={onOpenChangesRequestHandled}
      multiPane={multiPane}
    />
  )
}
