/**
 * Live voice sessions by window (docs/voice-mode.md §11): one per sender,
 * closed when its window goes away and on quit. The IPC handlers stay thin;
 * everything stateful is here and in `VoiceSession`.
 */
import { getSettings } from '../settings/settings'
import { logger } from '../../shared/logger'
import { DEFAULT_VOICE_SETTINGS, VoiceEventSchema, type VoiceEvent } from '../../shared/ipc/schemas/voice'
import { readVoiceSourceKey, voiceKeyAvailability } from './keys'
import { VoiceError } from './errors'
import { sttProvider, ttsProvider } from './providers/registry'
import { cachedModelVoices, prepareVoiceModels } from './modelCatalog'
import { VoiceSession } from './session'
import { addRunEventTap } from '../agent/runEventTap'
import { listPendingToolApprovals, resolveToolApproval, watchToolApprovals } from '../agent/toolApproval'
import { listPendingAgentQuestions, resolveAgentQuestion, watchAgentQuestions } from '../agent/agentQuestion'
import { cancelRun, getRunWorkspace } from '../agent/runRegistry'
import { onSpokenTurnStarted, setVoiceFollowedRun, setVoiceReplyWorkspace, voiceSessionsOn } from './voiceReply'
import type { AppActionResult } from '../appControl'
import { setVoiceLink } from '../appControl/voiceLink'
import { enqueueSettingsMutation, onSettingsWritten, setSettings } from '../settings/settings'
import { VoiceConversationLog } from './conversationLog'
import { userDataRoot, workspaceUsageDir } from '../storage/paths'
import { join } from 'path'
import { notifyBadgeChange } from '../app/badges'
import {
  chooseModel,
  clampSpeed,
  pickVoice,
  resolveSttProvider,
  resolveTtsProvider,
  ttsEntry,
  type VoiceErrorCode
} from '../../shared/voice'
import type { VoiceScreen, VoiceSettings } from '../../shared/ipc/schemas/voice'
import type { TtsStream } from './providers/types'

function currentVoiceSettings(): VoiceSettings {
  return { ...DEFAULT_VOICE_SETTINGS, ...getSettings().voice }
}

/**
 * Open the connection a turn's requests will use before they're made (B11):
 * measured 2026-10-14, a cold connection to OpenRouter took ~550 ms and one
 * idle past Node's 4 s keep-alive ~100 ms more than a warm one. An
 * unauthenticated request: no key leaves, nothing is billed. Through the
 * global fetch, so the app's proxy applies.
 */
export function warmVoiceConnections(settings: VoiceSettings, fetchImpl: typeof fetch = fetch): void {
  const keys = voiceKeyAvailability()
  const listener = resolveSttProvider(settings.sttProvider, keys)
  const speaker = resolveTtsProvider(settings.ttsProvider, keys)
  const usesOpenRouter = (listener.ok && listener.id === 'openrouter') || (speaker.ok && speaker.id === 'openrouter')
  if (!usesOpenRouter) return
  void fetchImpl('https://openrouter.ai/api/v1/key', { method: 'HEAD', signal: AbortSignal.timeout(5000) }).catch(() => {})
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
  onError: (code: VoiceErrorCode, message: string) => void,
  onEnd?: (heard: boolean) => void
): TtsStream | null {
  const settings = currentVoiceSettings()
  const resolved = resolveTtsProvider(settings.ttsProvider, voiceKeyAvailability())
  if (!resolved.ok) {
    onError('no_key', 'No speaking provider has a key')
    return null
  }
  const entry = ttsEntry(resolved.id)
  const apiKey = entry.key.kind === 'none' ? '' : readVoiceSourceKey(entry.key)
  if (apiKey === null) {
    onError('no_key', `No ${entry.label} key`)
    return null
  }
  let seq = 0
  let rate = 24000
  const model = chooseModel(entry, settings.tts[entry.id]?.model)
  const stream = ttsProvider(entry.id).stream({
    apiKey,
    model,
    // Only a voice this model takes (A-06).
    voiceId: pickVoice(cachedModelVoices(entry.id, model), settings.tts[entry.id]?.voiceId, entry.defaultVoice.id),
    speed: clampSpeed(settings.speed, entry.caps.speed),
    contextId,
    signal: new AbortController().signal,
    onAudio: (chunk) => {
      rate = chunk.sampleRate
      if (!owner.isDestroyed()) {
        owner.send(audioChannel, {
          utteranceId: contextId,
          seq: seq++,
          sampleRate: chunk.sampleRate,
          pcm: chunk.pcm,
          ...(chunk.piece !== undefined ? { piece: chunk.piece } : {})
        })
      }
    },
    onError
  })
  // All of this reply's speech has been sent (or it was stopped): the window may call it drained (B9).
  void stream.done().then(
    () => {
      const heard = seq > 0
      if (!owner.isDestroyed()) {
        owner.send(audioChannel, { utteranceId: contextId, seq: seq++, sampleRate: rate, pcm: new Int16Array(0), last: true })
      }
      onEnd?.(heard)
    },
    () => onEnd?.(seq > 0)
  )
  return stream
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

/**
 * What a session did, for vyotiq.log (A-07): who listens and speaks, and
 * every failure with its code and the provider's reason. Never what was said.
 */
function logVoiceEvent(event: VoiceEvent): void {
  if (event.kind === 'engine') {
    const notes = [
      `speaks with ${event.tts ?? 'nothing'}`,
      event.sttFellBackFrom ? `no ${event.sttFellBackFrom} key` : '',
      event.ttsFellBackFrom ? `no ${event.ttsFellBackFrom} key` : ''
    ]
    logger.info('Voice session listening', { scope: 'voice', provider: event.stt, reason: notes.filter(Boolean).join('; ') })
  } else if (event.kind === 'error') {
    logger.warn('Voice problem', { scope: 'voice', kind: event.side ?? 'session', code: event.code, reason: event.detail ?? '' })
  } else if (event.kind === 'reconnecting') {
    logger.info('Voice listener reconnecting', { scope: 'voice', attempt: event.attempt })
  }
}

/**
 * Whether the window will take this event. The preload drops one that fails
 * its schema, and the renderer's console never reaches vyotiq.log, so check
 * here and log it where it can be found (A-18).
 */
export function voiceEventPasses(event: VoiceEvent): boolean {
  const parsed = VoiceEventSchema.safeParse(event)
  if (parsed.success) return true
  const issue = parsed.error.issues[0]
  logger.warn('Voice event failed its schema', {
    scope: 'voice',
    kind: event.kind,
    reason: issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'
  })
  return false
}

const sessions = new Map<string, { session: VoiceSession; owner: Owner; log: VoiceConversationLog | null }>()

/**
 * A run main started with words said out loud: the session that sent them
 * follows it at once, never waiting on the window (§27).
 */
onSpokenTurnStarted((runId, workspacePath) => {
  for (const id of voiceSessionsOn(workspacePath)) {
    const entry = sessions.get(id)
    if (!entry || !entry.session.spokenRunStarted(runId)) continue
    setVoiceFollowedRun(id, runId)
    logger.info('Voice follows the run its turn started', { scope: 'voice', correlationId: runId })
    return
  }
})

/**
 * The agent's app_control reaches voice mode through this (§27): the voice's
 * own controls, the screen and mute, for the session following its run, else
 * any live one.
 */
setVoiceLink({
  forRun: (runId) => {
    for (const { session } of sessions.values()) if (session.state !== 'off' && session.followedRunId === runId) return session.link
    return null
  },
  any: () => {
    for (const { session } of sessions.values()) if (session.state !== 'off' && session.state !== 'error') return session.link
    return null
  }
})
/** Voice settings changed (Settings, Voice, or the agent's set_voice_options): live sessions take them now. */
onSettingsWritten((next, prev) => {
  if (JSON.stringify(next.voice ?? null) === JSON.stringify(prev.voice ?? null)) return
  for (const { session } of sessions.values()) session.settingsChanged()
})
const byOwner = new Map<number, string>()
const navigationListeners = new Map<string, () => void>()
/** Windows whose close already ends their session: one hook per window, not one per start. */
const watchedOwners = new Set<number>()

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
  // The conversation is kept beside the workspace's tasks (§24.8); its id is known once the session is.
  let log: VoiceConversationLog | null = null
  const session = new VoiceSession({
    emit: (event: VoiceEvent) => {
      if (!owner.isDestroyed() && voiceEventPasses(event)) owner.send(channels.events, event)
      // The taskbar/dock and the tray say the mic is on, even with the window hidden (§13.8).
      if (event.kind === 'state') notifyBadgeChange()
      logVoiceEvent(event)
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
    openTts: (contextId, onError, onEnd) => openSessionTts(owner, channels.audio, contextId, onError, onEnd),
    onUnheard: () => logger.warn('Voice reply ended without any audio', { scope: 'voice', code: 'VOICE_UNHEARD' }),
    tapRun: addRunEventTap,
    watchApprovals: watchToolApprovals,
    resolveApproval: (answer) => resolveToolApproval(answer),
    // A spoken stop cancels the run here, as chat:cancel does (cancelRun also clears its queued follow-ups).
    cancelRun: (runId) => {
      const stopped = cancelRun(runId)
      if (stopped) logger.info('Chat cancel', { scope: 'voice', correlationId: runId })
      return stopped
    },
    watchQuestions: watchAgentQuestions,
    resolveQuestion: (answer) => resolveAgentQuestion(answer),
    pendingAsks: (runId) => ({ approvals: listPendingToolApprovals(runId), questions: listPendingAgentQuestions(runId) }),
    // `provider`, not `listener`: log fields pass an allowlist, and an unknown string key is dropped (A-19).
    logLatency: ({ listener, ...t }) => logger.info('Voice turn latency', { scope: 'voice', provider: listener ?? 'none', ...t }),
    onStandbyHeard: (what, chars) => logger.info('Voice heard words while waiting to be called', { scope: 'voice', reason: what, chars }),
    onTurnDropped: (reason, chars, stats) =>
      logger.info('Voice heard speech but took no turn', { scope: 'voice', reason, chars, ...stats }),
    warm: () => warmVoiceConnections(currentVoiceSettings()),
    setVoiceName: (name) => setVoiceByName(name),
    record: (entry) => log?.add(entry)
  })
  log = openConversationLog(session.id, workspacePath)
  sessions.set(session.id, { session, owner, log })
  byOwner.set(owner.id, session.id)
  if (owner.once && !watchedOwners.has(owner.id)) {
    watchedOwners.add(owner.id)
    owner.once('destroyed', () => {
      watchedOwners.delete(owner.id)
      const id = byOwner.get(owner.id)
      if (id) void stopVoiceSession(id)
    })
  }
  // A reload throws away the window's half of the session: it would stay listening in the tray with no bar (D-41).
  const onNavigate = (details: NavigationDetails): void => {
    if (!details.isMainFrame || details.isSameDocument) return
    owner.off?.('did-start-navigation', onNavigate)
    void stopVoiceSession(session.id)
  }
  owner.on?.('did-start-navigation', onNavigate)
  navigationListeners.set(session.id, () => owner.off?.('did-start-navigation', onNavigate))
  // While it's open, replies in this workspace are written to be heard.
  setVoiceReplyWorkspace(session.id, workspacePath)
  // The speaking model's voices, fetched alongside: the first reply is seconds away, the mic is open now.
  const speaking = resolveTtsProvider(currentVoiceSettings().ttsProvider, voiceKeyAvailability())
  if (speaking.ok) void prepareVoiceModels(speaking.id)
  await session.start()
  return session.id
}

/** "Nova", "the Nova voice": the listed voice it names, exactly or in part; none for a name that's only "voice". */
export function pickVoiceByName(voices: readonly string[], name: string): string | undefined {
  const want = name.trim().toLowerCase().replace(/\s*voice$/, '').trim()
  // An empty name would match the first one listed.
  if (!want) return undefined
  return voices.find((v) => v.toLowerCase() === want) ?? voices.find((v) => v.toLowerCase().includes(want))
}

/**
 * "Use the Nova voice": a voice the speaking model lists, by name. Only a
 * provider whose voices are named (OpenRouter's list) can be picked by
 * voice; the others' are ids, picked in Settings.
 */
async function setVoiceByName(name: string): Promise<AppActionResult> {
  const settings = currentVoiceSettings()
  const resolved = resolveTtsProvider(settings.ttsProvider, voiceKeyAvailability())
  if (!resolved.ok) return { ok: false, message: 'Nothing can speak right now.' }
  const entry = ttsEntry(resolved.id)
  const model = chooseModel(entry, settings.tts[entry.id]?.model)
  const voices = cachedModelVoices(entry.id, model)
  if (!voices?.length) return { ok: false, message: 'Voices for this speaker are picked in Settings, under Voice.' }
  const voiceId = pickVoiceByName(voices, name)
  if (!voiceId) return { ok: false, message: `There’s no voice called ${name}. Some I have: ${voices.slice(0, 5).join(', ')}.` }
  // Read inside the write: a change made meanwhile (speed, a model) is kept.
  await enqueueSettingsMutation(() => {
    const now = currentVoiceSettings()
    return setSettings({ voice: { tts: { ...now.tts, [entry.id]: { ...now.tts[entry.id], voiceId } } } as VoiceSettings })
  })
  return { ok: true, message: `This is ${voiceId}.` }
}

/** The task this window's session is on, followed or not, and what the window shows. */
export function setVoiceTask(ownerId: number, sessionId: string, runId: string | null, workspacePath: string | null, screen?: VoiceScreen): void {
  voiceSessionFor(ownerId, sessionId)?.setTask(runId, workspacePath, screen)
}

/**
 * Follow a run with this window's session. A task started by voice in a new
 * worktree runs in a folder the session didn't open on: from then on, replies
 * there are written to be heard too (D-30).
 */
export function followVoiceRun(ownerId: number, sessionId: string, runId: string, handOffId?: string): void {
  const session = voiceSessionFor(ownerId, sessionId)
  if (!session) return
  const workspace = getRunWorkspace(runId)
  if (workspace) setVoiceReplyWorkspace(sessionId, workspace)
  // Its commits and pushes wait for a spoken yes (§27).
  setVoiceFollowedRun(sessionId, runId)
  session.follow(runId, handOffId)
}

/** Where a session's conversation is kept: the workspace's data folder, or the app's without one. */
export function voiceLogDir(workspacePath: string | null): string {
  if (workspacePath) {
    try {
      return join(workspaceUsageDir(workspacePath), 'voice')
    } catch {
      /* not a path we can key: the app's folder */
    }
  }
  return join(userDataRoot(), 'voice')
}

function openConversationLog(sessionId: string, workspacePath: string | null): VoiceConversationLog | null {
  try {
    return new VoiceConversationLog({ dir: voiceLogDir(workspacePath), sessionId })
  } catch (err) {
    logger.warn('Voice conversation could not be saved', { scope: 'voice', reason: err instanceof Error ? err.message : String(err) })
    return null
  }
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
  logger.info('Voice session ended', { scope: 'voice', status: entry.session.state })
  setVoiceReplyWorkspace(sessionId, null)
  setVoiceFollowedRun(sessionId, null)
  if (byOwner.get(entry.owner.id) === sessionId) byOwner.delete(entry.owner.id)
  await entry.session.stop()
  await entry.log?.close()
  notifyBadgeChange()
}

export async function stopAllVoiceSessions(): Promise<void> {
  await Promise.all([...sessions.keys()].map((id) => stopVoiceSession(id)))
}
