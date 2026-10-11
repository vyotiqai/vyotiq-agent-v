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
import { resolveToolApproval, watchToolApprovals } from '../agent/toolApproval'
import { resolveAgentQuestion, watchAgentQuestions } from '../agent/agentQuestion'
import { setVoiceReplyWorkspace } from './voiceReply'
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

type Owner = { id: number; isDestroyed(): boolean; send(channel: string, payload: unknown): void; once?(ev: 'destroyed', fn: () => void): unknown }

const sessions = new Map<string, { session: VoiceSession; owner: Owner }>()
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
    resolveQuestion: (answer) => resolveAgentQuestion(answer),
    logLatency: (t) => logger.info('Voice turn latency', { scope: 'voice', ...t })
  })
  sessions.set(session.id, { session, owner })
  byOwner.set(owner.id, session.id)
  owner.once?.('destroyed', () => void stopVoiceSession(session.id))
  // While it's open, replies in this workspace are written to be heard.
  setVoiceReplyWorkspace(session.id, workspacePath)
  await session.start()
  return session.id
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
  setVoiceReplyWorkspace(sessionId, null)
  if (byOwner.get(entry.owner.id) === sessionId) byOwner.delete(entry.owner.id)
  await entry.session.stop()
}

export async function stopAllVoiceSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopVoiceSession(id)))
}
