/**
 * A live voice session (docs/voice-mode.md §5, §6, §15): the mic audio in,
 * a cloud (or local) listener, turn-taking, and the state the voice bar
 * shows. This is the listening half. Phase 5 adds the agent bridge and the
 * spoken reply on top of the same state machine.
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
import { VoiceResponder, type AgentStatus, type ResponderChat } from './responder'
import type { TokenUsage } from '../agent/providers/types'
import { EchoGuard } from './echoGuard'
import {
  afterWakeName,
  approvalAnswer,
  cleanTranscript,
  confirmsAction,
  isBackchannel,
  isNoiseTranscript,
  isOtherScript,
  isStopPhrase,
  soundsUnfinished,
  toSpeakable
} from './speechText'
import { APP_ACTIONS, isAppActionName } from '../../shared/appActions'
import type { AppActionContext, AppActionResult } from '../appControl/runner'
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
/** Talk that stopped mid-thought ("Can you") waits this long for the rest before the voice answers. */
export const UNFINISHED_WAIT_MS = 2500
/** The task's conversation is read again when you start talking, at most this often. */
export const TASK_CONTEXT_FRESH_MS = 5000
/** The app is read again when you start talking, at most this often. */
export const APP_CONTEXT_FRESH_MS = 5000
/** Keep a muted listener's connection alive this often. */
const KEEPALIVE_MS = 5000
/** The view's steps refresh at most this often while a run works. */
const WORK_EMIT_MS = 120
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
  /**
   * The voice model's call (D-44); null or absent when it can't be used,
   * and every turn then goes straight to the agent as before.
   */
  responder?: () => ResponderChat | null
  /** The voice model's token usage, for Usage: charged to the task it was on (W-04), else where it opened. */
  onResponderUsage?: (usage: TokenUsage, where: { runId: string | null; workspacePath: string | null }) => void
  /** The voice model was slow to answer or said nothing (and was asked again): for the log. */
  onResponderTrouble?: (what: 'timeout' | 'empty', retried: boolean) => void
  /**
   * The task's conversation so far, as the voice reads it (see `taskContext`):
   * what you asked and what the agent answered. Empty when there's none.
   */
  loadTaskContext?: (runId: string, workspacePath: string | null) => Promise<string>
  /**
   * The app as the voice sees it (appContext.ts): the screen, workspace and
   * branch, other work, settings, the time, rules and memory by headline.
   */
  loadAppContext?: (where: { runId: string | null; workspacePath: string | null; screen: VoiceScreen | null }) => Promise<string>
  /** Words heard while waiting to be called by name: ignored, or the name that woke it (for the log). */
  onStandbyHeard?: (what: 'ignored' | 'woken' | 'woken_with_words', chars: number) => void
  /** Run an app action (src/shared/appActions.ts); without it the voice can't act in the app. */
  runAppAction?: (name: string, args: unknown, ctx: AppActionContext) => Promise<AppActionResult>
  /** Speak in another voice, by its name. */
  setVoiceName?: (name: string) => Promise<AppActionResult>
  /**
   * The last kept voice conversation on this task, from an earlier session, as
   * the voice model's memory (empty when there is none): "continue" knows what
   * you said, and what you stopped.
   */
  loadPastConversation?: (runId: string, workspacePath: string | null) => Promise<Array<{ role: 'user' | 'assistant'; content: string }>>
  /** The voice model failed and the turn went to the agent instead: for the log. */
  onResponderFailed?: (message: string) => void
  /** The voice model chose to say nothing to a turn (it heard a sound or a filler): for the log, never the words. */
  onStayedQuiet?: (chars: number) => void
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
  private keepAliveTimer: unknown = null
  private pttDown = false
  /** Bumps on every (re)connect, so a stale listener's events are ignored. */
  private generation = 0
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private readonly reply: ReplySpeaker
  /** The voice that answers your turns and hands work to the agent (D-44). */
  private readonly responder: VoiceResponder
  /** The last brief the agent was given, and when, for the voice's context. */
  private agentBrief: string | undefined
  private agentSince: number | undefined
  private recordedStart = false
  /** What the voice's status said before the latest hand-off, restored if the task never took it. */
  private lastHandOff: { id: string; brief: string | undefined; since: number | undefined } | null = null
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
  /** The task's run (its conversation is the voice's context), and that conversation as last read. */
  private taskRunId: string | null = null
  /** The task's workspace when the window named it; else the run's own, as main knows it. */
  private taskWorkspace: string | null = null
  private taskContext = ''
  private taskContextAt = Number.NEGATIVE_INFINITY
  private taskContextGen = 0
  /** What the window shows (the window says); the app as last read for the voice. */
  private screen: VoiceScreen | null = null
  private appContext = ''
  private appContextAt = Number.NEGATIVE_INFINITY
  private appContextGen = 0
  /** Muted until called by name ("Agent V"): it listens, and takes nothing else as a turn. */
  private standby = false
  /** Your words of the turn being answered: a destructive action needs them to be a yes. */
  private lastTurnText = ''
  /** The followed run's progress, from its own events, for the voice's status line (B6). */
  private progress: RunProgress = emptyProgress()
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
      say: (contextId, text) => {
        this.said(contextId, text, 'agent', true)
        // The agent's own words join the voice's conversation (its result, a cue, a question).
        this.responder.agentSaid(text)
      },
      onToolStart: () => this.dispatch({ type: 'tool_start' }),
      onRunEnd: () => this.dispatch({ type: 'run_done' }),
      speakProgress: () => this.deps.settings().speakProgress,
      quietCue: () => this.emitEvent({ kind: 'cue' }),
      onResult: (answer) => this.responder.agentFinished(answer, this.progress.ended?.outcome ?? 'done'),
      onRunFailed: (message) => this.responder.agentFailed(message),
      reportResult: () => this.responder.reportResult(),
      newId: deps.newId ?? randomUUID,
      now: deps.now ?? Date.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
    this.responder = new VoiceResponder({
      chat: () => deps.responder?.() ?? null,
      openTts: (contextId) => this.openReplyTts(contextId),
      say: (contextId, text, audible) => this.said(contextId, text, 'voice', audible),
      handOff: (brief) => {
        const handOffId = (this.deps.newId ?? randomUUID)()
        this.lastHandOff = { id: handOffId, brief: this.agentBrief, since: this.agentSince }
        this.agentBrief = brief
        this.agentSince = this.now()
        this.deps.record?.({ kind: 'hand_off', handOffId, brief })
        this.emitEvent({ kind: 'hand_off', handOffId, brief })
      },
      stopAgent: () => {
        this.deps.record?.({ kind: 'stop_agent', by: 'voice' })
        this.stopWork()
      },
      done: ({ audible, handedOff, failed, quiet }) => {
        if (failed) this.deps.onResponderFailed?.(failed.message)
        if (quiet) {
          this.deps.onStayedQuiet?.(quiet.chars)
          // Your words stay on screen, marked: it heard them and chose not to answer.
          for (const turnId of quiet.turnIds) {
            this.deps.record?.({ kind: 'unanswered', turnId })
            this.emitEvent({ kind: 'unanswered', turnId })
          }
        }
        // With audio coming, its playback moves the session on; a hand-off waits for the agent.
        if (!audible && !handedOff) this.dispatch({ type: 'reply_done', runActive: this.reply.runActive })
      },
      agentStatus: () => this.agentStatus(),
      taskContext: () => this.taskContext,
      appContext: () => this.appContext,
      appAction: (call) => this.appAction(call),
      onUsage: (usage) => this.deps.onResponderUsage?.(usage, { runId: this.taskRunId ?? this.followedRun, workspacePath: this.taskWorkspace }),
      onTrouble: (what, retried) => this.deps.onResponderTrouble?.(what, retried),
      newId: deps.newId ?? randomUUID,
      now: deps.now ?? Date.now,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer
    })
  }

  /**
   * The task the session is on (voice mode opened on it, or the line it
   * moved to), even with nothing running: the voice reads its conversation so
   * far. Null: no task yet (New task's brief).
   */
  setTask(runId: string | null, workspacePath: string | null = null, screen?: VoiceScreen): void {
    const moved = screen !== undefined && screen !== this.screen
    if (screen !== undefined) this.screen = screen
    const task = this.taskRunId
    this.enterTask(runId, workspacePath, true)
    // A new task re-reads the app with it; only the screen changed: read it now.
    if (moved && task === this.taskRunId) this.refreshAppContext(true)
  }

  /** `record`: keep a `task` line (a `followed` line already names the run when it was a follow). */
  private enterTask(runId: string | null, workspacePath: string | null, record: boolean): void {
    if (this.stateValue === 'off') return
    if (workspacePath) this.taskWorkspace = workspacePath
    if (runId === this.taskRunId) return
    // Moved from one task to another (not the new task a hand-off just made): the voice starts fresh.
    if (this.taskRunId !== null) this.forgetTask()
    this.taskRunId = runId
    this.taskContext = ''
    this.taskContextGen++
    this.refreshTaskContext(true)
    this.refreshAppContext(true)
    if (runId) {
      if (record) this.deps.record?.({ kind: 'task', runId })
      this.recallPast(runId)
    }
  }

  /**
   * What the voice said and heard about the last task goes, and with nothing
   * running, so does the work it last gave the agent: the status names this task's.
   */
  private forgetTask(): void {
    this.responder.forget()
    if (this.reply.runActive) return
    this.agentBrief = undefined
    this.agentSince = undefined
    this.lastHandOff = null
  }

  /** The last conversation on this task, from before this session, as the voice's memory. */
  private recallPast(runId: string): void {
    const load = this.deps.loadPastConversation
    if (!load) return
    void load(runId, this.taskWorkspace).then(
      (past) => {
        if (this.taskRunId === runId && this.stateValue !== 'off') this.responder.recall(past)
      },
      () => {}
    )
  }

  /** Read the task's conversation again, unless it was read just now (`force`: always). */
  private refreshTaskContext(force = false): void {
    const runId = this.taskRunId
    const load = this.deps.loadTaskContext
    if (!runId || !load) return
    const at = this.now()
    if (!force && at - this.taskContextAt < TASK_CONTEXT_FRESH_MS) return
    this.taskContextAt = at
    const gen = ++this.taskContextGen
    void load(runId, this.taskWorkspace).then(
      (text) => {
        if (gen === this.taskContextGen && this.taskRunId === runId) this.taskContext = text
      },
      () => {}
    )
  }

  /** Read the app again for the voice, unless it was read just now (`force`: always). */
  private refreshAppContext(force = false): void {
    const load = this.deps.loadAppContext
    if (!load || this.stateValue === 'off') return
    const at = this.now()
    if (!force && at - this.appContextAt < APP_CONTEXT_FRESH_MS) return
    this.appContextAt = at
    const gen = ++this.appContextGen
    void load({ runId: this.taskRunId, workspacePath: this.taskWorkspace, screen: this.screen }).then(
      (text) => {
        if (gen === this.appContextGen) this.appContext = text
      },
      () => {}
    )
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
    const stream = this.deps.openTts(
      contextId,
      (code, message) => {
        // Say it once a session: the reply is still on screen.
        if (this.speakErrorShown) return
        this.speakErrorShown = true
        this.emitError('speak', code, message)
      },
      (heard) => {
        if (!heard) this.endedUnheard(contextId)
      }
    )
    if (stream) this.awaitingAudio.add(contextId)
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
    if (this.playing.size > 0 || this.awaitingAudio.size > 0 || this.responder.busy) return
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
            // The run ended: what it answered joins the task's conversation.
            if (ev.type === 'status' && ev.status !== 'running') this.refreshTaskContext(true)
            this.progress = trackProgress(this.progress, ev, this.now())
            if (this.work) this.work = foldWork(this.work, ev, this.now())
            this.scheduleWork()
            this.reply.handle(ev)
          })
        : null
      this.followedRun = runId
      this.progress = emptyProgress()
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

  /**
   * An app action the voice called (app_action, §24.15). A destructive one
   * runs only when the voice says the user agreed and the turn it answers is
   * a yes: a model that skips the question can't delete anything.
   */
  private async appAction(call: { action: string; args: unknown; confirmed: boolean }): Promise<AppActionResult> {
    const run = this.deps.runAppAction
    if (!run || this.stateValue === 'off') return { ok: false, message: 'I can’t do that from here.' }
    if (!isAppActionName(call.action)) return { ok: false, message: 'I can’t do that from here.' }
    if (APP_ACTIONS[call.action].destructive && !(call.confirmed && confirmsAction(this.lastTurnText))) {
      return { ok: false, message: 'That needs your yes first. Should I go ahead?' }
    }
    const result = await run(call.action, call.args, {
      who: 'voice',
      runId: this.taskRunId ?? this.followedRun,
      workspacePath: this.taskWorkspace,
      voice: {
        mute: (untilCalled) => {
          if (untilCalled) this.setStandby(true)
          else this.setMuted(true)
        },
        // After its answer is said: the window ends the session.
        end: () => this.emitEvent({ kind: 'end_requested' }),
        setVoice: (name) => this.deps.setVoiceName?.(name) ?? Promise.resolve({ ok: false, message: 'Voices can’t be changed from here.' })
      }
    })
    this.deps.record?.({ kind: 'app_action', action: call.action, ok: result.ok, message: result.message })
    return result
  }

  /** Waiting to be called by name, or not; the window shows it. */
  private setStandby(on: boolean): void {
    if (this.standby === on) return
    this.standby = on
    this.emitEvent({ kind: 'standby', on })
  }

  /**
   * The window couldn't give a hand-off's brief to the task (none open, or it
   * refused the message). The voice already said "On it.": it says the work
   * didn't go, and the session doesn't sit in Thinking waiting for a run that
   * will never start.
   */
  handOffFailed(handOffId: string, reason: VoiceHandOffFailure): void {
    if (this.stateValue === 'off') return
    if (this.lastHandOff?.id === handOffId && !this.reply.runActive) {
      // The status line goes back to what the agent is really on.
      this.agentBrief = this.lastHandOff.brief
      this.agentSince = this.lastHandOff.since
    }
    this.lastHandOff = null
    this.deps.record?.({ kind: 'not_sent', handOffId, reason })
    const audible = this.responder.handOffFailed(HAND_OFF_FAILED_LINE[reason])
    if (!audible) this.dispatch({ type: 'reply_done', runActive: this.reply.runActive })
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

  /** What the voice knows of the agent's work when it answers. */
  private agentStatus(): AgentStatus {
    const p = this.progress
    const working = this.reply.runActive
    return {
      working,
      ...(this.agentBrief ? { brief: this.agentBrief } : {}),
      ...(this.agentSince !== undefined ? { since: this.agentSince } : {}),
      ...(p.steps ? { steps: p.steps } : {}),
      ...(working && p.current ? { current: p.current } : {}),
      ...(working && p.narration ? { narration: p.narration } : {}),
      ...(working && this.approval ? { waitingOn: `whether it may ${describeApproval(this.approval)}` } : {}),
      ...(working && !this.approval && this.question ? { waitingOn: describeQuestion(this.question) } : {}),
      ...(!working && p.ended ? { ended: p.ended } : {})
    }
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
    this.refreshAppContext(true)
    try {
      this.warmUp()
      await this.connect()
      this.dispatch({ type: 'ready' })
    } catch (err) {
      const e = toVoiceError(err)
      this.failWith(e.code, e.message)
    }
  }

  private async connect(): Promise<void> {
    const settings = this.deps.settings()
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

  /** Mic audio from the renderer. */
  pushAudio(pcm: Int16Array): void {
    const s = this.stateValue
    if (s === 'off' || s === 'connecting' || s === 'paused' || s === 'error') return
    if (s === 'reconnecting') {
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
      if (!this.dispatch({ type: 'mute' })) return
      this.pause.reset()
      this.keepAliveTimer = this.setTimer(() => this.keepAlive(), KEEPALIVE_MS)
    } else {
      this.stopKeepAlive()
      // Unmuted by hand: it listens to everything again, called by name or not.
      this.setStandby(false)
      this.dispatch({ type: 'unmute' })
    }
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
    this.progress = emptyProgress()
    this.work = null
    this.workSent = ''
    if (this.workTimer) this.clearTimer(this.workTimer)
    this.workTimer = null
    this.unwatchQuestions?.()
    this.unwatchQuestions = null
    this.question = null
    this.followedRun = null
    this.lastHandOff = null
    this.taskRunId = null
    this.taskWorkspace = null
    this.taskContext = ''
    this.taskContextGen++
    this.screen = null
    this.standby = false
    this.lastTurnText = ''
    this.appContext = ''
    this.appContextGen++
    this.lastSaid = null
    this.reply.dispose()
    this.responder.dispose()
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
          this.beginReconnect()
        }
        return
      case 'closed':
        // Closed under us (not by stop): try to get it back.
        if (this.stateValue !== 'off' && this.stateValue !== 'error') this.beginReconnect()
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
    // You may have typed in the task since: read it again while you talk, ready for your turn.
    this.refreshTaskContext()
    // The time, the screen and other tasks move on too.
    this.refreshAppContext()
    const s = this.stateValue
    if (!AGENT_FLOOR_STATES.has(s)) {
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
    // Working, or working out an answer, with nothing audible. A breath or a
    // click must not silence the agent's result (B1) or restart the answer
    // (B2): hold what the voice would say next, and let the turn decide.
    if (!this.overFloor) {
      this.holdMaxTimer = this.setTimer(() => {
        this.holdMaxTimer = null
        this.endOverFloor()
      }, HOLD_MAX_MS)
    }
    this.overFloor = true
    this.responder.hold()
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
    if (!this.overFloor) return
    this.overFloor = false
    this.responder.release()
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
    const voice = this.responder.interrupt()
    for (const contextId of new Set([...this.playing, ...(flushed ? [flushed] : []), ...(voice ? [voice] : [])])) {
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
        (isBackchannel(text) && !this.approval && !this.question && !this.justAsked() && !this.responder.hasCarried))
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
      // Not words: whatever the voice held while it listened is said now.
      this.endOverFloor()
      // A cough cut off an answer that hadn't started: answer what you'd said after all.
      if (this.responder.hasCarried && this.dispatch({ type: 'end_of_turn' })) this.responder.answerCarried()
      else this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
      return
    }
    // Waiting to be called by name: anything else is not a turn; the name wakes it.
    if (this.standby) {
      const after = afterWakeName(text)
      this.deps.onStandbyHeard?.(after === null ? 'ignored' : after ? 'woken_with_words' : 'woken', text.length)
      if (after === null) {
        this.responder.release()
        this.dispatch({ type: 'false_start', runActive: this.reply.runActive })
        return
      }
      this.setStandby(false)
      this.responder.woken()
      if (!after) {
        this.responder.release()
        if (this.dispatch({ type: 'end_of_turn' })) this.sayLine(WOKEN_LINE)
        return
      }
      text = after
    }
    // Words: `respond` decides what happens to anything held (D-43), so it isn't released here.
    this.overFloor = false
    this.clearHoldGrace()
    // Words that come back while the agent has the floor are still yours: never
    // dropped (D-43). An answer not yet begun takes them in; one being spoken stops.
    const s = this.stateValue
    if (s === 'waiting_on_you') this.dispatch({ type: 'speech_start' })
    else if (AGENT_FLOOR_STATES.has(s) && !this.responder.pendingUnspoken) this.bargeIn()
    if (!AGENT_FLOOR_STATES.has(this.stateValue) && !this.dispatch({ type: 'end_of_turn' })) {
      this.responder.release()
      return
    }
    if (this.answerApprovalByVoice(text) || this.answerQuestionByVoice(text)) {
      this.responder.release()
      return
    }
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
      this.responder.interrupt()
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
    this.lastTurnText = text
    // "Can you…": wait a moment before answering, so the rest of the thought joins this turn.
    this.responder.respond(text, { turnId, ...(soundsUnfinished(text) ? { waitMs: UNFINISHED_WAIT_MS } : {}) })
  }

  // ── Approvals by voice (§7.5, B9) ──────────────────────────────────────

  /** Whether a spoken answer may settle this approval (never a risky one). */
  private voiceMayAnswer(req: ToolApprovalRequest): boolean {
    return this.deps.settings().approveByVoice && !req.danger && Boolean(this.deps.resolveApproval)
  }

  private onApprovalAsked(req: ToolApprovalRequest): void {
    if (this.stateValue === 'off' || req.runId !== this.followedRun) return
    this.approval = req
    this.scheduleWork()
    this.dispatch({ type: 'needs_you' })
    const what = describeApproval(req)
    this.reply.announce(
      req.danger
        ? `It wants to ${what}, which could be risky. Approve or deny it on screen.`
        : this.voiceMayAnswer(req)
          ? voiceMayAlwaysAllow(req)
            ? `It wants to ${what}. Say yes, no, or always allow.`
            : `It wants to ${what}. Say yes or no.`
          : `It wants to ${what}. Approve or deny it on screen.`
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
    if (!req || !this.voiceMayAnswer(req)) return false
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
      const e = toVoiceError(err)
      if (!e.retryable) return this.failWith(e.code, e.message)
      return this.scheduleReconnect()
    }
    if (this.stateValue !== 'reconnecting') return
    // Listening again first: a turn the replay ends must find the session ready for it.
    this.dispatch({ type: 'connection_restored' })
    // Replay what wasn't answered (said during the dropout, or a turn whose answer
    // the drop took), ending each turn where it ended before.
    const ends = [...this.turnEnds]
    for (const { pcm, end } of this.ring) {
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

/** The followed run's work so far, as the voice tells it (B6). Never the tools' output. */
export type RunProgress = {
  running: boolean
  /** Tool calls started since the run (re)started. */
  steps: number
  /** The tool running now, "name: summary". */
  current?: string
  currentId?: string
  /** The agent's last words between steps. */
  narration?: string
  ended?: { at: number; outcome: 'done' | 'error' | 'cancelled' }
}

export function emptyProgress(): RunProgress {
  return { running: false, steps: 0 }
}

/** Fold one run event into the progress; pure, so it's tested on its own. */
export function trackProgress(p: RunProgress, ev: AgentEvent, now: number): RunProgress {
  switch (ev.type) {
    case 'status':
      if (ev.status === 'running') return p.running ? p : { running: true, steps: 0 }
      return {
        running: false,
        steps: p.steps,
        ...(p.narration ? { narration: p.narration } : {}),
        ended: { at: now, outcome: ev.status === 'error' ? 'error' : ev.status === 'cancelled' ? 'cancelled' : 'done' }
      }
    case 'tool_start': {
      const summary = (ev.summary ?? '').replace(/\s+/g, ' ').trim().slice(0, 140)
      return { ...p, steps: p.steps + 1, current: summary ? `${ev.name}: ${summary}` : ev.name, currentId: ev.toolCallId }
    }
    case 'tool_result':
      if (p.currentId !== ev.toolCallId) return p
      return { ...withoutCurrent(p) }
    case 'assistant_message': {
      const words = toSpeakable(ev.content ?? '').slice(0, 240)
      return words && ev.toolCalls && ev.toolCalls.length > 0 ? { ...p, narration: words } : p
    }
    default:
      return p
  }
}

function withoutCurrent(p: RunProgress): RunProgress {
  const { current: _current, currentId: _id, ...rest } = p
  return rest
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

/** What the voice says when its brief never reached the task. */
export const HAND_OFF_FAILED_LINE: Readonly<Record<VoiceHandOffFailure, string>> = {
  no_task: 'I couldn’t pass that on: there’s no task open to give it to.',
  refused: 'I couldn’t pass that on: the task isn’t ready to take it. The screen says why.',
  error: 'I couldn’t pass that on: something went wrong sending it.',
  // It went, but the window never learned its run (A-112): nothing will be said about it.
  unfollowed: 'I passed that on, but I can’t follow the task from here. Open it to see how it goes.'
}

/** What an approval asks for, in a few spoken words (§7.5). */
export function describeApproval(req: Pick<ToolApprovalRequest, 'name' | 'summary'>): string {
  const name = req.name.toLowerCase()
  const summary = toSpeakable(req.summary).replace(/[.]+$/, '').slice(0, 120)
  if (/terminal|shell|command|bash/.test(name)) return summary ? `run ${summary}` : 'run a command'
  if (/edit|write|patch|create|replace|delete/.test(name)) return summary ? `change ${summary}` : 'change a file'
  if (/fetch|browser|navigate/.test(name)) return summary ? `open ${summary}` : 'open a web page'
  return summary ? `use ${req.name}: ${summary}` : `use ${req.name}`
}
