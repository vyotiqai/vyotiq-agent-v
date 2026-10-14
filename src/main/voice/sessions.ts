/**
 * Live voice sessions by window (docs/voice-mode.md §11): one per sender,
 * closed when its window goes away and on quit. The IPC handlers stay thin;
 * everything stateful is here and in `VoiceSession`.
 */
import { getSettings } from '../settings/settings'
import { logger } from '../../shared/logger'
import { DEFAULT_VOICE_SETTINGS, type VoiceEvent } from '../../shared/ipc/schemas/voice'
import { readVoiceSourceKey, voiceKeyAvailability } from './keys'
import { VoiceError } from './errors'
import { sttProvider, ttsProvider } from './providers/registry'
import { VoiceSession } from './session'
import { addRunEventTap } from '../agent/runEventTap'
import { listPendingToolApprovals, resolveToolApproval, watchToolApprovals } from '../agent/toolApproval'
import { listPendingAgentQuestions, resolveAgentQuestion, watchAgentQuestions } from '../agent/agentQuestion'
import { getRunWorkspace } from '../agent/runRegistry'
import { setVoiceReplyWorkspace } from './voiceReply'
import { notifyBadgeChange } from '../app/badges'
import {
  clampSpeed,
  resolveModel,
  resolveTtsProvider,
  ttsEntry,
  type VoiceErrorCode
} from '../../shared/voice'
import type { VoiceSettings } from '../../shared/ipc/schemas/voice'
import type { TtsStream } from './providers/types'

function currentVoiceSettings(): VoiceSettings {
  return { ...DEFAULT_VOICE_SETTINGS, ...getSettings().voice }
}

/**
 * A speaking stream for one piece of a session's reply, with the person's
 * provider, voice and speed; audio goes straight to the window. Null when
 * no speaking provider has a key.
 */
function openSessionTts(
  owner: Owner,
  audioChannel: string,
  contextId: string,
  onError: (code: VoiceErrorCode) => void
): TtsStream | null {
  const settings = currentVoiceSettings()
  const resolved = resolveTtsProvider(settings.ttsProvider, voiceKeyAvailability())
  if (!resolved.ok) {
    onError('no_key')
    return null
  }
  const entry = ttsEntry(resolved.id)
  const apiKey = entry.key.kind === 'none' ? '' : readVoiceSourceKey(entry.key)
  if (apiKey === null) {
    onError('no_key')
    return null
  }
  let seq = 0
  return ttsProvider(entry.id).stream({
    apiKey,
    model: resolveModel(entry.models, settings.tts[entry.id]?.model),
    voiceId: settings.tts[entry.id]?.voiceId ?? entry.defaultVoice.id,
    speed: clampSpeed(settings.speed, entry.caps.speed),
    contextId,
    signal: new AbortController().signal,
    onAudio: (chunk) => {
      if (!owner.isDestroyed()) {
        owner.send(audioChannel, { utteranceId: contextId, seq: seq++, sampleRate: chunk.sampleRate, pcm: chunk.pcm })
      }
    },
    onError
  })
}

type NavigationDetails = { isMainFrame: boolean; isSameDocument: boolean }
type Owner = {
  id: number
  isDestroyed(): boolean
  send(channel: string, payload: unknown): void
  once?(ev: 'destroyed', fn: () => void): unknown
  on?(ev: 'did-start-navigation', fn: (details: NavigationDetails) => void): unknown
  off?(ev: 'did-start-navigation', fn: (details: NavigationDetails) => void): unknown
}

const sessions = new Map<string, { session: VoiceSession; owner: Owner }>()
const navigationListeners = new Map<string, () => void>()
const byOwner = new Map<number, string>()

export type VoiceChannels = { events: string; audio: string }

export async function startVoiceSession(
  owner: Owner,
  channels: VoiceChannels,
  keyterms: readonly string[],
  workspacePath: string | null = null
): Promise<string> {
  // One session per window: starting again replaces the old one.
  const previous = byOwner.get(owner.id)
  if (previous) await stopVoiceSession(previous)
  const session = new VoiceSession({
    emit: (event: VoiceEvent) => {
      if (!owner.isDestroyed()) owner.send(channels.events, event)
      // The taskbar/dock and the tray say the mic is on, even with the window hidden (§13.8).
      if (event.kind === 'state') notifyBadgeChange()
    },
    settings: currentVoiceSettings,
    keys: () => voiceKeyAvailability(),
    readKey: (source) => {
      if (source.kind === 'none') return ''
      const key = readVoiceSourceKey(source)
      if (!key) throw new VoiceError('no_key', 'No key for the listener')
      return key
    },
    sttProvider,
    keyterms,
    openTts: (contextId, onError) => openSessionTts(owner, channels.audio, contextId, onError),
    tapRun: addRunEventTap,
    watchApprovals: watchToolApprovals,
    resolveApproval: (answer) => resolveToolApproval(answer),
    watchQuestions: watchAgentQuestions,
    pendingApprovals: listPendingToolApprovals,
    pendingQuestions: listPendingAgentQuestions,
    resolveQuestion: (answer) => resolveAgentQuestion(answer),
    logLatency: (t) => logger.info('Voice turn latency', { scope: 'voice', ...t })
  })
  sessions.set(session.id, { session, owner })
  byOwner.set(owner.id, session.id)
  owner.once?.('destroyed', () => void stopVoiceSession(session.id))
  // A reload or navigation drops the window's mic and bar: end the session
  // too, or the tray and taskbar would keep saying "listening" (D-41).
  const onNavigate = (details: NavigationDetails): void => {
    if (!details.isMainFrame || details.isSameDocument) return
    owner.off?.('did-start-navigation', onNavigate)
    void stopVoiceSession(session.id)
  }
  owner.on?.('did-start-navigation', onNavigate)
  navigationListeners.set(session.id, () => owner.off?.('did-start-navigation', onNavigate))
  // While it's open, replies in this workspace are written to be heard.
  setVoiceReplyWorkspace(session.id, workspacePath)
  await session.start()
  return session.id
}

/**
 * Follow a run with this window's session. A task started by voice in a new
 * worktree runs in a folder the session didn't open on: from then on, replies
 * there are written to be heard too (D-30).
 */
export function followVoiceRun(ownerId: number, sessionId: string, runId: string): void {
  const session = voiceSessionFor(ownerId, sessionId)
  if (!session) return
  const workspace = getRunWorkspace(runId)
  if (workspace) setVoiceReplyWorkspace(sessionId, workspace)
  session.follow(runId)
}

/**
 * A session has the mic open somewhere (any window, muted or not: the
 * capture is still running). Off and error don't count.
 */
export function isVoiceListening(): boolean {
  for (const { session } of sessions.values()) {
    if (session.state !== 'off' && session.state !== 'error') return true
  }
  return false
}

/** The session, but only for the window that owns it. */
export function voiceSessionFor(ownerId: number, sessionId: string): VoiceSession | null {
  const entry = sessions.get(sessionId)
  return entry && entry.owner.id === ownerId ? entry.session : null
}

export async function stopVoiceSession(sessionId: string): Promise<void> {
  const entry = sessions.get(sessionId)
  if (!entry) return
  sessions.delete(sessionId)
  navigationListeners.get(sessionId)?.()
  navigationListeners.delete(sessionId)
  setVoiceReplyWorkspace(sessionId, null)
  if (byOwner.get(entry.owner.id) === sessionId) byOwner.delete(entry.owner.id)
  await entry.session.stop()
  notifyBadgeChange()
}

export async function stopAllVoiceSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopVoiceSession(id)))
}
