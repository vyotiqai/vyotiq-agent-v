/**
 * The app's actions, wired to the real app: the workspaces, the task lists,
 * the main window, settings and the system shell. See runner.ts.
 */
import { app, shell } from 'electron'
import { getWorkspaces } from '../workspace/workspaces'
import { listRuns, loadStatus } from '../agent/state'
import {
  cancelRun,
  enqueueFollowUp,
  followUpPreview,
  getRunInvokeId,
  getRunWorkspace,
  isActive,
  listActiveRuns,
  peekFollowUps,
  waitUntilRunInactive
} from '../agent/runRegistry'
import { launchRun, launchRunSync } from '../agent/launchRun'
import { syncFollowUpsToDisk } from '../agent/followUpStore'
import { getChatEventDispatcher } from '../ipc/streamBatch'
import { resolveRunDir } from '../storage/paths'
import { logger } from '../../shared/logger'
import { IPC } from '../../shared/channels'
import type { AgentEvent, ChatMessage } from '../../shared/ipc'
import type { WebContents } from 'electron'
import { enqueueSettingsMutation, getSettings, setSettings } from '../settings/settings'
import { applyWindowChrome, getMainWindow } from '../app/window'
import type { Settings } from '../../shared/ipc'
import { contextAtHome, runAppAction, type AppActionContext, type AppActionResult, type AppControlDeps } from './runner'
import { basename } from 'path'
import { listPendingToolApprovals } from '../agent/toolApproval'
import { listPendingAgentQuestions } from '../agent/agentQuestion'
import { readWorkspaceRules } from '../agent/context/rules'
import { memoryNoteDetails } from '../agent/context/memory'
import { checkForAppUpdates, updaterState } from '../updater'
import { formatAppContext, readGitBranch, ruleHeadline, type AppSnapshot, type AppTaskState } from '../voice/appContext'
import { DEFAULT_VOICE_SETTINGS } from '../../shared/ipc/schemas/voice'
import { chooseModel, resolveTtsProvider, ttsEntry } from '../../shared/voice'
import { voiceKeyAvailability } from '../voice/keys'
import { speechModelRefusedSpeed } from '../voice/providers/tts/openaiSpeech'
import { voiceLinkForRun } from './voiceLink'
import { onSpokenTurnState } from '../voice/voiceReply'
import { settingsChangedSince } from './setByAgent'

export { settleWindowAction, setWindowActionChannel, type AppActionResult, type AppActionContext } from './runner'

const appDeps: AppControlDeps = {
  openWorkspaces: () => getWorkspaces().openPaths,
  activeWorkspace: () => getWorkspaces().activePath,
  listTasks: async (workspacePath) => {
    const { runs } = await listRuns(workspacePath)
    return runs.map((r) => ({ runId: r.runId, title: (r.goal ?? '').split('\n')[0]!.trim(), status: r.status }))
  },
  window: () => getMainWindow()?.webContents ?? null,
  cancelRun: (runId) => cancelRun(runId),
  runActive: (runId) => isActive(runId),
  startTask: (workspacePath, message, wc) => {
    const outcome = launchRunSync({ workspacePath, messages: [message], wc, source: 'app-control' })
    return outcome.ok ? { ok: true, runId: outcome.runId } : { ok: false, error: outcome.error }
  },
  sendToTask: (workspacePath, runId, message, wc) => sendToTask(workspacePath, runId, message, wc),
  patchSettings: async (patch) => {
    const next = await enqueueSettingsMutation(() => setSettings(patch as Partial<Settings>))
    if (patch.theme !== undefined || patch.skinId !== undefined) applyWindowChrome(next.theme, next.skinId)
  },
  settings: () => getSettings(),
  status: (ctx) => appStatus(ctx.runId ?? null, ctx.workspacePath ?? null),
  voiceControls: (runId) => voiceLinkForRun(runId)?.controls ?? null,
  speedIgnored: () => {
    const voice = { ...DEFAULT_VOICE_SETTINGS, ...getSettings().voice }
    const speaking = resolveTtsProvider(voice.ttsProvider, voiceKeyAvailability())
    if (!speaking.ok) return false
    const entry = ttsEntry(speaking.id)
    return speechModelRefusedSpeed(chooseModel(entry, voice.tts[entry.id]?.model))
  },
  checkUpdate: async () => {
    if (!app.isPackaged) return { checked: false }
    const info = await checkForAppUpdates({ force: true })
    const state = updaterState()
    return { checked: true, version: info?.version ?? null, ...(state.status === 'error' && state.error ? { error: state.error } : {}) }
  },
  openPath: (path) => shell.openPath(path),
  revealPath: (path) => shell.showItemInFolder(path),
  openExternal: (url) => shell.openExternal(url),
  quit: () => app.quit()
}

export function runAppActionInApp(name: string, args: unknown, ctx: AppActionContext): Promise<AppActionResult> {
  return runAppAction(appDeps, name, args, contextAtHome(ctx, ctx.runId ? getRunWorkspace(ctx.runId) : undefined))
}

/**
 * More work for a task, as its composer would send it: queued on a running
 * run (chat:followUp's path, so the window's queue shows it), else the run
 * goes again with the message appended to its saved history.
 */
async function sendToTask(
  workspacePath: string,
  runId: string,
  message: ChatMessage,
  wc: WebContents
): Promise<{ ok: true; queued: boolean } | { ok: false; error: string }> {
  if (isActive(runId)) {
    const queued = enqueueFollowUp(runId, message)
    if (queued.ok) {
      syncFollowUpsToDisk(resolveRunDir(workspacePath, runId), runId)
      getChatEventDispatcher().flush(runId)
      const invokeId = getRunInvokeId(runId)
      wc.send(IPC.chatEvent, {
        type: 'follow_up_queued',
        runId,
        id: queued.id,
        position: queued.position,
        queueLength: queued.queueLength,
        preview: followUpPreview(message),
        ...(invokeId != null ? { invokeId } : {})
      } satisfies AgentEvent)
      logger.info('Chat follow-up queued', { scope: 'app-control', correlationId: runId, queueLength: queued.queueLength })
      return { ok: true, queued: true }
    }
    // Finishing its turn: wait it out and send it as a new turn instead.
    if (queued.error !== 'Run is finishing') return { ok: false, error: queued.error }
    await waitUntilRunInactive(runId)
  }
  // Everything on disk counts as already sent: the message is appended after it.
  const outcome = await launchRun({
    workspacePath,
    runId,
    newMessages: [message],
    incremental: true,
    persistedMessageCount: Number.MAX_SAFE_INTEGER,
    wc,
    source: 'app-control'
  })
  return outcome.ok ? { ok: true, queued: false } : { ok: false, error: outcome.error }
}

const APPROVAL_WORDS: Readonly<Record<'off' | 'mutating' | 'all', string>> = {
  off: 'off (the agent runs tools without asking)',
  mutating: 'on for anything that changes things',
  all: 'on for every tool'
}

/**
 * A run's state for app_status: running only while this app runs it (its
 * status file can say "running" long after; run fb8b6636 still did at
 * 03:06:17 on 2026-10-16, after its cancel), stopped on the user when an
 * approval or a question waits.
 */
function runState(runId: string, workspacePath: string): { title: string; state: AppTaskState } | null {
  const status = loadStatus(resolveRunDir(workspacePath, runId))
  if (!status) return null
  const title = (status.goal ?? '').split('\n')[0]!.trim() || 'Untitled task'
  if (!isActive(runId)) return { title, state: status.status === 'running' ? 'cancelled' : status.status }
  const waiting = listPendingToolApprovals(runId).length > 0 || listPendingAgentQuestions(runId).length > 0
  return { title, state: waiting ? 'waiting' : 'running' }
}

/**
 * The app as it is now, for app_status (src/main/voice/appContext.ts). Each
 * part is read on its own: one that fails is left out, never the whole picture.
 */
// Each step of a spoken turn is given the app as it is (§27): the agent can't answer from a stale memory.
onSpokenTurnState((runId, workspacePath) => appStatus(runId, workspacePath))

export async function appStatus(runId: string | null, workspaceHint: string | null): Promise<string> {
  const settings = getSettings()
  const workspacePath = (runId ? getRunWorkspace(runId) : undefined) ?? workspaceHint ?? getWorkspaces().activePath ?? null
  const voiceSession = voiceLinkForRun(runId)
  const voice = { ...DEFAULT_VOICE_SETTINGS, ...settings.voice }
  const update = updaterState()
  const branch = workspacePath ? readGitBranch(workspacePath) : undefined
  const snapshot: AppSnapshot = {
    now: new Date(),
    ...(voiceSession?.screen ? { screen: voiceSession.screen } : {}),
    workspace: workspacePath ? { name: basename(workspacePath), ...(branch ? { branch } : {}) } : null,
    task: null,
    others: [],
    settings: {
      ...(settings.model ? { model: settings.model } : {}),
      ...(settings.toolApproval?.mode ? { approvals: APPROVAL_WORDS[settings.toolApproval.mode] } : {}),
      ...(settings.theme ? { theme: settings.theme } : {})
    },
    voice: voiceSession ? { placement: voice.placement, speed: voice.speed, look: voice.orbLook, style: voice.style, ...(voiceSession.muted ? { muted: voiceSession.muted } : {}) } : null,
    changedSince: settingsChangedSince(runId, settings),
    update: { status: update.status, ...(update.info?.version ? { version: update.info.version } : {}) },
    rules: [],
    memory: []
  }
  try {
    if (runId && workspacePath) {
      snapshot.task = runState(runId, workspacePath)
      snapshot.queued = peekFollowUps(runId).length
    }
    for (const run of listActiveRuns()) {
      if (run.runId === runId) continue
      const state = runState(run.runId, run.workspacePath)
      if (state && (state.state === 'running' || state.state === 'waiting')) {
        snapshot.others.push({ title: state.title, workspace: basename(run.workspacePath), state: state.state })
      }
    }
  } catch (err) {
    logger.warn('App status could not read the tasks', { scope: 'app-control', reason: err instanceof Error ? err.message : String(err) })
  }
  if (workspacePath) {
    const [rules, memory] = await Promise.allSettled([readWorkspaceRules(workspacePath), memoryNoteDetails(workspacePath)])
    if (rules.status === 'fulfilled') snapshot.rules = rules.value.map((r) => ruleHeadline(r.path, r.content))
    if (memory.status === 'fulfilled') snapshot.memory = memory.value.map((n) => n.title || basename(n.path)).filter(Boolean)
  }
  return formatAppContext(snapshot)
}
