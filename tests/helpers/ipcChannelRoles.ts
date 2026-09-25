import { IPC } from '@shared/channels'

/**
 * One source of truth for which IPC channels are NOT renderer-invoked.
 *
 * Two suites need this, and they used to keep separate hand-written copies
 * that had already drifted apart by three entries: `ipcContract` (preload
 * surface) and `ipcChannelParity` (main-process handler coverage). Adding a
 * channel meant editing both, and forgetting one silently weakened a check.
 */
export type IpcChannelName = keyof typeof IPC

/** Channels the preload exposes as `onX` subscriptions (main → renderer). */
export const PUSH_CHANNEL_NAMES = [
  'chatEvent',
  'toolApprovalRequest',
  'agentQuestionRequest',
  'windowMaximizedChanged',
  'windowFocusChanged',
  'themeChanged',
  'browserState',
  'ptyData',
  'ptyExit',
  'ptySessionsChanged',
  'codeIndexStatusEvent',
  'dictationStatusEvent',
  'githubAuthStatusEvent',
  'skillsChanged',
  'notificationsChanged',
  'notificationsActivate',
  'appearanceCustomCssChanged',
  'updaterState',
  'accessibilitySupportChanged',
  'gitStatusChanged',
  'agentContextChanged',
  'deepLinkOpened'
] as const satisfies readonly IpcChannelName[]

/**
 * Channels with no `ipcMain` registration in `src/main/ipc/register.ts` for a
 * reason other than being a preload push subscription. Each needs its own
 * justification, or it is simply a missing handler:
 *
 * - `workspaceEditorFlushRequest` — main → renderer ask; the renderer answers
 *   on the response channel instead of a handler replying here.
 * - `workspaceEditorFlushResponse` — handled by `ipcMain.on` in
 *   `src/main/index.ts`, which the parity scan does not read.
 * - `toolsCatalogChanged` — main → renderer push delivered outside the
 *   preload `onX` surface.
 */
export const UNHANDLED_NON_PUSH_CHANNEL_NAMES = [
  'workspaceEditorFlushRequest',
  'workspaceEditorFlushResponse',
  'toolsCatalogChanged'
] as const satisfies readonly IpcChannelName[]

/** Channel names that must never have a handler in register.ts. */
export const PUSH_ONLY_CHANNEL_NAMES: ReadonlySet<IpcChannelName> = new Set<IpcChannelName>([
  ...PUSH_CHANNEL_NAMES,
  ...UNHANDLED_NON_PUSH_CHANNEL_NAMES
])

/** The wire values of the preload push subscriptions. */
export const PUSH_CHANNELS: ReadonlySet<string> = new Set(
  PUSH_CHANNEL_NAMES.map((name) => IPC[name])
)
