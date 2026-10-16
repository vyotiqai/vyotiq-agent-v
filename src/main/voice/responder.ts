/**
 * The voice that answers (docs/voice-mode.md §25, D-44): a fast chat model
 * that talks with you out loud and hands real work to the agent.
 *
 * Every spoken turn comes here, never straight to the agent. The model
 * answers in a sentence or two, streamed and spoken as it arrives; when you
 * want something done in the project it calls `hand_to_agent` with a brief,
 * and the session gives that to the task. The agent's own result is spoken
 * by the ReplySpeaker as before and joins this conversation, so "what did it
 * find?" can be answered.
 *
 * It knows nothing about audio devices, IPC or providers: speaking and the
 * model call are injected.
 */
import type { ChatMessage } from '../../shared/ipc'
import { extractSpokenBlock, stripSpokenBlock } from '../../shared/spokenSummary'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import type { ToolDefinition, TokenUsage } from '../agent/providers/types'
import type { TtsStream } from './providers/types'
import { SentenceSplitter, asksToCommitOrPush, confirmsAction, fallbackSummary, toSpeakable } from './speechText'
import { APP_ACTION_NAMES, APP_COMMANDS, appActionsFor, describeAppActions } from '../../shared/appActions'

/** One streamed piece of the model's answer. */
export type ResponderChunk =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; name: string; arguments: string }
  | { type: 'done'; usage?: TokenUsage }
  | { type: 'error'; message: string }

export type ResponderChat = (req: {
  /** Fixed instructions: the same bytes every turn, so the provider can cache them. */
  system: string
  /** What the agent is doing right now; changes every turn, so it's sent apart from `system`. */
  status: string
  messages: ChatMessage[]
  /** Empty for a report: the voice only says what the agent found. */
  tools: ToolDefinition[]
  signal: AbortSignal
}) => AsyncIterable<ResponderChunk>

/** What the agent is doing, for the model's context. */
export type AgentStatus = {
  working: boolean
  /** The last brief it was given, if any. */
  brief?: string
  /** When it started on that brief. */
  since?: number
  /** Tool steps it has taken on it. */
  steps?: number
  /** The step running now ("terminal: pnpm test"), if any. */
  current?: string
  /** Its last words between steps. */
  narration?: string
  /** What it is stopped on, waiting for the person (an approval or a question). */
  waitingOn?: string
  /** How its last run ended, and when; only while idle. */
  ended?: { at: number; outcome: 'done' | 'error' | 'cancelled' }
}

export type ResponderDeps = {
  /** The model call; null when the voice model can't be used (no key): turns go straight to the agent. */
  chat: () => ResponderChat | null
  openTts: (contextId: string) => TtsStream | null
  /** A piece to caption; `audible`: its audio is on the way, so the caption waits to be heard. */
  say: (contextId: string, text: string, audible: boolean) => void
  /** Give the agent work. */
  handOff: (brief: string) => void
  /** Stop the agent's work. */
  stopAgent: () => void
  /**
   * The reply ended. `audible`: audio is on its way, so the session moves
   * on when it drains; otherwise it moves on now.
   */
  done: (result: { audible: boolean; handedOff: boolean; failed?: { message: string }; quiet?: { chars: number; turnIds: string[] } }) => void
  agentStatus: () => AgentStatus
  /**
   * The task the voice is on, as its conversation so far (what you asked it,
   * what the agent answered): empty when there's no task yet. Without it the
   * voice opened on a task knowing nothing of it, and said so.
   */
  taskContext?: () => string
  /** The app around the task (appContext.ts): screen, workspace, other work, settings, time, rules, memory. */
  appContext?: () => string
  /** Do an app action (app_action); without it the tool says it can't. */
  appAction?: (call: { action: string; args: unknown; confirmed: boolean }) => Promise<AppActionOutcome>
  onUsage?: (usage: TokenUsage) => void
  /** The voice model was slow or said nothing; `retried`: it was asked again. For the log. */
  onTrouble?: (what: 'timeout' | 'empty', retried: boolean) => void
  newId: () => string
  now: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

export const HAND_OFF_TOOL = 'hand_to_agent'
export const STOP_TOOL = 'stop_agent'
export const QUIET_TOOL = 'stay_quiet'
export const APP_TOOL = 'app_action'
/** Longer than this, what you said is meant for the voice, whatever the model makes of it. */
export const QUIET_MAX_WORDS = 5

export const RESPONDER_TOOLS: ToolDefinition[] = [
  {
    name: HAND_OFF_TOOL,
    description:
      'Give the coding agent work in the open project: reading or changing code, running commands or tests, checking something, using the browser. ' +
      'If it is already working, the brief joins that work without cancelling it.',
    parameters: {
      type: 'object',
      properties: {
        brief: {
          type: 'string',
          description: 'A complete, self-contained instruction in the user’s terms, with every detail they gave.'
        },
        confirmed: { type: 'boolean', description: 'True only when the brief commits or pushes and the user has just said yes to that.' }
      },
      required: ['brief']
    }
  },
  {
    name: STOP_TOOL,
    description: 'Stop the agent’s current work. Only when the user clearly asks to stop or cancel it.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: APP_TOOL,
    description:
      'Do something in the app itself, not in the project’s code: views, tasks in any workspace, settings, panels, the agent’s mode or model, opening files, folders or web pages, and your own voice. ' +
      'Actions, with their args:\n' +
      describeAppActions('voice'),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: appActionsFor('voice') },
        args: { type: 'object', description: 'The action’s arguments, as listed.' },
        confirmed: { type: 'boolean', description: 'True only when the user has just said yes to this action.' }
      },
      required: ['action']
    }
  },
  {
    name: QUIET_TOOL,
    description:
      'Say nothing this turn: what was heard is only a sound, a filler or background talk not meant for you. Never when the user asked or told you something; a question or more than a few words always gets an answer.',
    parameters: { type: 'object', properties: {} }
  }
]

export const RESPONDER_SYSTEM = [
  'You are the voice of Agent V, a coding agent app. You are talking with the user out loud, hands-free; everything you write is spoken.',
  'Speak like a calm, friendly colleague: one to three short sentences. No markdown, lists, code, symbols or URLs; never spell out a path.',
  `Things in the app itself, like showing a view, opening, starting, stopping, archiving or deleting tasks in any workspace, changing the theme or other settings, opening a panel, a file, a folder or a web page, setting the agent's mode or model, or changing your own voice, speed or placement, muting or ending: do them with ${APP_TOOL}, never hand them to the agent. Say in a few words what you're doing; if it fails you will hear why.`,
  `An action that needs the user's yes (deleting a task, installing an update, quitting): ask first in one short question, without calling ${APP_TOOL}. Only when their next words clearly say yes, call it with confirmed true.`,
  `Committing or pushing code needs the user's yes too: before a brief that commits or pushes, ask "Commit and push it now?" (or whichever they asked for) without calling ${HAND_OFF_TOOL}; after a clear yes, call it with confirmed true.`,
  `To start a new task in another workspace use ${APP_TOOL} start_task; ${HAND_OFF_TOOL} gives work to the task on screen; ${APP_TOOL} send_to_task gives work to another task.`,
  'Talk to the user, never about them: say "you", never "the user", and never say your reasoning ("The user has confirmed, so I will…"). Don’t say you have done something before the result comes back.',
  'With every turn you get the app as it is now: what is on screen, the workspace and its branch, other tasks, a few settings, the date and time, and the project rules and memory notes by name. Answer questions about them from it, briefly; never read it out unasked.',
  'You cannot see or change the project yourself. The agent can: it reads and edits files, runs commands and tests, and uses the browser.',
  `When the user wants anything done or checked in the project, call ${HAND_OFF_TOOL} with a complete brief, and in the same reply say in a few words that it is on it. Always say something out loud, even when you hand work off.`,
  `If the agent is already working and the user adds to or changes the request, call ${HAND_OFF_TOOL} with just the addition; it joins the current work.`,
  `Call ${STOP_TOOL} only when the user clearly asks to stop or cancel the work.`,
  `Write a brief as a direct instruction to the agent ("List every session in this project…"), never as "The user asks you to…".`,
  `Questions about how the work is going, whether it is done, or why it is slow are yours to answer from the agent status and this conversation: never call ${HAND_OFF_TOOL} for them.`,
  'Answer questions about the agent’s work from what it has reported in this conversation; if you do not know, say so and offer to have it check.',
  `When the status says the agent is stopped until the user answers, you cannot answer for them and nothing you hand off reaches it until they do. If they seem to be answering, ask for a plain yes or no, or point to the card on screen; do not call ${HAND_OFF_TOOL} with their answer or say it is on it.`,
  'When the agent finishes, you are given its written answer: tell the user what it did or found in plain speech, and point to the screen for the details.',
  'You are on the task open on the user’s screen. Its conversation so far (what the user asked and what the agent answered) comes with the agent status: it is history you share with the user, so use it and never say you have no record of it.',
  `When the user says to resume, continue or carry on, call ${HAND_OFF_TOOL} with a brief that continues that task, naming what was left to do. But if the user stopped that work, or said it was the wrong thing, ask what they want done instead of handing the same work back.`,
  `What you hear is a live transcript of a room: it can catch sounds, background talk or half a sentence. If it is only a sound, a filler or clearly not meant for you, call ${QUIET_TOOL} and say nothing; do not remark on noise.`,
  `Never write notes to yourself, stage directions or what you heard in quotes: everything you write is said. To say nothing, call ${QUIET_TOOL}.`,
  'Lines in parentheses from the app (the agent finished, what it reported earlier, your last conversation) are context for you: use them, but never mention them, never say something is attached or "not from you".',
  'If what you heard seems cut off, ask briefly what they meant. Reply in the language the user speaks.'
].join('\n')

/**
 * The agent's finished answer, put to the voice as a turn of its own (B7):
 * the coding model often skips its `<spoken>` block, and reading the first
 * lines of a table aloud is noise. Not the user talking, and it says so.
 */
export function reportRequest(report: string, outcome: 'done' | 'error' | 'cancelled' = 'done'): string {
  const how = outcome === 'done' ? 'finished' : outcome === 'error' ? 'stopped with an error' : 'was stopped'
  return (
    `(Not the user speaking: the agent ${how}. Its answer, which is on the user's screen:)\n${report}\n` +
    '(Tell the user the result out loud in one to three short sentences. If it needs something from them, ask.)'
  )
}

/** The agent's answer, as plain text the voice can read: spoken summary first, then the written part. */
export function answerForVoice(answer: string, max = REPORT_CHARS): string {
  const spoken = extractSpokenBlock(answer)
  const written = stripSpokenBlock(answer)
  return redactSecretsInText(clipBlock([spoken, written].filter(Boolean).join('\n'), max))
}

/** Said when the model handed work off without saying anything. */
export const HAND_OFF_LINE = 'On it.'
export const STOP_LINE = 'Stopping it.'
/** The voice model failed; the turn went to the agent instead. */
export const FALLBACK_LINE = 'I’ll pass that to the agent.'
/** The voice model answered with nothing, twice: never leave your words without a reply. */
export const EMPTY_LINE = 'Sorry, I lost that. Could you say it again?'
/** Said once when the model hasn't started answering a turn by STILL_THINKING_MS: you know it heard you. */
export const STILL_THINKING_LINE = 'One moment.'
/** A commit or push asked for without the user's yes to it (§24.16). */
export const NEEDS_YES_LINE = 'That commits or pushes code. Should I go ahead?'
/** Its first words usually come in 1–2.5 s; past this, the silence needs filling. */
export const STILL_THINKING_MS = 4000

/**
 * How long the voice model may take to start answering before it is asked
 * again, once. Its first words usually come in 1–2.5 s; 2026-10-14's log has
 * one at 25 s and one turn that never got any, its words left unanswered.
 */
export const FIRST_WORD_MS = 12_000
/** The longest one answer may run, start to end. */
export const REPLY_MS = 45_000

/** Enough conversation for context, small enough to stay fast. */
const MAX_HISTORY = 24
const MAX_HISTORY_CHARS = 12_000
/** The agent's answer kept in the conversation: enough to answer "what did it find?". */
const REPORT_CHARS = 2_000

type Message = { role: 'user' | 'assistant'; content: string }

type Reply = {
  /** `turn`: answering you; `report`: saying what the agent found. */
  kind: 'turn' | 'report'
  /** What you said (a turn), or the report request (a report). */
  userText: string
  ctrl: AbortController
  contextId: string | null
  stream: TtsStream | null
  splitter: SentenceSplitter
  /** What has been said so far (captions, and audio when `stream` is set). */
  said: string
  handedOff: boolean
  finished: boolean
  /** Chunks that arrived while held (you may be talking); played in order on release. */
  backlog: ResponderChunk[]
  /** The model call has ended; the reply settles once the backlog is played. */
  streamDone: boolean
  failed: string | null
  /** A report: what the agent's answer was, to read from if the voice model fails. */
  report?: string
  /** The model chose to say nothing (it heard a sound, not you). */
  quiet: boolean
  /** Waiting out an unfinished phrase before the model call starts. */
  startTimer: unknown
  /** Says STILL_THINKING_LINE if nothing has come by then. */
  stillTimer: unknown
  /** The model has begun its answer (words still held for a whole sentence count). */
  begun: boolean
  /** The turns this answers (yours, joined): marked unanswered on screen if it stays quiet. */
  turnIds: string[]
  /** Its stop_agent already ran while held: only the words are left to say. */
  stopped: boolean
  /** Whole sentences spoken so far; past MAX_SPOKEN_SENTENCES the rest is only shown. */
  sentences: number
  /** Words past the cap: shown on screen with the reply, never spoken. */
  overflow: string
  /** App actions this reply called (app_action), in order, as they settle. */
  actions: Array<Promise<AppActionOutcome>>
}

/** How an app action went, in words the voice can say. */
export type AppActionOutcome = { ok: boolean; message: string }

export class VoiceResponder {
  /** Counts disposals: an action that settles after one says nothing. */
  private generation = 0
  private history: Message[] = []
  private reply: Reply | null = null
  /** The agent's spoken result, a sentence at a time, until it joins the conversation. */
  private agentReport = ''
  /** How the agent's last run ended, for the report. */
  private agentOutcome: 'done' | 'error' | 'cancelled' = 'done'
  /** The agent finished while the voice was answering you: report once that answer is done. */
  private pendingReport = false
  /** Your words from an answer cut off before it said anything: they start your next turn. */
  private carried = ''
  /** A commit or push asked for while the voice model was out, waiting for your yes (§24.16). */
  private heldCommit = ''
  private carriedIds: string[] = []
  /** What the voice said between turns (a hand-off that never went), until it joins the conversation. */
  private notes = ''
  /**
   * You may be talking (a sound while the agent had the floor): nothing new is
   * said until it's clear whether that was words. The model call goes on.
   */
  private held = false

  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: ResponderDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /** A reply is being worked out and nothing of it has been said yet. */
  get pendingUnspoken(): boolean {
    return this.reply !== null && !this.reply.finished && this.reply.said === '' && !this.reply.handedOff
  }

  /** A reply (an answer or a report) is still being worked out or spoken. */
  get busy(): boolean {
    return this.reply !== null && !this.reply.finished
  }

  /**
   * A sound that may be you talking: hold what the voice would say next.
   * Nothing is cancelled, so a cough costs nothing (B2); words that follow
   * replace an answer not yet said, as before (D-43).
   */
  hold(): void {
    this.held = true
  }

  /** It wasn't words after all: say what was held, in order. */
  release(): void {
    if (!this.held) return
    this.held = false
    const reply = this.reply
    if (reply && !reply.finished) this.drain(reply)
  }

  get holding(): boolean {
    return this.held
  }

  /** The reply now being spoken, for flushing on a barge-in. */
  get speakingContext(): string | null {
    return this.reply?.contextId ?? null
  }

  /**
   * Answer what you said. A reply still being worked out with nothing said
   * yet is replaced, and its words joined to these: one stretch of talk is
   * one turn (D-43). One already speaking is cut off and kept as said.
   */
  respond(text: string, opts?: { waitMs?: number; turnId?: string }): void {
    let userText = [this.carried, text.trim()].filter(Boolean).join(' ')
    let turnIds = [...this.carriedIds, ...(opts?.turnId ? [opts.turnId] : [])]
    this.carried = ''
    this.carriedIds = []
    this.held = false
    const prev = this.reply
    if (prev && !prev.finished) {
      if (this.pendingUnspoken && prev.kind === 'turn') {
        userText = `${prev.userText} ${userText}`
        turnIds = [...prev.turnIds, ...turnIds]
        this.abort(prev, false)
      } else if (this.pendingUnspoken) {
        // A report not yet said: its answer stays in the conversation, and yours comes next.
        this.abort(prev, false)
        if (prev.report) this.agentReport = prev.report
      } else {
        this.interrupt()
      }
    }
    if (!userText) return
    // Your words come first; the agent's answer is in the conversation for them.
    this.pendingReport = false
    this.flushAgentReport()
    const chat = this.deps.chat()
    if (!chat) {
      // No voice model: the turn is the brief, as before D-44.
      this.remember({ role: 'user', content: userText })
      const brief = this.fallbackBrief(userText)
      if (brief === null) {
        this.deps.done({ audible: this.speakLine(NEEDS_YES_LINE), handedOff: false })
        return
      }
      this.deps.handOff(brief)
      this.deps.done({ audible: false, handedOff: true })
      return
    }
    this.heldCommit = ''
    this.start(chat, 'turn', userText, RESPONDER_TOOLS, undefined, opts?.waitMs, turnIds)
  }

  /**
   * The agent's final answer, whether or not it was spoken (B5): the voice
   * must know what it found, or "is it done?" turns into a new job.
   */
  agentFinished(answer: string, outcome: 'done' | 'error' | 'cancelled' = 'done'): void {
    const text = answerForVoice(answer)
    if (!text) return
    this.agentReport = text
    this.agentOutcome = outcome
  }

  /** The agent's run failed: why, in its own words, so "what went wrong?" can be answered. */
  agentFailed(message: string): void {
    const why = redactSecretsInText(clip(message, 300))
    if (!why) return
    this.agentReport = `${this.agentReport} It stopped with an error: ${why}`.trim()
    this.agentOutcome = 'error'
  }

  /**
   * Say what the agent found, in the voice's words (B7). False when there's
   * no voice model (the caller reads a summary instead). An answer to you in
   * progress goes first; the report follows it.
   */
  reportResult(): boolean {
    const chat = this.deps.chat()
    if (!chat || !this.agentReport) return false
    if (this.busy) {
      this.pendingReport = true
      return true
    }
    this.startReport(chat)
    return true
  }

  private startReport(chat: ResponderChat): void {
    this.pendingReport = false
    const report = this.agentReport
    this.agentReport = ''
    if (!report) return
    this.start(chat, 'report', reportRequest(report, this.agentOutcome), [], report)
  }

  private start(
    chat: ResponderChat,
    kind: Reply['kind'],
    userText: string,
    tools: ToolDefinition[],
    report?: string,
    waitMs?: number,
    turnIds: string[] = []
  ): void {
    const reply: Reply = {
      kind,
      userText,
      ctrl: new AbortController(),
      contextId: null,
      stream: null,
      splitter: new SentenceSplitter(24),
      said: '',
      handedOff: false,
      finished: false,
      backlog: [],
      streamDone: false,
      failed: null,
      ...(report ? { report } : {}),
      quiet: false,
      startTimer: null,
      stillTimer: null,
      begun: false,
      turnIds,
      stopped: false,
      actions: [],
      sentences: 0,
      overflow: ''
    }
    this.reply = reply
    if (waitMs && waitMs > 0) {
      // Nothing is said meanwhile, so more words from you still join this turn (D-43).
      reply.startTimer = this.setTimer(() => {
        reply.startTimer = null
        if (!reply.finished) void this.run(chat, reply, tools)
      }, waitMs)
      return
    }
    void this.run(chat, reply, tools)
  }

  /**
   * Barge-in: stop now. What was said stays in the conversation, marked as
   * cut off. An answer that hadn't said anything yet is dropped, and your
   * words carry into your next turn: one stretch of talk, one turn (D-43).
   */
  interrupt(): string | null {
    this.held = false
    const reply = this.reply
    if (!reply || reply.finished) return null
    const contextId = reply.contextId
    if (this.pendingUnspoken) {
      // Your words carry into your next turn; an unsaid report stays in the conversation.
      if (reply.kind === 'turn') {
        this.carried = reply.userText
        this.carriedIds = reply.turnIds
      } else if (reply.report) this.agentReport = reply.report
      this.abort(reply, false)
    } else {
      this.abort(reply, true)
    }
    return contextId
  }

  /** Words carried from a cut-off answer are waiting for your next turn. */
  get hasCarried(): boolean {
    return this.carried !== ''
  }

  /** What cut the answer off was a cough, not words: answer the carried ones after all. */
  answerCarried(): void {
    if (this.carried) this.respond('')
  }

  /**
   * A brief it handed off never reached the agent (no task open, or the task
   * refused it). Said on its own, and noted so the voice doesn't later claim
   * the agent is on it. Whether it will be heard.
   */
  handOffFailed(line: string): boolean {
    this.notes = `${this.notes} ${line} (Nothing was handed to the agent.)`.trim()
    return this.speakLine(line)
  }

  /**
   * Called by name after being muted until called: noted before the next turn,
   * or the voice still believes it is muted and says so (2026-10-15 live check:
   * "The mute was set a moment ago, so I shouldn't be replying right now").
   */
  woken(): void {
    this.notes = `${this.notes} (The user called me by name: I'm listening and answering again.)`.trim()
  }

  /** The agent said this out loud (its result): it joins the conversation before your next turn. */
  agentSaid(text: string): void {
    this.agentReport = `${this.agentReport} ${text}`.trim()
  }

  private flushAgentReport(): void {
    // Said between turns (a hand-off that didn't go): the voice's own words, before your next turn.
    if (this.notes) {
      this.remember({ role: 'assistant', content: this.notes })
      this.notes = ''
    }
    if (!this.agentReport) return
    this.remember({ role: 'assistant', content: `${AGENT_PREFIX}${this.agentReport}` })
    this.agentReport = ''
  }

  dispose(): void {
    this.generation++
    if (this.reply && !this.reply.finished) this.abort(this.reply, false)
    this.reply = null
    this.carried = ''
    this.carriedIds = []
    this.notes = ''
    this.held = false
    this.pendingReport = false
  }

  /**
   * Voice mode moved to another task: what was said about the last one goes,
   * so "is it done?" means this task's work. The new task's own conversation
   * comes with every turn (`taskContext`). An answer in progress carries on.
   */
  forget(): void {
    this.history = []
    this.agentReport = ''
    this.agentOutcome = 'done'
    this.notes = ''
    this.carried = ''
    this.carriedIds = []
    this.pendingReport = false
  }

  /**
   * The last voice conversation on this task, from before this session: its
   * memory to start from. Only into an empty conversation, so nothing said in
   * this session is reordered.
   */
  recall(past: ReadonlyArray<{ role: 'user' | 'assistant'; content: string }>): void {
    if (this.history.length > 0 || past.length === 0) return
    past.forEach((m, i) => this.remember(i === 0 ? { role: m.role, content: `${PAST_HEADER}\n${m.content}` } : { ...m }))
  }

  // ── The model call ─────────────────────────────────────────────────────

  private async run(chat: ResponderChat, reply: Reply, tools: ToolDefinition[]): Promise<void> {
    const messages: ChatMessage[] = [...this.history]
    const last = messages.at(-1)
    // Roles alternate: a report after your unanswered words joins them.
    if (last?.role === 'user') messages[messages.length - 1] = { role: 'user', content: `${last.content}\n${reply.userText}` }
    else messages.push({ role: 'user', content: reply.userText })
    // Nothing yet after a few seconds: say so, once, so you know it heard you.
    if (reply.kind === 'turn') {
      reply.stillTimer = this.setTimer(() => {
        reply.stillTimer = null
        if (!reply.finished && !this.held && !reply.begun) {
          this.speakLine(STILL_THINKING_LINE)
        }
      }, STILL_THINKING_MS)
    }
    // One more try when the model is slow to start or says nothing at all: a
    // turn that ends in silence is your words on screen and no answer.
    for (let attempt = 0; attempt < 2; attempt++) {
      const outcome = await this.call(chat, reply, tools, messages)
      if (reply.finished) return
      if (outcome === 'answered' || outcome === 'failed') break
      const retry = attempt === 0
      this.deps.onTrouble?.(outcome, retry)
      if (retry) continue
      if (outcome === 'timeout') reply.failed = 'The voice model did not answer in time'
      // Said nothing twice: a report reads the agent's answer instead; a turn asks again (`finish`).
      else if (reply.kind === 'report') reply.failed = 'The voice model said nothing'
    }
    this.stopStillTimer(reply)
    if (reply.finished) return
    reply.streamDone = true
    // Held: `release` plays the backlog and settles; words from you replace it instead.
    if (!this.held) this.settle(reply)
  }

  /**
   * One model call. `answered`: it said or did something; `empty`: it ended
   * with neither; `timeout`: no first word within FIRST_WORD_MS (an answer
   * that started is cut at REPLY_MS and kept); `failed`: it errored.
   */
  private async call(
    chat: ResponderChat,
    reply: Reply,
    tools: ToolDefinition[],
    messages: ChatMessage[]
  ): Promise<'answered' | 'empty' | 'timeout' | 'failed'> {
    const ctrl = new AbortController()
    const startedAt = this.deps.now()
    let produced = false
    let errored = false
    // A provider that ignores its signal must not hang the turn: every wait is raced.
    let stop: () => void = () => {}
    const aborted = new Promise<typeof TIMED_OUT>((resolve) => {
      stop = () => {
        ctrl.abort()
        resolve(TIMED_OUT)
      }
    })
    if (reply.ctrl.signal.aborted) stop()
    else reply.ctrl.signal.addEventListener('abort', stop)
    try {
      const iterator = chat({
        system: RESPONDER_SYSTEM,
        status: this.statusLine(),
        messages,
        tools,
        signal: ctrl.signal
      })[Symbol.asyncIterator]()
      for (;;) {
        const deadline = startedAt + (produced ? REPLY_MS : FIRST_WORD_MS)
        let timer: unknown = null
        const timedOut = new Promise<typeof TIMED_OUT>((resolve) => {
          timer = this.setTimer(() => resolve(TIMED_OUT), Math.max(0, deadline - this.deps.now()))
        })
        let next: IteratorResult<ResponderChunk> | typeof TIMED_OUT
        try {
          next = await Promise.race([iterator.next(), timedOut, aborted])
        } finally {
          this.clearTimer(timer)
        }
        if (reply.finished) return 'answered'
        if (next === TIMED_OUT) {
          ctrl.abort()
          void Promise.resolve(iterator.return?.()).catch(() => {})
          return produced ? 'answered' : 'timeout'
        }
        if (next.done) break
        const chunk = next.value
        if ((chunk.type === 'text' && chunk.text.trim()) || (chunk.type === 'tool_call' && !refusedQuiet(reply, chunk.name))) {
          produced = true
          reply.begun = true
        }
        if (chunk.type === 'error') errored = true
        if (this.held) {
          // A stop can't wait for a sound to turn out to be words (2026-10-15: 7 s late). Its words still wait.
          if (chunk.type === 'tool_call' && chunk.name === STOP_TOOL && !reply.stopped) {
            reply.stopped = true
            this.deps.stopAgent()
          }
          reply.backlog.push(chunk)
        } else this.take(reply, chunk)
      }
    } catch (err) {
      if (reply.finished) return 'answered'
      reply.failed = err instanceof Error ? err.message : String(err)
      return 'failed'
    } finally {
      reply.ctrl.signal.removeEventListener('abort', stop)
    }
    if (produced) return 'answered'
    return errored ? 'failed' : 'empty'
  }

  private take(reply: Reply, chunk: ResponderChunk): void {
    if (chunk.type === 'text') this.speak(reply, chunk.text)
    else if (chunk.type === 'tool_call') this.tool(reply, chunk.name, chunk.arguments)
    else if (chunk.type === 'done' && chunk.usage) this.deps.onUsage?.(chunk.usage)
    else if (chunk.type === 'error') reply.failed = chunk.message
  }

  /** Play what was held, in order, then settle if the call has ended. */
  private drain(reply: Reply): void {
    for (const chunk of reply.backlog.splice(0)) {
      if (reply.finished) return
      this.take(reply, chunk)
    }
    if (reply.streamDone && !reply.finished) this.settle(reply)
  }

  private settle(reply: Reply): void {
    const failed = reply.failed
    if (failed !== null && !reply.said && !reply.handedOff) {
      reply.finished = true
      this.reply = null
      if (reply.kind === 'report') {
        // No voice model to say it: read the start of the agent's answer instead.
        this.remember({ role: 'user', content: reply.userText })
        const summary = fallbackSummary(reply.report ?? '')
        const audible = summary ? this.speakLine(summary) : false
        this.deps.done({ audible, handedOff: false, failed: { message: failed } })
        this.afterReply()
        return
      }
      // The voice model is down: the work still gets done (D-44).
      this.remember({ role: 'user', content: reply.userText })
      const brief = this.fallbackBrief(reply.userText)
      if (brief === null) {
        this.deps.done({ audible: this.speakLine(NEEDS_YES_LINE), handedOff: false, failed: { message: failed } })
        this.afterReply()
        return
      }
      const audible = this.speakLine(FALLBACK_LINE)
      this.deps.handOff(brief)
      this.deps.done({ audible, handedOff: true, failed: { message: failed } })
      this.afterReply()
      return
    }
    this.finish(reply)
  }

  private tool(reply: Reply, name: string, args: string): void {
    if (name === HAND_OFF_TOOL) {
      const brief = parseBrief(args) || reply.userText
      // A commit or a push goes only after a yes to it (§24.16): the turn this answers must be one.
      if (asksToCommitOrPush(brief) && !(parseConfirmed(args) && confirmsAction(reply.userText))) {
        // Said even after its own words: "Committing it now" with nothing sent would be untrue.
        // Heard even past the three-sentence cap: a question shown only as a caption can't be answered.
        this.flushSaid(reply)
        reply.sentences = Math.min(reply.sentences, MAX_SPOKEN_SENTENCES - 2)
        this.speak(reply, `${NEEDS_YES_LINE} `)
        this.flushSaid(reply)
        return
      }
      reply.handedOff = true
      // Spoken before the work shows as handed over, in the order you hear it.
      this.flushSaid(reply)
      if (!reply.said) {
        this.speak(reply, `${HAND_OFF_LINE} `)
        this.flushSaid(reply)
      }
      this.deps.handOff(brief)
      return
    }
    if (name === STOP_TOOL) {
      if (!reply.stopped) this.deps.stopAgent()
      reply.stopped = true
      if (!reply.said) this.speak(reply, `${STOP_LINE} `)
      return
    }
    if (name === QUIET_TOOL) {
      if (!refusedQuiet(reply, name)) reply.quiet = true
      return
    }
    if (name === APP_TOOL) {
      const call = parseAppCall(args)
      const run = this.deps.appAction
      reply.actions.push(
        !call
          ? Promise.resolve({ ok: false, message: 'I didn’t catch what to do.' })
          : run
            ? run(call).catch((err: unknown) => ({ ok: false, message: err instanceof Error ? err.message : 'It didn’t work.' }))
            : Promise.resolve({ ok: false, message: 'I can’t do that from here.' })
      )
    }
  }

  private finish(reply: Reply): void {
    // Handed off in silence: say something, so you know it heard you.
    // Words still held for a whole sentence count as said.
    this.flushSaid(reply)
    if (reply.handedOff && !reply.said) this.speak(reply, `${HAND_OFF_LINE} `)
    // Nothing at all, and not by choice: your words never sit unanswered.
    else if (reply.kind === 'turn' && !reply.said && !reply.quiet && reply.actions.length === 0) this.speak(reply, `${EMPTY_LINE} `)
    this.flushSaid(reply)
    this.showOverflow(reply)
    reply.stream?.end()
    reply.finished = true
    if (this.reply === reply) this.reply = null
    this.remember({ role: 'user', content: reply.userText })
    const said = reply.said.trim()
    const content = reply.handedOff ? `${said} (handed to the agent)`.trim() : said || (reply.quiet ? '(stayed quiet)' : '')
    if (content) this.remember({ role: 'assistant', content })
    if (reply.actions.length > 0) this.settleActions(reply.actions, Boolean(said))
    this.deps.done({
      audible: Boolean(said) && reply.stream !== null,
      handedOff: reply.handedOff,
      // Chose to say nothing: the only turn that ends in silence, so it is logged.
      ...(reply.quiet && !said && !reply.handedOff ? { quiet: { chars: reply.userText.length, turnIds: reply.turnIds } } : {})
    })
    this.afterReply()
  }

  /**
   * The reply's app actions have run: what happened joins the conversation,
   * and is said when the reply said nothing, or when one failed (the reply
   * said it was on it). Never the same words twice.
   */
  private settleActions(actions: Array<Promise<AppActionOutcome>>, said: boolean): void {
    const gen = this.generation
    void Promise.all(actions).then((results) => {
      // Ended (or another session took over) while it ran: nothing here to say it to.
      if (gen !== this.generation) return
      const failed = results.filter((r) => !r.ok)
      this.notes = `${this.notes} ${results.map((r) => `(${r.ok ? 'Done' : 'Didn’t happen'}: ${r.message})`).join(' ')}`.trim()
      const lines = (failed.length > 0 ? failed : said ? [] : results).map((r) => r.message.trim()).filter(Boolean)
      const line = [...new Set(lines)].join(' ')
      if (!line) return
      // The reply is over, so this is a line of its own; its audio moves the session on as any reply's does.
      this.speakLine(line)
    })
  }

  /** The agent finished while the voice was answering you: now say what it found. */
  private afterReply(): void {
    if (!this.pendingReport || this.busy) return
    const chat = this.deps.chat()
    if (chat) this.startReport(chat)
    else this.pendingReport = false
  }

  private stopStillTimer(reply: Reply): void {
    if (reply.stillTimer) this.clearTimer(reply.stillTimer)
    reply.stillTimer = null
  }

  private abort(reply: Reply, keepSaid: boolean): void {
    reply.finished = true
    if (reply.startTimer) this.clearTimer(reply.startTimer)
    reply.startTimer = null
    this.stopStillTimer(reply)
    reply.ctrl.abort()
    reply.stream?.cancel()
    if (this.reply === reply) this.reply = null
    if (!keepSaid) return
    this.remember({ role: 'user', content: reply.userText })
    const said = reply.said.trim()
    if (said) this.remember({ role: 'assistant', content: `${said} (cut off)` })
  }

  // ── Speaking ───────────────────────────────────────────────────────────

  private speak(reply: Reply, text: string): void {
    if (!text) return
    if (!reply.contextId) {
      reply.contextId = this.deps.newId()
      // Null when nothing can speak: the words still go out as captions.
      reply.stream = this.deps.openTts(reply.contextId)
    }
    for (const piece of reply.splitter.push(text)) this.emit(reply, piece)
  }

  /** Words still held for a whole sentence go out now. */
  private flushSaid(reply: Reply): void {
    if (reply.contextId) for (const piece of reply.splitter.flush()) this.emit(reply, piece)
  }

  private emit(reply: Reply, raw: string): void {
    // A tool's name written as words (2026-10-15 live check: "stay_quiet." was spoken): never said;
    // staying quiet that way counts as staying quiet, where that's allowed.
    const toolWord = TOOL_WORD_RE.exec(raw.trim())
    if (toolWord) {
      if (toolWord[1] === QUIET_TOOL && !reply.said && mayStayQuiet(reply.userText)) reply.quiet = true
      return
    }
    // Its reasoning about you, or about its own tools, never said (2026-10-16 live check: "The user wants a fork of the
    // hello task." and "That's an app action: split_pane runs…" were read out, and, counting as said, kept the action's
    // own result from being spoken).
    if (ABOUT_USER_RE.test(raw) || INTERNAL_NAME_RE.test(raw)) return
    // A note in brackets cleans to nothing and stays nothing: it was never meant to be said.
    const note = NOTE_RE.test(raw)
    const piece = redactSecretsInText(toSpeakable(raw) || (note ? '' : raw.trim()))
    // A reply that is only a note ("staying quiet") meant to say nothing: as stay_quiet, where that's allowed.
    if (note && !piece && !reply.said && mayStayQuiet(reply.userText)) reply.quiet = true
    if (!piece || !reply.contextId) return
    reply.said += `${piece} `
    // Three sentences said; the rest is on screen (2026-10-15: a seven-sentence answer read out).
    if (reply.sentences >= MAX_SPOKEN_SENTENCES) {
      reply.overflow += `${piece} `
      return
    }
    this.deps.say(reply.contextId, piece, reply.stream !== null)
    reply.stream?.pushText(piece)
    reply.stream?.flush()
    if (SENTENCE_END_RE.test(piece)) reply.sentences++
  }

  /**
   * The words past the cap, as one more caption of the reply. Marked audible
   * when the reply speaks, so it waits behind the spoken ones and shows once
   * they have played, in order; it is never sent to the speaking model.
   */
  private showOverflow(reply: Reply): void {
    const rest = reply.overflow.trim()
    reply.overflow = ''
    if (rest && reply.contextId) this.deps.say(reply.contextId, rest, reply.stream !== null)
  }

  /** One line on its own (the fallback); whether it will be heard. */
  /**
   * Without the voice model your words are the brief (D-44), but a commit or
   * a push still waits for a yes (§24.16): held here, sent on the next turn
   * only if that turn is one. Null when it is held.
   */
  private fallbackBrief(userText: string): string | null {
    const held = this.heldCommit
    this.heldCommit = ''
    if (held && confirmsAction(userText)) return held
    if (!asksToCommitOrPush(userText)) return userText
    this.heldCommit = userText
    return null
  }

  private speakLine(text: string): boolean {
    const contextId = this.deps.newId()
    const stream = this.deps.openTts(contextId)
    this.deps.say(contextId, text, stream !== null)
    if (!stream) return false
    stream.pushText(text)
    stream.end()
    return true
  }

  // ── Context ────────────────────────────────────────────────────────────

  /** The app, the task so far, then what the agent is doing now. */
  private statusLine(): string {
    const app = this.deps.appContext?.().trim()
    const task = this.deps.taskContext?.().trim()
    const status = this.agentLine()
    return [app, task ? `${TASK_HEADER}\n${task}` : '', status].filter(Boolean).join('\n\n')
  }

  /** What the agent is doing, from its run's own events (B6): enough to answer "how's it going?". */
  private agentLine(): string {
    const s = this.deps.agentStatus()
    const now = this.deps.now()
    const steps = s.steps ? ` It has taken ${s.steps} step${s.steps === 1 ? '' : 's'}.` : ''
    // The brief's own full stop goes: the line closes it.
    const brief = s.brief ? clip(s.brief, 400).replace(/[.!?]+$/, '') : ''
    if (s.working) {
      const lines = [
        `The agent is working now${brief ? ` on: ${brief}` : ''}${s.since !== undefined ? ` (for ${spokenDuration(now - s.since)})` : ''}.${steps}`
      ]
      // Blocked on you is the one thing worth saying first: nothing moves until you answer.
      if (s.waitingOn) lines.push(`It is stopped until you answer: ${clip(s.waitingOn, 300)}`)
      else if (s.current) lines.push(`Right now it is running: ${clip(s.current, 160)}.`)
      if (s.narration) lines.push(`Its last words: “${clip(s.narration, 240)}”`)
      return lines.join('\n')
    }
    if (!brief) return 'The agent is idle.'
    const ended = s.ended
      ? ` It ${s.ended.outcome === 'done' ? 'finished' : s.ended.outcome === 'error' ? 'stopped with an error' : 'was stopped'} ${spokenDuration(now - s.ended.at)} ago.${steps}`
      : ''
    return `The agent is idle. Its last task was: ${brief}.${ended}`
  }

  private remember(entry: Message): void {
    // A conversation starts with you. What came before you spoke (the result of a run voice mode
    // opened on) goes in on your side as a note: dropping it left "what did it find?" unanswerable.
    const m: Message =
      this.history.length === 0 && entry.role === 'assistant'
        ? { role: 'user', content: `(Not the user speaking: before they spoke.) ${entry.content}` }
        : entry
    const last = this.history.at(-1)
    // Two in a row from one side (a cut-off reply, a fallback): join them, so roles alternate.
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`
    else this.history.push({ ...m })
    while (this.history.length > MAX_HISTORY) this.history.shift()
    while (this.history.length > 2 && totalChars(this.history) > MAX_HISTORY_CHARS) this.history.shift()
    // A conversation starts with you.
    while (this.history[0]?.role === 'assistant') this.history.shift()
  }
}

const AGENT_PREFIX = 'The agent reported: '
/** A spoken reply says this many sentences at most; the rest stays on screen. */
export const MAX_SPOKEN_SENTENCES = 3
const SENTENCE_END_RE = /[.!?]["'”’)\]]*$/
/** Only a note in brackets ("(Noted, staying quiet.)"). */
/** A reply piece that is only one of the voice's tool names. */
const TOOL_WORD_RE = /^[`"'(]*(stay_quiet|stop_agent|hand_to_agent|app_action)[`"')]*[.!]?$/
/** The model reasoning about "the user" in the third person; what it did to "the user" (an answer about code) is not this. */
const ABOUT_USER_RE =
  /\bthe user(?:['’]s)?\s+(?:wants?|wanted|asks?|asked|is asking|has asked|named|names|said|says|has said|just said|confirmed|has confirmed|means|meant|is referring|refers to|requested)\b/i
/** A sentence naming one of the voice's own tools, actions or commands (`split_pane`); only snake_case names, so "find" stays a word. */
const INTERNAL_NAME_RE = new RegExp(
  `(?<![\\w-])(?:${[HAND_OFF_TOOL, STOP_TOOL, QUIET_TOOL, APP_TOOL, ...APP_ACTION_NAMES, ...APP_COMMANDS].filter((n) => n.includes('_')).join('|')})(?![\\w-])`
)
const NOTE_RE = /^\s*[([][^()[\]]*[)\]][.!?]?\s*$/
const PAST_HEADER = '(Earlier, in your last voice conversation on this task:)'
const TASK_HEADER = 'The task on screen so far (oldest first; [You] is the user, [Agent] the coding agent’s answers):'
const TIMED_OUT = Symbol('timed out')

/**
 * Silence the voice may not choose: a question, or a request too long to be a
 * filler. Kept quiet, your words sat on screen unanswered; it counts as no
 * answer instead, so the model is asked again and you're never left hanging.
 */
function refusedQuiet(reply: Reply, name: string): boolean {
  return name === QUIET_TOOL && !mayStayQuiet(reply.userText)
}

/** Short, and not a question: a sound, a filler or an aside the voice may leave unanswered. */
export function mayStayQuiet(heard: string): boolean {
  return !heard.includes('?') && heard.trim().split(/\s+/).length <= QUIET_MAX_WORDS
}

function parseAppCall(args: string): { action: string; args: unknown; confirmed: boolean } | null {
  try {
    const parsed = JSON.parse(args || '{}') as { action?: unknown; args?: unknown; confirmed?: unknown }
    if (typeof parsed.action !== 'string' || !parsed.action.trim()) return null
    return { action: parsed.action.trim(), args: parsed.args ?? {}, confirmed: parsed.confirmed === true }
  } catch {
    return null
  }
}

function parseConfirmed(args: string): boolean {
  try {
    return (JSON.parse(args || '{}') as { confirmed?: unknown }).confirmed === true
  } catch {
    return false
  }
}

function parseBrief(args: string): string {
  try {
    const parsed = JSON.parse(args || '{}') as { brief?: unknown }
    return typeof parsed.brief === 'string' ? parsed.brief.trim() : ''
  } catch {
    return ''
  }
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** Like `clip`, but keeps line breaks: a report's lists and tables stay readable to the model. */
function clipBlock(text: string, max: number): string {
  const block = text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return block.length > max ? `${block.slice(0, max - 1)}…` : block
}

/** "45 seconds", "3 minutes 10 seconds": how long, as the voice would say it. */
export function spokenDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  if (total < 90) return `${total} second${total === 1 ? '' : 's'}`
  const m = Math.floor(total / 60)
  const s = total % 60
  return s ? `${m} minutes ${s} seconds` : `${m} minutes`
}

function totalChars(messages: Message[]): number {
  return messages.reduce((n, m) => n + m.content.length, 0)
}
