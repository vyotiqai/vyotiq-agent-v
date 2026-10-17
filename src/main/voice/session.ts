/**
 * A live voice session (docs/voice-mode.md §5, §6, §15, §27): the mic audio
 * in, a cloud (or local) listener, turn-taking, and the state the voice bar
 * shows. Voice mode is the agent (§27): each turn goes to the task word for
 * word, and the agent's own spoken reply is what you hear. Stops, approvals
 * and the agent's questions are settled here, without a model.
 *
 * Pure orchestration: the listener, keys, settings, clock and the way
 * events leave are all injected, so every behaviour is tested with the
 * fixture listener and fake timers.
 */
import { randomUUID } from 'crypto'
import {
  chooseModel,
  isRetryableVoiceError,
  resolveSttProvider,
  resolveTtsProvider,
  sttEntry,
  voiceDetail,
  type SttProviderId,
  type VoiceErrorCode,
  type VoiceKeyAvailability,
  type VoiceKeySource
} from '../../shared/voice'
import { AGENT_FLOOR_STATES, nextVoiceState, type VoiceSessionEvent, type VoiceSessionState } from '../../shared/voiceSession'
import type { AgentEvent, AgentQuestionAnswer, AgentQuestionRequest, ToolApprovalRequest } from '../../shared/ipc'
import type { VoiceEvent, VoiceHandOffFailure, VoiceScreen, VoiceSettings } from '../../shared/ipc/schemas/voice'
import { VoiceError, toVoiceError } from './errors'
import { PauseDetector } from './pauseDetector'
import type { SttEvent, SttProvider, SttSession, TtsStream, TurnListenStats } from './providers/types'
import { ReplySpeaker } from './replySpeaker'
import { EchoGuard } from './echoGuard'
import {
  afterWakeName,
  approvalAnswer,
  cleanTranscript,
  isBackchannel,
  isNoiseTranscript,
  isOtherScript,
  isStopPhrase,
  soundsUnfinished,
  toSpeakable
} from './speechText'
import type { AppActionResult } from '../appControl/runner'
import type { VoiceLinkSession } from '../appControl/voiceLink'
import { answerableByVoice, describeQuestion, questionAnswer } from './questionByVoice'
import { foldWork, newWorkLog, workAsk, workSnapshot, type WorkLog } from './work'
import type { VoiceLogEntry } from './conversationLog'

/** Reconnect waits (§15): five tries, then give up. */
export const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000] as const
/** Audio kept while reconnecting, at most (16 kHz samples): ten seconds. */
const RING_SAMPLES = 16000 * 10
/**
 * Barge-in in two steps (§6.2, D-33): the agent's voice dips the moment you
 * seem to start talking, and stops only once it's sure — this much voiced
 * audio, or words from the listener that aren't the agent's own.
 */
export const DUCK_CONFIRM_MS = 600
/** A dip that isn't confirmed by then was a cough, a click or an echo: the voice comes back. */
export const DUCK_GIVE_UP_MS = 1200
/**
 * A sound while the agent had the floor holds the voice until its turn
 * resolves. A listener that never resolves it (a streaming one that heard no
 * words) lets go this long after the sound stopped.
 */
export const HOLD_GRACE_MS = 6000
/**
 * The longest the voice holds for a sound at all. Steady noise (a fan, music,
 * a TV) never pauses, so the grace above never started and the reply waited
 * behind it for good: your words showed and nothing answered.
 */
export const HOLD_MAX_MS = 10_000
/** A bare "okay" or "yes" this soon after a question is an answer, not a backchannel. */
export const ASKED_WINDOW_MS = 60_000
/** Talk that stopped mid-thought ("Can you") waits this long for the rest before it goes to the agent. */
export const UNFINISHED_WAIT_MS = 2500
/** However long you keep talking, the words waiting for the rest go by this long after they came. */
export const UNFINISHED_MAX_MS = 20_000
/**
 * Nothing said this long after your turn went to the agent: a short line, so
 * you know it heard you. With reasoning at its lowest on a spoken turn the
 * agent's words came 2.3–3.2 s after the turn (real app, 2026-10-16 04:44);
 * at 2.5 s the line landed half a second before them. A turn that joins work
 * in progress waits for the step running now.
 */
export const ACK_MS = 4000
/** The short lines, taken in turn: the same words every time is what a machine sounds like. */
export const ACK_LINES = ['One moment.', 'Just a second.', 'Give me a moment.'] as const
/** Keep a muted listener's connection alive this often. */
const KEEPALIVE_MS = 5000
/** The view's steps refresh at most this often while a run works. */
const WORK_EMIT_MS = 120
/** The longest quit_app waits for the reply to be heard. */
const AFTER_REPLY_CAP_MS = 30_000
/** A listener whose settings changed connects again once nobody is talking; until then it checks this often. */
const RELISTEN_RETRY_MS = 1000
/** Where nobody is mid-turn, so the listener can be swapped without losing words. */
const RELISTEN_STATES: ReadonlySet<VoiceSessionState> = new Set(['listening', 'working', 'speaking', 'waiting_on_you', 'paused'])

/** What a listener is opened with: a change to any of it needs a new one. */
function listenerKey(s: VoiceSettings): string {
  return JSON.stringify([s.sttProvider, s.stt, s.language, s.endOfTurnPatience])
}
/**
 * A connection that stayed up this long counts as recovered: the next drop
 * starts the backoff afresh. One that drops sooner carries on from where the
 * last backoff was, so a listener that opens and fails at once can't loop.
 */
export const STABLE_CONNECTION_MS = 10_000

/**
 * How long one turn took, measured from the moment the listener decided you
 * had finished (docs/voice-mode.md §14). Null where a stage didn't happen.
 */
export type TurnLatency = {
  listener: SttProviderId | null
  /** Your turn reached the agent (sent and followed). */
  submitMs: number | null
  /** The first sentence of the reply was ready to speak. */
  firstTextMs: number | null
  /** The first audio started playing. */
  firstAudioMs: number
  /**
   * The stages before the transcript (B10), when the session's own detector
   * saw the pause: the quiet waited out to be sure you'd finished, the
   * listener's time from then to the words, and the whole turn from your
   * last word to the first sound.
   */
  waitMs?: number
  sttMs?: number
  totalMs?: number
} & Partial<TurnListenStats>

/** A pause older than this belongs to an earlier turn, not the one whose words just came. */
const PAUSE_MATCH_MS = 20_000
/** Turns awaiting the listener's answer, at most: more means it skipped some. */
const MAX_TURN_ENDS = 4

/** An event without its session id; the session stamps it. */
type Emitted = VoiceEvent extends infer E ? (E extends { sessionId: string } ? Omit<E, 'sessionId'> : never) : never

export type VoiceSessionDeps = {
  emit: (event: VoiceEvent) => void
  settings: () => VoiceSettings
  keys: () => VoiceKeyAvailability
  /** The key for a provider's source; throws `no_key` when missing. */
  readKey: (source: VoiceKeySource) => string
  sttProvider: (id: SttProviderId) => SttProvider
  keyterms?: readonly string[]
  /**
   * A text-to-speech stream for one spoken piece of the reply; null when no
   * speaking provider is usable (the session then stays text-only).
   */
  openTts?: (
    contextId: string,
    onError: (code: VoiceErrorCode, message: string) => void,
    /** All of its speech went out (or it failed); `heard`: any audio was sent at all. */
    onEnd?: (heard: boolean) => void
  ) => TtsStream | null
  /** A reply's speech ended without any audio: for the log. */
  onUnheard?: () => void
  /** Subscribe to a run's events (the run tap); returns the unsubscribe. */
  tapRun?: (runId: string, fn: (event: AgentEvent) => void) => () => void
  /** Approvals being asked and settled, any run (§7.5). */
  watchApprovals?: (watcher: {
    asked: (request: ToolApprovalRequest) => void
    settled: (requestId: string, runId: string) => void
  }) => () => void
  /** The agent's own questions (`ask_question`) being asked and settled, any run (§7.5). */
  watchQuestions?: (watcher: {
    asked: (request: AgentQuestionRequest) => void
    settled: (requestId: string, runId: string) => void
  }) => () => void
  /** Answer the agent's question, as its card would. */
  resolveQuestion?: (answer: { requestId: string; runId: string; answers: AgentQuestionAnswer[] }) => boolean
  /**
   * What a run is already waiting on: the watchers only see asks made after
   * the session follows it, and a run that was working when voice mode opened
   * may be stopped on one now.
   */
  pendingAsks?: (runId: string) => { approvals: ToolApprovalRequest[]; questions: AgentQuestionRequest[] }
  /** Per-turn timings, for tuning (§14). Timings only; never words. */
  logLatency?: (timings: TurnLatency) => void
  /** Words heard while waiting to be called by name: ignored, or the name that woke it (for the log). */
  onStandbyHeard?: (what: 'ignored' | 'woken' | 'woken_with_words', chars: number) => void
  /** Speak in another voice, by its name (the agent's app_control set_voice). */
  setVoiceName?: (name: string) => Promise<AppActionResult>
  /** Heard speech that wasn't taken as a turn, and why: for the log, never the words. */
  onTurnDropped?: (reason: 'empty' | 'echo' | 'noise', chars: number, stats: { speechMs?: number; sttMs?: number } & Partial<TurnListenStats>) => void
  /**
   * Open the connection the next requests will use (B11): at the start and
   * when you start talking, so the first request of a turn doesn't pay for it.
   */
  warm?: () => void
  /** Answer an approval, as the card would; `always` only where the card offers it (`voiceMayAlwaysAllow`). */
  resolveApproval?: (answer: { requestId: string; runId: string; decision: 'once' | 'deny' | 'always' }) => boolean
  /**
   * Stop a run in main, as the window's Stop does; false when it isn't running.
   * A spoken stop used to go through the task's composer, which dropped it
   * twice on 2026-10-15 while the run went on for another 70 s.
   */
  cancelRun?: (runId: string) => boolean
  /** Keep the conversation (§24.8): each turn, each reply, and what became of each request. */
  record?: (entry: VoiceLogEntry) => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  newId?: () => string
}

export class VoiceSession {
  readonly id: string
  private stateValue: VoiceSessionState = 'off'
  private stt: SttSession | null = null
  private sttId: SttProviderId | null = null
  private turnDetection = false
  /** The listener keeps a connection open (websocket); whole-turn listeners (HTTP, local) don't. */
  private listenerStreams = true
  /** When the current connection opened, for the backoff (STABLE_CONNECTION_MS). */
  private connectedAt = Number.NEGATIVE_INFINITY
  /** The listener's last reason for dropping, kept for the message if reconnecting gives up. */
  private lastDropReason = ''
  private ctrl = new AbortController()
  private readonly pause: PauseDetector
  /** The last seconds of mic audio, each piece with where it ends in all the audio so far. */
  private ring: Array<{ pcm: Int16Array; end: number }> = []
  private ringSamples = 0
  /** Samples of mic audio kept so far, in all: where each piece sits. */
  private ringTotal = 0
  /**
   * Where each turn we ended sits in that audio, until the listener answers it.
   * A connection that drops first takes the answer with it: the turn is played
   * again and ended again once back, and turns already answered aren't.
   */
  private turnEnds: number[] = []
  private attempt = 0
  private reconnectTimer: unknown = null
  /** What the listener was opened with (`listenerKey`), and the wait to open a new one once that changed. */
  private listenedWith = ''
  private relistenTimer: unknown = null
  private keepAliveTimer: unknown = null
  private pttDown = false
  /** Bumps on every (re)connect, so a stale listener's events are ignored. */
  private generation = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly reply: ReplySpeaker
  private recordedStart = false
  /**
   * Your words that sounded unfinished ("Can you"), waiting UNFINISHED_WAIT_MS
   * for the rest: more words join them, one stretch of talk is one turn (D-43).
   */
  private pendingTurn: { text: string; turnIds: string[]; timer: unknown; since: number; talking: boolean } | null = null
  /** Says a short line if nothing has been said by ACK_MS after your turn went. */
  private ackTimer: unknown = null
  private ackUses = 0
  /** The agent ended voice mode (app_control voice_end): it ends once the run's reply has been said. */
  private endWhenDone = false
  /** Done once the run's reply has been heard (quit_app): the run is still going, or its reply still playing. */
  private afterReply: Array<() => void> = []
  private afterReplyArmed = false
  private afterReplyCap: unknown = null
  /** Your turns sent to the task whose run isn't known yet, oldest first. */
  private unfollowed: string[] = []
  /** Turns whose run is followed: the window's later word on them changes nothing. */
  private followedTurns = new Set<string>()
  private untap: (() => void) | null = null
  private followedRun: string | null = null
  /** Replies whose audio has started playing and not yet drained. */
  private playing = new Set<string>()
  private speakErrorShown = false
  private unwatchApprovals: (() => void) | null = null
  /** The turn being timed, from your last word to the agent's first sound. */
  private timing: {
    endOfTurnAt: number
    followedAt?: number
    firstSayAt?: number
    pause?: { at: number; silenceMs: number }
    /** What a whole-turn listener did for it: upload length, request time, early start, retries. */
    listen?: TurnListenStats
    /** Replies opened since the turn ended: only their audio answers it. */
    replies: Set<string>
  } | null = null
  /** The detector's last pause: when, how long it waited, how much speech it ended. */
  private lastPause: { at: number; silenceMs: number; speechMs: number } | null = null
  private lastWarmAt = Number.NEGATIVE_INFINITY
  /** The followed run's approval waiting on the person, if any. */
  private approval: ToolApprovalRequest | null = null
  private unwatchQuestions: (() => void) | null = null
  /** The followed run's question waiting on the person, if any. */
  private question: AgentQuestionRequest | null = null
  /** What the agent just said, to recognise it coming back through the mic (§6.4). */
  private readonly echo = new EchoGuard()
  /** The agent's voice is dipped while we find out whether you're really talking. */
  private duck: { since: number } | null = null
  /**
   * A sound while the agent works or the voice works out an answer, with
   * nothing audible: maybe you, maybe a breath. Nothing is cut off for it
   * (B1, B2); the voice holds until the turn says which.
   */
  private overFloor = false
  private holdGraceTimer: unknown = null
  /** Lets go of a hold that has gone on too long, however noisy the room (HOLD_MAX_MS). */
  private holdMaxTimer: unknown = null
  /** What the voice or the agent said last (one reply, sentence by sentence), and when: did it ask? */
  private lastSaid: { contextId: string; text: string; at: number } | null = null
  /** Replies opened to be heard whose audio has not started yet; one that ends unheard must not strand the session. */
  private awaitingAudio = new Set<string>()
  /** Every speaking stream not yet done, the reply's and one-off lines alike: End cancels them all. */
  private liveTts = new Set<TtsStream>()
  /** The task the session is on (voice mode opened on it, or the line it moved to). */
  private taskRunId: string | null = null
  /** The task's workspace when the window named it. */
  private taskWorkspace: string | null = null
  /** What the window shows (the window says), for the agent's app_status. */
  private screen: VoiceScreen | null = null
  /** Muted until called by name ("Agent V"): it listens, and takes nothing else as a turn. */
  private standby = false
  /** The followed run's steps and result, for the voice view (§25). */
  private work: WorkLog | null = null
  private workTimer: unknown = null
  /** The last work event sent: most run events (text, usage) change nothing the view shows. */
  private workSent = ''

  constructor(private readonly deps: VoiceSessionDeps) {
    this.id = (deps.newId ?? randomUUID)()
    this.pause = new PauseDetector(deps.settings().endOfTurnPatience)
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
    this.reply = new ReplySpeaker({
      openTts: (contextId) => this.openReplyTts(contextId),
      // Only said with a stream open: audio always follows.
      say: (contextId, text) => this.said(contextId, text, 'agent', true),
      onToolStart: () => this.dispatch({ type: 'tool_start' }),
      onRunEnd: () => {
        this.dispatch({ type: 'run_done' })
        // Asked to end by the agent: its reply has been handed to the speaker; the window ends after it plays.
        if (this.endWhenDone) {
          this.endWhenDone = false
          this.emitEvent({ kind: 'end_requested' })
        }
        if (this.afterReply.length > 0) {
          this.afterReplyArmed = true
          this.runAfterReplyIfHeard()
        }
      },
      speakProgress: () => this.deps.settings().speakProgress,
      quietCue: () => this.emitEvent({ kind: 'cue' }),
      newId: deps.newId ?? randomUUID,
      now: deps.now ?? Date.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
  }

  /**
   * Do `fn` once the run's reply has been heard: quitting 1.5 s after the
   * tool returned cut off the answer, which comes 1.4–4 s later (§27.8
   * probes). Capped, so it is done even if the reply never plays.
   */
  private whenReplyHeard(fn: () => void): void {
    this.afterReply.push(fn)
    if (!this.reply.runActive) this.afterReplyArmed = true
    if (!this.afterReplyCap) this.afterReplyCap = this.setTimer(() => this.flushAfterReply(), AFTER_REPLY_CAP_MS)
    this.runAfterReplyIfHeard()
  }

  private runAfterReplyIfHeard(): void {
    if (this.afterReplyArmed && this.playing.size === 0 && this.awaitingAudio.size === 0) this.flushAfterReply()
  }

  private flushAfterReply(): void {
    if (this.afterReplyCap) this.clearTimer(this.afterReplyCap)
    this.afterReplyCap = null
    this.afterReplyArmed = false
    const due = this.afterReply.splice(0)
    for (const fn of due) fn()
  }

  /**
   * The task the session is on (voice mode opened on it, or the line it
   * moved to), even with nothing running. Null: no task yet (New task's
   * brief). `screen`: what the window shows, for the agent's app_status.
   */
  setTask(runId: string | null, workspacePath: string | null = null, screen?: VoiceScreen): void {
    if (screen !== undefined) this.screen = screen
    this.enterTask(runId, workspacePath, true)
  }

  /** `record`: keep a `task` line (a `followed` line already names the run when it was a follow). */
  private enterTask(runId: string | null, workspacePath: string | null, record: boolean): void {
    if (this.stateValue === 'off') return
    if (workspacePath) this.taskWorkspace = workspacePath
    if (runId === this.taskRunId) return
    this.taskRunId = runId
    if (runId && record) this.deps.record?.({ kind: 'task', runId })
  }

  /**
   * What the agent's app_control reaches while this session follows its run
   * (§27): voice mode's own controls, what the window shows, and whether it
   * is muted.
   */
  get link(): VoiceLinkSession {
    return {
      controls: {
        mute: (untilCalled) => {
          if (untilCalled) this.setStandby(true)
          else this.setMuted(true)
        },
        // After the run's reply has been said: ending now would cut it off.
        end: () => {
          if (this.reply.runActive) this.endWhenDone = true
          else this.emitEvent({ kind: 'end_requested' })
        },
        setVoice: (name) => this.deps.setVoiceName?.(name) ?? Promise.resolve({ ok: false, message: 'Voices can’t be changed from here.' }),
        afterReply: (runId, fn) => {
          if (runId !== this.followedRun) return false
          this.whenReplyHeard(fn)
          return true
        }
      },
      screen: this.screen,
      muted: this.standby ? 'until_called' : this.stateValue === 'paused' ? 'until_unmuted' : null,
      noteAction: (action, result) => {
        // The agent stopped the work it was doing for you: one line for it, not that and the action too.
        if (action === 'stop_task' && result.ok && result.runId === this.followedRun) this.deps.record?.({ kind: 'stop_agent', by: 'voice' })
        else this.deps.record?.({ kind: 'app_action', action, ok: result.ok, message: result.message })
      }
    }
  }

  /**
   * Main started a run with your spoken words in this session's workspace:
   * follow it now, as the oldest turn sent and not yet followed. Whether it
   * took one.
   */
  spokenRunStarted(runId: string): boolean {
    const handOffId = this.unfollowed[0]
    if (!handOffId || this.stateValue === 'off') return false
    this.follow(runId, handOffId)
    return true
  }

  /** The run this session follows, if any. */
  get followedRunId(): string | null {
    return this.followedRun
  }

  /** Something is about to be said, by the voice or the agent: captions, echo memory, timing. */
  private said(contextId: string, text: string, who: 'voice' | 'agent', audible: boolean): void {
    this.deps.record?.({ kind: who, contextId, text })
    this.echo.said(text, this.now())
    // A reply is said a sentence at a time: "Want me to check? It takes a minute." asked all the same.
    const same = this.lastSaid?.contextId === contextId ? this.lastSaid.text : ''
    this.lastSaid = { contextId, text: `${same} ${text}`.trim().slice(-400), at: this.now() }
    if (this.timing && this.timing.firstSayAt === undefined) this.timing.firstSayAt = this.now()
    // Always sent, captions or not: it is how the window learns which audio to play (A-09).
    this.emitEvent({ kind: 'say', contextId, text, audible })
  }

  /**
   * A short line of the voice's own ("Allowed.", "Got it."): spoken, captioned
   * and remembered like any other. With nothing that can speak, the session
   * moves on now instead of waiting for audio that won't come.
   */
  private sayLine(text: string): void {
    const contextId = (this.deps.newId ?? randomUUID)()
    const stream = this.openReplyTts(contextId)
    this.said(contextId, text, 'voice', stream !== null)
    if (stream) {
      stream.pushText(text)
      stream.end()
      return
    }
    this.dispatch({ type: 'reply_done', runActive: this.reply.runActive })
  }

  private openReplyTts(contextId: string): TtsStream | null {
    if (!this.deps.openTts) return null
    let opened: TtsStream | null = null
    const stream = this.deps.openTts(
      contextId,
      (code, message) => {
        // The rest of this reply goes to a new stream, not into the failed one (§15).
        this.reply.streamFailed(contextId)
        // Say it once a session: the reply is still on screen.
        if (this.speakErrorShown) return
        this.speakErrorShown = true
        this.emitError('speak', code, message)
      },
      (heard) => {
        if (opened) this.liveTts.delete(opened)
        if (!heard) this.endedUnheard(contextId)
      }
    )
    opened = stream
    if (stream) {
      this.awaitingAudio.add(contextId)
      this.liveTts.add(stream)
    }
    this.timing?.replies.add(contextId)
    return stream
  }

  /**
   * A reply's speech ended without a sound (the speaking provider failed or
   * sent nothing). The window never plays it, so it never reports it drained:
   * without this the session sat in Thinking, your words on screen and no
   * answer, until you said them again. Its captions show anyway.
   */
  private endedUnheard(contextId: string): void {
    if (!this.awaitingAudio.delete(contextId) || this.stateValue === 'off') return
    this.deps.onUnheard?.()
    if (this.playing.size > 0 || this.awaitingAudio.size > 0) return
    this.runAfterReplyIfHeard()
    if (this.stateValue === 'thinking') this.dispatch({ type: 'reply_done', runActive: this.reply.runActive })
    else if (this.stateValue === 'speaking') this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
  }

  /**
   * Follow the run the last turn was sent to: its reply is spoken. Called
   * by the renderer after each turn it sends (D-07); the same run again for a
   * follow-up just starts a new spoken turn. Without a hand-off it's a run
   * that was already working (voice mode opened on its task): followed once,
   * and whatever it is already waiting on is asked out loud.
   */
  follow(runId: string, handOffId?: string): void {
    if (this.stateValue === 'off') return
    // Already following it, and nothing new was sent: a new turn would drop a reply mid-sentence.
    if (!handOffId && this.followedRun === runId) return
    // Main followed this turn's run when it started (`spokenRunStarted`): the window says so again, later.
    if (handOffId && this.followedTurns.has(handOffId)) return
    if (handOffId) {
      this.followedTurns.add(handOffId)
      this.unfollowed = this.unfollowed.filter((id) => id !== handOffId)
      // The window learns the run here too, however it learned of it.
      this.emitEvent({ kind: 'followed', handOffId, runId })
    }
    this.deps.record?.({ kind: 'followed', runId, ...(handOffId ? { handOffId } : {}) })
    const switched = this.followedRun !== runId
    // The run it follows is the task it's on: its conversation is the voice's context.
    this.enterTask(runId, null, false)
    if (switched) {
      // What the last run waited on isn't this one's.
      this.approval = null
      this.question = null
      this.untap?.()
      this.untap = this.deps.tapRun
        ? this.deps.tapRun(runId, (ev) => {
            if (this.work) this.work = foldWork(this.work, ev, this.now())
            this.scheduleWork()
            this.reply.handle(ev)
          })
        : null
      this.followedRun = runId
      this.work = newWorkLog(runId, this.now())
      this.scheduleWork()
    }
    this.reply.beginTurn()
    if (this.timing && this.timing.followedAt === undefined) this.timing.followedAt = this.now()
    if (switched) this.catchUpAsks(runId)
  }

  /** Ask out loud what the newly followed run is already stopped on (the newest approval, else question). */
  private catchUpAsks(runId: string): void {
    const pending = this.deps.pendingAsks?.(runId)
    if (!pending) return
    const approval = pending.approvals.at(-1)
    if (approval) {
      this.onApprovalAsked(approval)
      return
    }
    const question = pending.questions.at(-1)
    if (question) this.onQuestionAsked(question)
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  /** Waiting to be called by name, or not; the window shows it. */
  private setStandby(on: boolean): void {
    if (this.standby === on) return
    this.standby = on
    this.emitEvent({ kind: 'standby', on })
  }

  /**
   * The window couldn't give your words to the task (none open, or it
   * refused the message): said so, and the session doesn't sit in Thinking
   * waiting for a run that will never start.
   */
  handOffFailed(handOffId: string, reason: VoiceHandOffFailure): void {
    if (this.stateValue === 'off') return
    // The window lost track of the run, but main follows it already: nothing failed.
    if (reason === 'unfollowed' && this.followedTurns.has(handOffId)) return
    this.unfollowed = this.unfollowed.filter((id) => id !== handOffId)
    this.stopAck()
    this.deps.record?.({ kind: 'not_sent', handOffId, reason })
    this.sayLine(HAND_OFF_FAILED_LINE[reason])
  }

  /**
   * Stop the agent's work: the followed run is cancelled here in main. Only
   * when there is none main can stop is the window asked (its task's Stop).
   */
  private stopWork(): void {
    const runId = this.followedRun
    if (runId && this.deps.cancelRun?.(runId)) return
    this.emitEvent({ kind: 'stop_agent' })
  }

  /** Steps can come many to a second: the view hears of them at most every WORK_EMIT_MS. */
  private scheduleWork(): void {
    if (this.workTimer || !this.work) return
    this.workTimer = this.setTimer(() => {
      this.workTimer = null
      if (!this.work || this.stateValue === 'off') return
      const work = workSnapshot(this.work, workAsk(this.approval, this.question, describeApproval, voiceMayAlwaysAllow))
      const sent = JSON.stringify(work)
      if (sent === this.workSent) return
      this.workSent = sent
      this.emitEvent({ kind: 'work', work })
    }, WORK_EMIT_MS)
  }

  /** The renderer's player: a reply's audio started, or everything queued for it played. */
  playback(contextId: string, phase: 'started' | 'drained'): void {
    if (phase === 'started') {
      this.awaitingAudio.delete(contextId)
      const t = this.timing
      // Only this turn's own reply times it: the last reply's audio starting late logged firstAudioMs 25 (2026-10-15 16:46:15).
      if (t?.replies.has(contextId)) {
        this.timing = null
        const at = this.now()
        this.deps.logLatency?.({
          listener: this.sttId,
          submitMs: t.followedAt !== undefined ? t.followedAt - t.endOfTurnAt : null,
          firstTextMs: t.firstSayAt !== undefined ? t.firstSayAt - t.endOfTurnAt : null,
          firstAudioMs: at - t.endOfTurnAt,
          ...(t.pause
            ? { waitMs: t.pause.silenceMs, sttMs: t.endOfTurnAt - t.pause.at, totalMs: at - (t.pause.at - t.pause.silenceMs) }
            : {}),
          ...(t.listen ?? {})
        })
      }
      this.playing.add(contextId)
      this.echo.setPlaying(true, this.now())
      this.dispatch({ type: 'audio_start' })
      this.pause.setAgentSpeaking(true)
      // It started while you may be talking: dip it until that's clear (D-33).
      if (this.overFloor) this.startDuck()
      return
    }
    if (!this.playing.delete(contextId) || this.playing.size > 0) return
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    const wasDucked = this.duck !== null
    if (wasDucked) this.endDuck()
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
    this.runAfterReplyIfHeard()
    // The agent finished while you might have been talking: if you still are, it's your turn.
    if (wasDucked && this.pause.voicedMs > 0) this.onSpeechStart()
  }

  get state(): VoiceSessionState {
    return this.stateValue
  }

  get listener(): SttProviderId | null {
    return this.sttId
  }

  /** Open the listener. Resolves once listening; a failure leaves the session in `error`. */
  async start(): Promise<void> {
    if (!this.dispatch({ type: 'start' })) return
    this.unwatchApprovals ??=
      this.deps.watchApprovals?.({
        asked: (req) => this.onApprovalAsked(req),
        settled: (requestId) => this.onApprovalSettled(requestId)
      }) ?? null
    this.unwatchQuestions ??=
      this.deps.watchQuestions?.({
        asked: (req) => this.onQuestionAsked(req),
        settled: (requestId) => this.onQuestionSettled(requestId)
      }) ?? null
    try {
      this.warmUp()
      await this.connect()
      this.dispatch({ type: 'ready' })
      // Settings changed while it opened (it read them as it began): opened again with them.
      if (!this.relistenTimer) this.relistenWhenQuiet()
    } catch (err) {
      const e = toVoiceError(err)
      this.failWith(e.code, e.message)
    }
  }

  private async connect(): Promise<void> {
    const settings = this.deps.settings()
    // What it opens with, as it begins: a change made while it opens is not one it has.
    const openedWith = listenerKey(settings)
    const resolved = resolveSttProvider(settings.sttProvider, this.deps.keys())
    if (!resolved.ok) throw new VoiceError('no_key', 'No speech-to-text provider has a key')
    const entry = sttEntry(resolved.id)
    const apiKey = this.deps.readKey(entry.key)
    const gen = ++this.generation
    this.ctrl = new AbortController()
    this.pause.setPatience(settings.endOfTurnPatience)
    const session = await this.deps.sttProvider(entry.id).open({
      apiKey,
      model: chooseModel(entry, settings.stt[entry.id]?.model),
      language: settings.language,
      patience: settings.endOfTurnPatience,
      keyterms: this.deps.keyterms,
      signal: this.ctrl.signal,
      emit: (event) => {
        if (gen === this.generation) this.onStt(event)
      }
    })
    if (gen !== this.generation || this.stateValue === 'off') {
      await session.close()
      return
    }
    this.stt = session
    this.listenedWith = openedWith
    this.sttId = entry.id
    this.turnDetection = entry.caps.turnDetection
    this.listenerStreams = entry.caps.streaming
    this.connectedAt = this.now()
    // Who speaks, too: never a silent fallback on either side (§9.5).
    const speaking = this.deps.openTts ? resolveTtsProvider(settings.ttsProvider, this.deps.keys()) : null
    if (!this.recordedStart) {
      this.recordedStart = true
      this.deps.record?.({ kind: 'start', listener: entry.id, speaker: speaking?.ok ? speaking.id : null })
    }
    this.emitEvent({
      kind: 'engine',
      stt: entry.id,
      ...(resolved.fellBackFrom ? { sttFellBackFrom: resolved.fellBackFrom } : {}),
      ...(speaking
        ? {
            tts: speaking.ok ? speaking.id : null,
            ...(speaking.ok && speaking.fellBackFrom ? { ttsFellBackFrom: speaking.fellBackFrom } : {})
          }
        : {})
    })
  }

  /**
   * Settings changed while voice mode is on. The pause it waits for applies at
   * once; the listener was opened with its provider, model, language and
   * patience, so it is opened again with the new ones once nobody is mid-turn.
   * Before, "wait longer before I'm done" (Settings, or set_voice_options) was
   * saved and said back as done, and changed nothing until voice mode restarted.
   */
  settingsChanged(): void {
    if (this.stateValue === 'off' || this.stateValue === 'error') return
    this.pause.setPatience(this.deps.settings().endOfTurnPatience)
    if (!this.relistenTimer) this.relistenWhenQuiet()
  }

  private relistenWhenQuiet(): void {
    this.relistenTimer = null
    if (!this.stt || listenerKey(this.deps.settings()) === this.listenedWith) return
    const quiet = RELISTEN_STATES.has(this.stateValue) && !this.pendingTurn && this.turnEnds.length === 0 && !this.overFloor
    if (!quiet) {
      this.relistenTimer = this.setTimer(() => this.relistenWhenQuiet(), RELISTEN_RETRY_MS)
      return
    }
    void this.relisten()
  }

  private async relisten(): Promise<void> {
    // The old listener's "closed" is ours, not a drop to reconnect from.
    this.generation++
    this.ctrl.abort()
    const stale = this.stt
    this.stt = null
    void stale?.close()
    // Audio from here on reaches no listener until the new one opens: it is given to it then.
    const from = this.ringTotal
    try {
      await this.connect()
      if (this.stateValue === 'off' || this.stateValue === 'error') return
      // What you said while it opened ("Wait longer" and straight on talking) wasn't lost.
      this.replay(from)
      // Changed again while it opened: once more, with those.
      if (!this.relistenTimer) this.relistenWhenQuiet()
    } catch (err) {
      // It couldn't open with the new settings: the same as a dropped listener, tried again and said if it gives up.
      this.lastDropReason = toVoiceError(err).message
      this.beginReconnect()
    }
  }

  /** Mic audio from the renderer. */
  pushAudio(pcm: Int16Array): void {
    const s = this.stateValue
    if (s === 'off' || s === 'connecting' || s === 'paused' || s === 'error') return
    if (s === 'reconnecting') {
      // Hold to talk: only what's said while held is kept for the replay, as when connected.
      if (this.deps.settings().pushToTalkOnly && !this.pttDown) return
      this.remember(pcm)
      // A turn you finish while it's down is ended at the same place when it's back.
      if (!this.turnDetection && !this.deps.settings().pushToTalkOnly) {
        for (const ev of this.pause.push(pcm)) if (ev.kind === 'pause' && ev.speechMs > 0) this.markTurnEnd()
      }
      return
    }
    const ptt = this.deps.settings().pushToTalkOnly
    if (ptt && !this.pttDown) return
    this.remember(pcm)
    this.stt?.pushAudio(pcm)
    for (const ev of this.pause.push(pcm)) {
      if (ev.kind === 'speech_start') {
        // As much lead-in as there is quiet since the agent last spoke: its voice isn't your words.
        this.stt?.speechStarted?.({ leadInMs: this.echo.msSinceVoice(this.now()) })
        this.warmUp()
        this.onSpeechStart()
        continue
      }
      // Probably done: a whole-turn listener starts on the words now (B10); talking again drops that.
      if (ev.kind === 'settling') {
        if (!this.turnDetection && !ptt) this.stt?.settle?.()
        continue
      }
      if (ev.kind === 'resumed') {
        this.stt?.resume?.()
        continue
      }
      this.lastPause = { at: this.now(), silenceMs: ev.silenceMs, speechMs: ev.speechMs }
      // Listeners with their own turn model decide; the rest end on our pause.
      if (!this.turnDetection && !ptt && ev.speechMs > 0) {
        this.markTurnEnd()
        this.stt?.endTurn()
      }
      // The sound stopped. If no turn comes of it, the voice lets go anyway.
      if (this.overFloor && !this.holdGraceTimer) {
        this.holdGraceTimer = this.setTimer(() => {
          this.holdGraceTimer = null
          this.endOverFloor()
        }, HOLD_GRACE_MS)
      }
    }
    if (this.duck) {
      if (this.pause.voicedMs >= DUCK_CONFIRM_MS) this.bargeIn()
      else if (this.now() - this.duck.since > DUCK_GIVE_UP_MS) this.releaseDuck()
    }
  }

  /** Push-to-talk: release ends the turn now. */
  ptt(down: boolean): void {
    if (down === this.pttDown) return
    this.pttDown = down
    if (!down && (this.stateValue === 'hearing' || this.stateValue === 'listening')) {
      this.pause.reset()
      this.markTurnEnd()
      this.stt?.endTurn()
    } else if (!down && this.stateValue === 'reconnecting') this.markTurnEnd()
  }

  setMuted(muted: boolean): void {
    if (muted) {
      const wasReconnecting = this.stateValue === 'reconnecting'
      if (!this.dispatch({ type: 'mute' })) return
      this.pause.reset()
      // Muted mid-reconnect: nothing is heard until unmuted, so the listener is opened then.
      if (wasReconnecting) {
        if (this.reconnectTimer) this.clearTimer(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.stopKeepAlive()
      this.keepAliveTimer = this.setTimer(() => this.keepAlive(), KEEPALIVE_MS)
    } else {
      this.stopKeepAlive()
      // Unmuted by hand: it listens to everything again, called by name or not.
      this.setStandby(false)
      if (!this.dispatch({ type: 'unmute' })) return
      // The listener went away while muted: it is opened again now, as any dropped one is.
      if (!this.stt) this.beginReconnect()
    }
  }

  /**
   * The listener dropped while muted. Muted can't go to reconnecting (that
   * would unmute you), and nothing is heard meanwhile, so it is let go now and
   * opened again on unmute. Before, it stayed as a dead listener: unmuted,
   * voice mode said Listening and heard nothing.
   */
  private droppedWhileMuted(): void {
    this.generation++
    this.ctrl.abort()
    const stale = this.stt
    this.stt = null
    void stale?.close()
  }

  private keepAlive(): void {
    if (this.stateValue !== 'paused') return
    this.stt?.keepAlive?.()
    this.keepAliveTimer = this.setTimer(() => this.keepAlive(), KEEPALIVE_MS)
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) this.clearTimer(this.keepAliveTimer)
    this.keepAliveTimer = null
  }

  /** Feed the session-level events Phase 5's agent bridge produces (run done, tool start…). */
  agentEvent(event: Extract<VoiceSessionEvent, { type: 'tool_start' | 'needs_you' | 'answered' | 'run_done' | 'audio_start' | 'audio_done' }>): void {
    this.dispatch(event)
    this.pause.setAgentSpeaking(this.stateValue === 'speaking')
  }

  async stop(): Promise<void> {
    if (this.stateValue === 'off') return
    this.dispatch({ type: 'stop' })
    this.generation++
    if (this.reconnectTimer) this.clearTimer(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.relistenTimer) this.clearTimer(this.relistenTimer)
    this.relistenTimer = null
    this.stopKeepAlive()
    this.untap?.()
    this.untap = null
    this.unwatchApprovals?.()
    this.unwatchApprovals = null
    this.approval = null
    this.echo.reset()
    this.duck = null
    this.overFloor = false
    this.clearHoldGrace()
    this.work = null
    this.workSent = ''
    if (this.workTimer) this.clearTimer(this.workTimer)
    this.workTimer = null
    this.unwatchQuestions?.()
    this.unwatchQuestions = null
    this.question = null
    this.followedRun = null
    this.taskRunId = null
    this.taskWorkspace = null
    this.screen = null
    this.standby = false
    this.endWhenDone = false
    // Voice mode ended first: what waited on the reply is done now, never dropped.
    this.flushAfterReply()
    this.unfollowed = []
    this.followedTurns.clear()
    this.dropPendingTurn()
    this.stopAck()
    this.lastSaid = null
    this.reply.dispose()
    // A line still being made ("One moment.", a cue) would keep calling the provider after End.
    for (const stream of this.liveTts) stream.cancel()
    this.liveTts.clear()
    this.playing.clear()
    this.awaitingAudio.clear()
    this.ctrl.abort()
    const stt = this.stt
    this.stt = null
    this.clearRing()
    await stt?.close()
  }

  // ── Listener events ──────────────────────────────────────────────────────

  private onStt(event: SttEvent): void {
    switch (event.kind) {
      case 'speech_start':
        this.onSpeechStart()
        return
      case 'partial': {
        // A sound tag ("[music]") is not you talking: no caption, no barge-in.
        const text = cleanTranscript(event.text)
        // The agent's own voice coming back isn't your caption, and doesn't cut it off.
        if (this.echo.isEcho(text, this.now())) {
          if (this.duck) this.releaseDuck()
          return
        }
        // Words that aren't the agent's (nor a mumble): you really are talking.
        if (
          this.duck &&
          text &&
          !isNoiseTranscript(text) &&
          !isBackchannel(text) &&
          !isOtherScript(text, this.deps.settings().language)
        )
          this.bargeIn()
        if (this.deps.settings().captions && (text || !event.text.trim())) this.emitEvent({ kind: 'partial', text })
        return
      }
      case 'final':
        return
      case 'end_of_turn':
        this.onEndOfTurn(event.text, event.listen)
        return
      case 'error':
        if (!event.retryable) this.failWith(event.code, event.message)
        // A whole-turn listener has no connection to get back: this turn is lost, the session isn't (A-03).
        else if (!this.listenerStreams) this.turnFailed(event.code, event.message)
        else {
          this.lastDropReason = event.message
          if (this.stateValue === 'paused') this.droppedWhileMuted()
          else this.beginReconnect()
        }
        return
      case 'closed':
        // Closed under us (not by stop): try to get it back.
        if (this.stateValue === 'paused') this.droppedWhileMuted()
        else if (this.stateValue !== 'off' && this.stateValue !== 'error') this.beginReconnect()
        return
      case 'open':
        return
    }
  }

  /**
   * "Stop speaking" (the bar's button, Esc): silence the reply without it
   * counting as the person talking. The run carries on.
   */
  interruptSpeech(): void {
    if (this.stateValue !== 'speaking') return
    if (this.duck) this.endDuck()
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.awaitingAudio.clear()
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'audio_done', runActive: this.reply.runActive })
  }

  private onSpeechStart(): void {
    // Words waiting for the rest: here it comes, so they wait for it.
    if (this.pendingTurn) this.pendingTurn.talking = true
    const s = this.stateValue
    if (!AGENT_FLOOR_STATES.has(s)) {
      // Answering while it's still reading the question out: stop reading.
      // Not a barge-in — the reply that follows your answer is still spoken.
      if (s === 'waiting_on_you' && this.playing.size > 0) {
        for (const contextId of this.playing) this.emitEvent({ kind: 'flush', contextId })
        this.playing.clear()
        this.echo.setPlaying(false, this.now())
        this.pause.setAgentSpeaking(false)
      }
      this.dispatch({ type: 'speech_start' })
      return
    }
    // The agent is talking: dip its voice first (D-33); `bargeIn` once it's sure.
    if (this.playing.size > 0) {
      this.startDuck()
      return
    }
    if (s === 'speaking') {
      // Between two sentences of a reply: there is something to stop.
      this.bargeIn()
      return
    }
    // Working with nothing audible. A breath or a click must not silence the
    // agent's result (B1): nothing is cut; the turn decides. Audio that starts
    // meanwhile is dipped until it's clear (`playback`).
    if (!this.overFloor) {
      this.holdMaxTimer = this.setTimer(() => {
        this.holdMaxTimer = null
        this.endOverFloor()
      }, HOLD_MAX_MS)
    }
    this.overFloor = true
    this.clearHoldGrace(false)
  }

  private startDuck(): void {
    if (this.duck) return
    this.duck = { since: this.now() }
    this.emitEvent({ kind: 'duck', on: true })
  }

  /** The maybe-turn over the agent's floor resolved (words, a breath, or nothing came): let go. */
  private endOverFloor(): void {
    this.clearHoldGrace()
    this.overFloor = false
  }

  /** Cancel the grace after a sound; `all` also the cap on the hold itself (it resolved). */
  private clearHoldGrace(all = true): void {
    if (this.holdGraceTimer) this.clearTimer(this.holdGraceTimer)
    this.holdGraceTimer = null
    if (!all) return
    if (this.holdMaxTimer) this.clearTimer(this.holdMaxTimer)
    this.holdMaxTimer = null
  }

  /** Not you after all: the agent's voice comes back, and the next sound starts afresh. */
  private releaseDuck(): void {
    if (!this.duck) return
    this.endDuck()
    this.pause.reset()
  }

  private endDuck(): void {
    this.duck = null
    this.emitEvent({ kind: 'duck', on: false })
  }

  /**
   * Barge-in (§6.2): stop speaking now and clear the speakers. What happens
   * to the run is the renderer's call when this turn ends (steer / cancel).
   */
  private bargeIn(): void {
    if (this.duck) this.endDuck()
    if (!AGENT_FLOOR_STATES.has(this.stateValue)) return
    const flushed = this.reply.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : [])])) {
      this.emitEvent({ kind: 'flush', contextId })
    }
    this.playing.clear()
    this.awaitingAudio.clear()
    this.echo.setPlaying(false, this.now())
    this.pause.setAgentSpeaking(false)
    this.dispatch({ type: 'barge_in' })
  }

  /** The connection the next requests use, opened ahead of them (at most every few seconds). */
  private warmUp(): void {
    const at = this.now()
    if (!this.deps.warm || at - this.lastWarmAt < 3000) return
    this.lastWarmAt = at
    this.deps.warm()
  }

  /** The pause that ended the turn whose words just came, if the detector saw one. */
  private takePause(at: number): { at: number; silenceMs: number; speechMs: number } | undefined {
    const pause = this.lastPause
    this.lastPause = null
    return pause && pause.at <= at && at - pause.at <= PAUSE_MATCH_MS ? pause : undefined
  }

  /**
   * Whether the voice or the agent just asked or offered you something: a
   * bare "okay" or "yes" is then your answer, not a backchannel to ignore.
   */
  private justAsked(): boolean {
    const last = this.lastSaid
    return Boolean(last && this.now() - last.at <= ASKED_WINDOW_MS && asksSomething(last.text))
  }

  private onEndOfTurn(raw: string, listen?: TurnListenStats): void {
    // The listener's sound tags ("[clears throat]") are not words you said.
    let text = cleanTranscript(raw)
    const pause = this.takePause(this.now())
    // A listener that detects turns ends them now, so the detector starts afresh. For
    // the rest our own pause ended the turn earlier, and you may be talking again
    // already: resetting would re-fire speech_start and trim those words away (D-43).
    if (this.turnDetection) {
      this.pause.reset()
      this.clearRing()
    } else this.answeredUpTo(this.turnEnds.shift())
    // Nothing said, or only the agent's own words picked up by the mic (§6.4),
    // or a filler a listener invents from noise: not a turn, never a message.
    // Judged at when the words were heard, not when a whole-turn listener got them back
    // (the pause plus seconds of upload): checked on arrival, echoes slipped past the tail.
    const heardAt = pause ? pause.at - pause.silenceMs : this.now()
    const echo = Boolean(text) && this.echo.isEcho(text, heardAt)
    const noise =
      !echo &&
      (isNoiseTranscript(text) ||
        isOtherScript(text, this.deps.settings().language) ||
        // "Okay." to nothing in particular: answering it is what kept a noisy room talking.
        (isBackchannel(text) && !this.approval && !this.question && !this.justAsked() && !this.pendingTurn))
    if (this.duck) {
      if (!text || echo || noise) this.releaseDuck()
      else this.bargeIn()
    }
    if (!text || echo || noise) {
      this.deps.record?.({ kind: 'dropped', reason: !text ? 'empty' : echo ? 'echo' : 'noise', chars: text.length })
      this.deps.onTurnDropped?.(!text ? 'empty' : echo ? 'echo' : 'noise', text.length, {
        ...(pause ? { speechMs: pause.speechMs, sttMs: this.now() - pause.at } : {}),
        ...(listen ?? {})
      })
      // Words it chose not to answer stay on screen, marked; an echo was never yours.
      if (noise && text) {
        const turnId = (this.deps.newId ?? randomUUID)()
        this.deps.record?.({ kind: 'unanswered', turnId, text })
        this.emitEvent({ kind: 'unanswered', turnId, text })
      }
      this.endOverFloor()
      // That sound wasn't the rest of the words waiting: they go at their next tick.
      if (this.pendingTurn) this.pendingTurn.talking = false
      this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
      return
    }
    // Waiting to be called by name: anything else is not a turn; the name wakes it.
    if (this.standby) {
      const after = afterWakeName(text)
      this.deps.onStandbyHeard?.(after === null ? 'ignored' : after ? 'woken_with_words' : 'woken', text.length)
      if (after === null) {
        this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
        return
      }
      this.setStandby(false)
      if (!after) {
        if (this.dispatch({ type: 'end_of_turn' })) this.sayLine(WOKEN_LINE)
        return
      }
      text = after
    }
    this.overFloor = false
    this.clearHoldGrace()
    // Words that come while the agent has the floor are still yours: never
    // dropped (D-43). Its voice stops; its work goes on, and gets your words.
    const s = this.stateValue
    if (s === 'waiting_on_you') this.dispatch({ type: 'speech_start' })
    else if (s === 'speaking') this.bargeIn()
    if (!AGENT_FLOOR_STATES.has(this.stateValue) && !this.dispatch({ type: 'end_of_turn' })) return
    if (this.answerApprovalByVoice(text) || this.answerQuestionByVoice(text)) return
    // Your turn: whatever the agent reports next is spoken again (D-46).
    this.reply.resume()
    this.timing = {
      endOfTurnAt: this.now(),
      ...(pause ? { pause: { at: pause.at, silenceMs: pause.silenceMs } } : {}),
      ...(listen ? { listen } : {}),
      replies: new Set()
    }
    const stop = isStopPhrase(text)
    const turnId = (this.deps.newId ?? randomUUID)()
    this.deps.record?.({ kind: 'you', turnId, text, ...(stop ? { stop } : {}) })
    this.emitEvent({ kind: 'turn', turnId, text, stop })
    if (stop) {
      const working = this.reply.runActive
      if (working) this.deps.record?.({ kind: 'stop_agent', by: 'you' })
      // "Stop" needs no model: the voice goes quiet, and the work stops if there is any.
      this.dropPendingTurn()
      this.stopAck()
      if (!working) {
        this.dispatch({ type: 'reply_done', runActive: false })
        return
      }
      this.stopWork()
      // Said so you know it took: the run's own end follows.
      const contextId = (this.deps.newId ?? randomUUID)()
      const stream = this.openReplyTts(contextId)
      this.said(contextId, STOPPED_LINE, 'voice', stream !== null)
      if (stream) {
        stream.pushText(STOPPED_LINE)
        stream.end()
      } else this.dispatch({ type: 'reply_done', runActive: false })
      return
    }
    this.takeTurn(text, turnId)
  }

  // ── Your turn, to the agent (§27) ──────────────────────────────────────

  /**
   * Your words go to the agent as you said them: voice mode is the agent, so
   * nothing rewrites or answers them in between. Words that sound unfinished
   * ("Can you") wait a moment for the rest, which joins them (D-43).
   */
  private takeTurn(text: string, turnId: string): void {
    const pending = this.pendingTurn
    if (pending) this.clearTimer(pending.timer)
    const joined = pending ? `${pending.text} ${text}` : text
    const turnIds = [...(pending?.turnIds ?? []), turnId]
    this.pendingTurn = null
    if (!soundsUnfinished(joined)) {
      this.sendTurn(joined)
      return
    }
    this.pendingTurn = { text: joined, turnIds, timer: null, since: pending?.since ?? this.now(), talking: false }
    this.armPendingTurn()
  }

  /**
   * The wait for the rest of an unfinished turn. While you're still talking
   * the rest is on its way, so it waits on (up to UNFINISHED_MAX_MS): sent at
   * 2.5 s, "Can you" went alone and the rest came after as a second message.
   */
  private armPendingTurn(): void {
    const pending = this.pendingTurn
    if (!pending) return
    pending.timer = this.setTimer(() => {
      const waiting = this.pendingTurn
      if (!waiting) return
      if (waiting.talking && this.now() - waiting.since < UNFINISHED_MAX_MS) {
        this.armPendingTurn()
        return
      }
      this.pendingTurn = null
      if (this.stateValue !== 'off' && this.stateValue !== 'error') this.sendTurn(waiting.text)
    }, UNFINISHED_WAIT_MS)
  }

  private dropPendingTurn(): void {
    if (this.pendingTurn) this.clearTimer(this.pendingTurn.timer)
    this.pendingTurn = null
  }

  /**
   * To the task, as a message you said out loud: the agent answers it, and
   * its spoken reply is what you hear. The view keeps one work row per run,
   * so your words aren't shown twice.
   */
  private sendTurn(text: string): void {
    const handOffId = (this.deps.newId ?? randomUUID)()
    this.unfollowed.push(handOffId)
    this.deps.record?.({ kind: 'hand_off', handOffId, brief: text })
    this.emitEvent({ kind: 'hand_off', handOffId, brief: text })
    // Stopped on you: the agent can't answer until you do, so say what it waits on rather than nothing.
    const waiting = this.waitingLine()
    if (waiting) this.sayLine(waiting)
    else this.startAck()
  }

  /** What the followed run is stopped on, said again; null when it isn't. */
  private waitingLine(): string | null {
    if (this.approval) {
      return this.voiceMayAnswer() ? `I still need your yes or no first: can I ${describeApproval(this.approval)}?` : 'I still need your okay on screen first.'
    }
    if (this.question) return `I still need your answer first. ${describeQuestion(this.question)}`
    return null
  }

  /** Nothing said by ACK_MS: a short line, once, so you know it heard you. */
  private startAck(): void {
    this.stopAck()
    const sentAt = this.now()
    this.ackTimer = this.setTimer(() => {
      this.ackTimer = null
      if (this.stateValue === 'off' || this.stateValue === 'error' || this.standby) return
      if ((this.lastSaid?.at ?? Number.NEGATIVE_INFINITY) >= sentAt || this.playing.size > 0) return
      if (this.approval || this.question) return
      this.sayLine(ACK_LINES[this.ackUses++ % ACK_LINES.length]!)
    }, ACK_MS)
  }

  private stopAck(): void {
    if (this.ackTimer) this.clearTimer(this.ackTimer)
    this.ackTimer = null
  }

  // ── Approvals by voice (§7.5, B9) ──────────────────────────────────────

  /**
   * Whether a spoken answer may settle approvals. A risky one too (a delete,
   * a commit or push, a guarded command): a spoken yes is enough (2026-10-16
   * decision, §27), and a risky one is only ever allowed once.
   */
  private voiceMayAnswer(): boolean {
    return this.deps.settings().approveByVoice && Boolean(this.deps.resolveApproval)
  }

  private onApprovalAsked(req: ToolApprovalRequest): void {
    if (this.stateValue === 'off' || req.runId !== this.followedRun) return
    this.approval = req
    this.scheduleWork()
    this.dispatch({ type: 'needs_you' })
    const what = describeApproval(req)
    // The agent asking, in its own voice: voice mode is the agent (§27).
    this.reply.announce(
      !this.voiceMayAnswer()
        ? `I need your okay to ${what}. It's on your screen.`
        : req.danger
          ? `I need your yes to ${what}. It can't easily be undone. Yes or no?`
          : voiceMayAlwaysAllow(req)
            ? `Can I ${what}? Say yes, no, or always allow.`
            : `Can I ${what}? Yes or no?`
    )
  }

  private onApprovalSettled(requestId: string): void {
    if (this.approval?.requestId !== requestId) return
    this.approval = null
    this.scheduleWork()
    this.dispatch({ type: 'answered' })
  }

  /** A whole-utterance yes/no answers the pending approval instead of becoming a message. */
  private answerApprovalByVoice(text: string): boolean {
    const req = this.approval
    if (!req || !this.voiceMayAnswer()) return false
    const decision = approvalAnswer(text)
    if (!decision) return false
    // "Always" only where the card itself offers it; anything wider is the card's to give.
    if (decision === 'always' && !voiceMayAlwaysAllow(req)) {
      this.deps.record?.({ kind: 'answered', what: 'approval', text, decision: 'always refused: once only', tool: req.name })
      this.reply.announce('That one can only be allowed once. Say yes or no.')
      return true
    }
    const ok = this.deps.resolveApproval?.({ requestId: req.requestId, runId: req.runId, decision }) ?? false
    if (!ok) return false
    this.deps.record?.({ kind: 'answered', what: 'approval', text, decision, tool: req.name })
    const said =
      decision === 'once' ? 'Allowed.' : decision === 'deny' ? 'Denied.' : `Allowed. It won’t ask again for ${alwaysAllowWhat(req)} in this workspace.`
    this.sayLine(said)
    return true
  }

  // ── The agent's questions by voice (§7.5) ──────────────────────────────

  private onQuestionAsked(req: AgentQuestionRequest): void {
    if (this.stateValue === 'off' || req.runId !== this.followedRun) return
    this.question = req
    this.scheduleWork()
    this.dispatch({ type: 'needs_you' })
    this.reply.announce(describeQuestion(req))
  }

  private onQuestionSettled(requestId: string): void {
    if (this.question?.requestId !== requestId) return
    this.question = null
    this.scheduleWork()
    this.dispatch({ type: 'answered' })
  }

  /**
   * A reply that clearly answers the one question settles it, as the card
   * would. Anything else (a stop phrase, an unclear pick, a form with
   * several questions) goes on as a message, which the agent reads as the
   * answer when it is one.
   */
  private answerQuestionByVoice(text: string): boolean {
    const req = this.question
    if (!req || !this.deps.resolveQuestion || isStopPhrase(text) || !answerableByVoice(req)) return false
    const item = req.questions[0]!
    const values = questionAnswer(item, text)
    if (!values) return false
    const ok = this.deps.resolveQuestion({
      requestId: req.requestId,
      runId: req.runId,
      answers: [{ questionId: item.id, values }]
    })
    if (!ok) return false
    this.deps.record?.({ kind: 'answered', what: 'question', text, decision: values.join(', ') })
    this.sayLine('Got it.')
    return true
  }

  /**
   * One spoken turn didn't make it through (a whole-turn listener's upload
   * failed). Say so, and go back to listening: the next turn may well work.
   */
  private turnFailed(code: VoiceErrorCode, message: string): void {
    this.endOverFloor()
    if (this.pendingTurn) this.pendingTurn.talking = false
    this.pause.reset()
    this.clearRing()
    this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
    this.emitError('turn', code, message)
  }

  // ── Reconnect (§15) ──────────────────────────────────────────────────────

  private remember(pcm: Int16Array): void {
    this.ringTotal += pcm.length
    this.ring.push({ pcm, end: this.ringTotal })
    this.ringSamples += pcm.length
    while (this.ringSamples > RING_SAMPLES && this.ring.length > 1) this.ringSamples -= this.ring.shift()!.pcm.length
  }

  /** A turn we end here; its answer is due from the listener. */
  private markTurnEnd(): void {
    if (this.turnDetection) return
    this.turnEnds.push(this.ringTotal)
    // A listener that never answered some turn mustn't make every later one replay.
    if (this.turnEnds.length > MAX_TURN_ENDS) this.turnEnds.shift()
  }

  /** The listener answered the turn that ended here: its audio is never played again. */
  private answeredUpTo(end: number | undefined): void {
    if (end === undefined) return
    while (this.ring.length > 0 && this.ring[0]!.end <= end) this.ringSamples -= this.ring.shift()!.pcm.length
  }

  private clearRing(): void {
    this.ring = []
    this.ringSamples = 0
    this.turnEnds = []
  }

  private beginReconnect(): void {
    if (this.stateValue === 'reconnecting') return
    if (!this.dispatch({ type: 'connection_lost' })) return
    this.endOverFloor()
    this.generation++
    this.ctrl.abort()
    const stale = this.stt
    this.stt = null
    void stale?.close()
    // Only a connection that held up earns a fresh backoff.
    if (this.now() - this.connectedAt >= STABLE_CONNECTION_MS) this.attempt = 0
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    const delay = RECONNECT_DELAYS_MS[this.attempt]
    if (delay === undefined) {
      this.failWith('offline', this.lastDropReason ? `Gave up reconnecting: ${this.lastDropReason}` : 'Gave up reconnecting')
      return
    }
    this.attempt++
    this.emitEvent({ kind: 'reconnecting', attempt: this.attempt })
    this.reconnectTimer = this.setTimer(() => void this.tryReconnect(), delay)
  }

  private async tryReconnect(): Promise<void> {
    this.reconnectTimer = null
    if (this.stateValue !== 'reconnecting') return
    try {
      await this.connect()
    } catch (err) {
      // Stopped or muted while it tried: not another attempt (it logged "reconnecting" after the end).
      if (this.stateValue !== 'reconnecting') return
      const e = toVoiceError(err)
      if (!e.retryable) return this.failWith(e.code, e.message)
      return this.scheduleReconnect()
    }
    if (this.stateValue !== 'reconnecting') return
    // Listening again first: a turn the replay ends must find the session ready for it.
    this.dispatch({ type: 'connection_restored' })
    this.resumeFloor()
    // Replay what wasn't answered (said during the dropout, or a turn whose answer
    // the drop took), ending each turn where it ended before.
    this.replay(Number.NEGATIVE_INFINITY)
    // Settings changed while it was down were read by this connect; any since, now.
    if (!this.relistenTimer) this.relistenWhenQuiet()
  }

  /**
   * Back from a reconnect, where the session was: the agent's voice playing, it
   * stopped on you, or still working. Reconnecting takes none of their events,
   * so a reply that played through it showed Listening until it ended.
   */
  private resumeFloor(): void {
    if (this.playing.size > 0) this.dispatch({ type: 'audio_start' })
    else if (this.approval || this.question) this.dispatch({ type: 'needs_you' })
    else if (this.reply.runActive) this.dispatch({ type: 'tool_start' })
  }

  /** Give the open listener the kept audio that starts at or after `from`, ending each turn where it ended. */
  private replay(from: number): void {
    const ends = this.turnEnds.filter((e) => e > from)
    for (const { pcm, end } of this.ring) {
      if (end - pcm.length < from) continue
      this.stt?.pushAudio(pcm)
      while (ends.length > 0 && end >= ends[0]!) {
        ends.shift()
        this.stt?.endTurn()
      }
    }
  }

  // ── Plumbing ─────────────────────────────────────────────────────────────

  private failWith(code: VoiceErrorCode, message = ''): void {
    if (!this.dispatch({ type: 'fail' })) return
    this.endOverFloor()
    // Stopped: nothing it was waiting to do still happens ("One moment." after the error, a half-turn sent).
    this.stopAck()
    this.dropPendingTurn()
    for (const timer of [this.reconnectTimer, this.relistenTimer]) if (timer) this.clearTimer(timer)
    this.reconnectTimer = null
    this.relistenTimer = null
    this.stopKeepAlive()
    this.generation++
    this.ctrl.abort()
    const stt = this.stt
    this.stt = null
    void stt?.close()
    this.emitError('session', code, message)
  }

  /** Every failure leaves the same way: our code, where it hit, and the provider's reason (D-40). */
  private emitError(side: 'session' | 'turn' | 'speak', code: VoiceErrorCode, message: string): void {
    const detail = voiceDetail(message)
    this.deps.record?.({ kind: 'error', side, code, ...(detail ? { detail } : {}) })
    this.emitEvent({ kind: 'error', code, retryable: isRetryableVoiceError(code), side, ...(detail ? { detail } : {}) })
  }

  private dispatch(event: VoiceSessionEvent): boolean {
    let next = nextVoiceState(this.stateValue, event)
    if (next === null) return false
    // Back to the agent's work while it is still blocked on you: it's waiting, not working.
    if (next === 'working' && (this.approval || this.question)) next = 'waiting_on_you'
    if (next !== this.stateValue) {
      this.stateValue = next
      this.emitEvent({ kind: 'state', state: next })
    }
    return true
  }

  private emitEvent(event: Emitted): void {
    try {
      this.deps.emit({ ...event, sessionId: this.id } as VoiceEvent)
    } catch {
      /* the window went away */
    }
  }
}

/**
 * Whether "always allow" may be said for this approval: exactly where the
 * card offers its plain Always allow. Never a risky one, never a terminal
 * command main couldn't scope; the folder and program grants stay on the card.
 */
export function voiceMayAlwaysAllow(req: Pick<ToolApprovalRequest, 'name' | 'danger' | 'alwaysAllowCommand'>): boolean {
  if (req.danger) return false
  return req.name !== 'terminal' || Boolean(req.alwaysAllowCommand)
}

/** What an Always allow by voice remembers, in words: the command, or the tool. */
function alwaysAllowWhat(req: Pick<ToolApprovalRequest, 'name' | 'alwaysAllowCommand'>): string {
  if (req.name !== 'terminal' || !req.alwaysAllowCommand) return req.name
  // toSpeakable closes the line with a full stop; this sits mid-sentence.
  return toSpeakable(req.alwaysAllowCommand).replace(/[.]+$/, '') || 'that command'
}

/** An offer that wants a yes or no, with or without a question mark ("I can have it check if you like."). */
const OFFER_RE = /\b(?:want me to|should i|shall i|would you like|do you want|if you(?:['’]?d)? like|let me know if)\b/i

/** Whether what was just said asks or offers something: a bare "yes" or "okay" then answers it. */
export function asksSomething(text: string): boolean {
  return text.includes('?') || OFFER_RE.test(text)
}

/** What the voice says when "stop" stopped work. */
export const STOPPED_LINE = 'Stopped.'
/** Said when called by name with nothing after it. */
export const WOKEN_LINE = 'Yes?'

/** Said when your words never reached the task (the agent's own voice, §27: never "passed on"). */
export const HAND_OFF_FAILED_LINE: Readonly<Record<VoiceHandOffFailure, string>> = {
  no_task: 'I can’t start on that: there’s no task open. Open one and say it again.',
  refused: 'That didn’t go through: the task isn’t ready for it yet. The screen says why.',
  error: 'That didn’t go through: something went wrong sending it.',
  // It went, but the window never learned its run (A-112): its reply won't be spoken.
  unfollowed: 'I’m on it, but I can’t speak the answer from here. It’ll be on your screen.'
}

/** An app action asked about out loud ("can I …?"), from its summary (`delete_task: the login page`). */
function describeAppControl(summary: string): string {
  const cut = summary.indexOf(': ')
  const action = (cut >= 0 ? summary.slice(0, cut) : summary).trim()
  const on = cut >= 0 ? summary.slice(cut + 2).trim() : ''
  if (action === 'delete_task') return on ? `delete the task “${on}”` : 'delete the task on screen'
  if (action === 'quit_app') return 'quit Agent V'
  if (action === 'install_update') return 'install the update and restart the app'
  if (!action) return 'do that in the app'
  return `${action.replace(/_/g, ' ')}${on ? ` ${on}` : ''}`
}

/** What an approval asks for, in a few spoken words (§7.5). */
export function describeApproval(req: Pick<ToolApprovalRequest, 'name' | 'summary'>): string {
  const name = req.name.toLowerCase()
  const raw = req.summary.trim()
  const summary = toSpeakable(raw).replace(/[.]+$/, '').slice(0, 120)
  if (name === 'git_commit') return summary ? `commit ${summary}` : 'commit the changes'
  if (name === 'github_pr_create') return 'push the branch and open a pull request'
  if (name === 'app_control') return describeAppControl(summary)
  if (/terminal|shell|command|bash/.test(name)) return summary ? `run ${summary}` : 'run a command'
  // A path is said as its file's name: "change the saveDraft file", not "change saveDraft".
  const isPath = /[\\/]|\.\w{1,6}$/.test(raw)
  if (/^move$|rename/.test(name)) return summary ? `move ${isPath ? `the ${summary} file` : summary}` : 'move a file'
  if (/delete|remove/.test(name)) return summary ? `delete ${isPath ? `the ${summary} file` : summary}` : 'delete a file'
  if (/edit|write|patch|create|replace/.test(name)) return summary ? `change ${isPath ? `the ${summary} file` : summary}` : 'change a file'
  if (/fetch|browser|navigate/.test(name)) {
    // Say where, not "a link on screen": the site's name is what you'd check.
    const host = /^https?:\/\//i.test(raw) ? hostOf(raw) : null
    return host ? `open ${host}` : summary ? `open ${summary}` : 'open a web page'
  }
  return summary ? `use ${req.name}: ${summary}` : `use ${req.name}`
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '') || null
  } catch {
    return null
  }
}
