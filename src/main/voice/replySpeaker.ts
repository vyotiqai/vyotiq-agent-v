/**
 * Speaking the agent's reply during a live session (docs/voice-mode.md §7.3,
 * §7.4, §8). Fed the followed run's events through the run tap:
 *
 *  - the final answer's `<spoken>` block is spoken as it streams, sentence by
 *    sentence; an answer without one gets a short fallback summary;
 *  - narration between tool steps is not spoken (B4); a slow tool gets one
 *    short cue instead, if the person wants spoken progress;
 *  - a retried stream (`stream_reset`) drops what wasn't said yet;
 *  - one answer is said per turn: a check that sends the agent back after it
 *    answered (the verification gate, a done-when reminder, a Stop hook) ends
 *    in a second final message, which replaces the result but isn't said again;
 *  - after a barge-in nothing more is said until the person's next turn (B5).
 *
 * It knows nothing about audio devices or IPC: it opens text-to-speech
 * streams through an injected factory and reports to the session.
 */
import type { AgentEvent } from '../../shared/ipc'
import { SpokenStreamParser, extractSpokenBlock } from '../../shared/spokenSummary'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import type { TtsStream } from './providers/types'
import { SentenceSplitter, fallbackSummary, toSpeakable } from './speechText'

/** Wait this long into a tool before mentioning it; quick tools pass in silence. */
export const CUE_DELAY_MS = 1500
/** At most one progress cue this often. */
export const CUE_GAP_MS = 6000

export const RUN_FAILED_LINE = 'That run hit an error. The details are on screen.'

/**
 * What a run's failure was, in words, by the run's error code. "That run hit
 * an error" alone left the person to find out at the screen that the
 * provider was out of credit (seen 2026-10-14: PROVIDER_BILLING, said as the
 * bare line).
 */
export function runFailedLine(code: string | undefined): string {
  switch (code) {
    case 'PROVIDER_BILLING':
      return 'That run stopped: the model provider is out of credit. The details are on screen.'
    case 'PROVIDER_AUTH':
    case 'PROVIDER_KEYCHAIN':
    case 'PROVIDER_KEY_DECRYPT':
      return 'That run stopped: the model provider didn’t accept the key. The details are on screen.'
    case 'PROVIDER_NETWORK':
    case 'PROVIDER_TIMEOUT':
      return 'That run stopped: the model provider couldn’t be reached. The details are on screen.'
    case 'PROVIDER_HTTP':
    case 'PROVIDER_STREAM':
    case 'PROVIDER_REQUEST':
      return 'That run stopped: the model provider returned an error. The details are on screen.'
    default:
      return RUN_FAILED_LINE
  }
}

export type ReplySpeakerDeps = {
  /** A text-to-speech stream for one spoken piece, or null when nothing can speak. */
  openTts: (contextId: string) => TtsStream | null
  /** What is being said, for captions. */
  say: (contextId: string, text: string) => void
  /** The agent started a tool (the orb shows it working). */
  onToolStart: () => void
  /** The run ended; `failed` when it errored. */
  onRunEnd: () => void
  speakProgress: () => boolean
  /** A slow step started and spoken progress is off: the renderer plays a soft sound. */
  quietCue?: () => void
  newId: () => string
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
}

type Reply = { contextId: string; stream: TtsStream; splitter: SentenceSplitter }

/** A short spoken cue for a tool that's taking a while (§8.4), or null for none. */
export function cueForTool(name: string, summary: string): string | null {
  const text = `${name} ${summary}`.toLowerCase()
  // The web tools first: "web_search" would otherwise read as searching the code.
  if (/^web_search$/.test(name.toLowerCase())) return 'Searching the web.'
  if (/^web_fetch$/.test(name.toLowerCase())) return 'Reading a web page.'
  if (/\btests?\b|vitest|jest|pytest|cargo test|go test|spec\b/.test(text)) return 'Running the tests.'
  if (/\b(build|compile|tsc|webpack|vite build)\b/.test(text)) return 'Building it.'
  if (/install|pnpm add|npm i\b|pip install/.test(text)) return 'Installing dependencies.'
  if (/browser|navigate|screenshot/.test(text)) return 'Checking in the browser.'
  if (/edit|write|patch|apply|create_file|replace/.test(name.toLowerCase())) return 'Making the change.'
  if (/search|grep|glob|read|list|find|codebase/.test(name.toLowerCase())) return 'Looking through the code.'
  if (/terminal|shell|command|bash|run/.test(name.toLowerCase())) return 'Running a command.'
  return null
}

/** Speaking streams reopened in one turn after a failure; past this, the reply is on screen only. */
export const MAX_STREAM_REOPENS = 1

export class ReplySpeaker {
  private parser = new SpokenStreamParser()
  /** This step's spoken block closed and its last sentence was let go. */
  private blockClosed = false
  /** They spoke while it worked: its next message answers them, out loud. */
  private owesAnswer = false
  private stepText = ''
  private reply: Reply | null = null
  private quiet = false
  private active = false
  private lastCueAt = Number.NEGATIVE_INFINITY
  private cueTimers = new Map<string, unknown>()
  /** The run's latest final answer, until the run ends; `spoken` once its block was said. */
  private answer: { text: string; spoken: boolean } | null = null
  /** An answer was already said this turn; a later one is shown and kept, not said. */
  private heard = false
  /** The run's last error event, said and kept if the run then ends in error. */
  private runError: { message: string; code?: string } | null = null
  /** Speaking streams that failed this turn; past `MAX_STREAM_REOPENS` the rest stays on screen only. */
  private streamFailures = 0

  constructor(private readonly deps: ReplySpeakerDeps) {}

  /** The followed run is still working. */
  get runActive(): boolean {
    return this.active
  }

  /** A new turn was sent: speak again, from a clean step. */
  beginTurn(): void {
    this.quiet = false
    this.active = true
    this.heard = false
    this.streamFailures = 0
    this.resetStep()
  }

  /**
   * You took your turn: what the agent says next (its result) is spoken
   * again. Talking over it stops its voice, never its work (D-46), so the
   * result still matters after a barge-in.
   */
  resume(): void {
    this.quiet = false
  }

  /** Barge-in: stop speaking now. Returns the reply to flush from the speakers, if any. */
  interrupt(): string | null {
    this.quiet = true
    this.clearCues()
    const reply = this.reply
    this.reply = null
    reply?.stream.cancel()
    return reply?.contextId ?? null
  }

  handle(ev: AgentEvent): void {
    switch (ev.type) {
      case 'status':
        if (ev.status === 'running') {
          // Once per invoke, as the gate nudges once per invoke: a turn typed in the task is said too.
          this.active = true
          this.heard = false
          this.runError = null
          return
        }
        this.active = false
        this.clearCues()
        this.settleAnswer(ev.status === 'done')
        if (ev.status === 'error') this.speakOnce(runFailedLine(this.runError?.code))
        this.runError = null
        this.finishReply()
        this.deps.onRunEnd()
        return
      case 'text_delta': {
        this.stepText += ev.text
        const spoken = this.parser.push(ev.text)
        if (spoken && !this.heard) this.speak(spoken)
        this.closeBlock()
        return
      }
      case 'error':
        this.runError = { message: ev.message, ...(ev.code ? { code: ev.code } : {}) }
        return
      case 'follow_up_applied':
        // A follow-up is a new turn inside the same run: its answer is said.
        this.heard = false
        this.owesAnswer = ev.messages.some((m) => m.role === 'user' && m.spoken === true)
        return
      case 'stream_reset':
        // What was said can't be unsaid; what wasn't, won't be.
        this.resetStep()
        this.reply?.stream.cancel()
        this.reply = null
        return
      case 'tool_start':
        this.deps.onToolStart()
        this.scheduleCue(ev.toolCallId, ev.name, ev.summary)
        return
      case 'tool_result':
        this.cancelCue(ev.toolCallId)
        return
      case 'assistant_message': {
        const tail = this.parser.end()
        if (tail && !this.heard) this.speak(tail)
        this.closeBlock()
        const final = !ev.toolCalls || ev.toolCalls.length === 0
        if (!final && this.owesAnswer && !this.heard && this.parser.phase === 'absent') {
          // The answer to what they said while it worked, written without a <spoken> block:
          // said anyway. 2026-10-16 probe: "What are you doing right now?" was answered on
          // screen ("I'm waiting on the 15-second sleep command") and never out loud.
          // Not when it is the model talking to itself about the person: "The user asks to quit the app.
          // Quitting needs their OK…" was read out (2026-10-16 probe, §27.11).
          const summary = narratesAboutUser(ev.content ?? '') ? '' : fallbackSummary(ev.content ?? '')
          if (summary) {
            this.speak(`${summary} `)
            this.owesAnswer = false
          }
        }
        // Answered in a block, or the final answer (said or summarised as ever); a bare tool call answers nothing.
        if (final || this.parser.phase === 'after') this.owesAnswer = false
        // The step's words are all out: its speech closes now. Held open across the tools that follow,
        // it kept progress cues away for the rest of the run and left the vendor's stream idle.
        if (!final) this.finishReply()
        if (final) {
          const answer = ev.content || this.stepText
          // Already said this turn: this one only replaces the result.
          let spoken = this.heard || this.parser.phase !== 'absent'
          if (!spoken) {
            // A reply that arrived whole, with no deltas, still has its block: speak that, never the tags (A-20).
            const block = extractSpokenBlock(answer)
            if (block) {
              this.speak(`${block} `)
              spoken = true
            }
          }
          // Settled when the run ends: a check after this answer can still send the agent back to work.
          this.answer = { text: answer, spoken }
          if (spoken) this.heard = true
          this.finishReply()
        }
        this.resetStep()
        return
      }
      default:
        return
    }
  }

  /**
   * This reply's speaking stream failed. The next sentence opens a new one
   * rather than going to a dead stream, unheard; after a second failure in
   * the turn the rest stays on screen (§15).
   */
  streamFailed(contextId: string): void {
    if (this.reply?.contextId !== contextId || this.streamFailures >= MAX_STREAM_REOPENS) return
    this.streamFailures++
    this.reply.stream.cancel()
    this.reply = null
  }

  dispose(): void {
    this.clearCues()
    this.reply?.stream.cancel()
    this.reply = null
    this.answer = null
  }

  /**
   * The run ended: its last answer is settled. One without a `<spoken>` block
   * is said as a short summary (B7); one silenced or failed isn't said.
   */
  private settleAnswer(done: boolean): void {
    const answer = this.answer
    this.answer = null
    if (!answer) return
    if (answer.spoken || !done || this.quiet) return
    const summary = fallbackSummary(answer.text)
    if (summary) this.speak(`${summary} `)
  }

  // ── Speaking ─────────────────────────────────────────────────────────────

  /**
   * Raw streamed text in; whole sentences out. Cleaning happens per sentence,
   * never per fragment: a word can arrive split across two deltas.
   */
  private speak(text: string): void {
    if (this.quiet || !text) return
    const reply = this.ensureReply()
    if (!reply) return
    for (const piece of reply.splitter.push(text)) this.emitPiece(reply, piece)
  }

  private emitPiece(reply: Reply, raw: string): void {
    // Never send a secret the agent read to a speech vendor (D-10).
    const piece = redactSecretsInText(toSpeakable(raw) || raw.trim())
    // No words in it: "<spoken>…</spoken>" after "keep quiet until I call you" was its
    // way of saying nothing, and the speaker read it out as "…." (2026-10-17 probe).
    if (!piece || !/[\p{L}\p{N}]/u.test(piece)) return
    this.deps.say(reply.contextId, piece)
    reply.stream.pushText(piece)
    reply.stream.flush()
  }

  private ensureReply(): Reply | null {
    if (this.reply) return this.reply
    const contextId = this.deps.newId()
    const stream = this.deps.openTts(contextId)
    if (!stream) return null
    this.reply = { contextId, stream, splitter: new SentenceSplitter() }
    return this.reply
  }

  private finishReply(): void {
    const reply = this.reply
    this.reply = null
    if (!reply) return
    for (const piece of reply.splitter.flush()) this.emitPiece(reply, piece)
    reply.stream.end()
  }

  /**
   * Say one line now, even after a barge-in: the agent is asking the person
   * something (an approval), which is exactly when they're listening.
   */
  announce(text: string): void {
    this.quiet = false
    this.speakOnce(text)
  }

  /** A whole line said on its own (a cue, a failure), separate from the reply. */
  private speakOnce(text: string): void {
    if (this.quiet) return
    this.finishReply()
    const contextId = this.deps.newId()
    const stream = this.deps.openTts(contextId)
    if (!stream) return
    this.deps.say(contextId, text)
    stream.pushText(text)
    stream.end()
  }

  // ── Progress cues (§8.4) ─────────────────────────────────────────────────

  private scheduleCue(toolCallId: string, name: string, summary: string): void {
    if (this.quiet) return
    const spoken = this.deps.speakProgress()
    const cue = cueForTool(name, summary)
    // Off still marks a slow step, with a sound (§8.4); only known kinds of step get either.
    if (!cue || (!spoken && !this.deps.quietCue)) return
    const timer = this.deps.setTimer(() => {
      this.cueTimers.delete(toolCallId)
      if (this.quiet || this.reply) return
      const now = this.deps.now()
      if (now - this.lastCueAt < CUE_GAP_MS) return
      this.lastCueAt = now
      if (spoken) this.speakOnce(cue)
      else this.deps.quietCue?.()
    }, CUE_DELAY_MS)
    this.cueTimers.set(toolCallId, timer)
  }

  private cancelCue(toolCallId: string): void {
    const t = this.cueTimers.get(toolCallId)
    if (t !== undefined) this.deps.clearTimer(t)
    this.cueTimers.delete(toolCallId)
  }

  private clearCues(): void {
    for (const t of this.cueTimers.values()) this.deps.clearTimer(t)
    this.cueTimers.clear()
  }

  /**
   * The step's spoken block just closed: its last sentence is complete, so it
   * goes now. Left in the splitter it waited for the next step's block and ran
   * into it ("Setting the voice orb to cloud now.The orb is now set", 2026-10-16
   * probe), heard late and as one sentence.
   */
  private closeBlock(): void {
    if (this.blockClosed || this.parser.phase !== 'after') return
    this.blockClosed = true
    if (!this.heard) this.speak(' ')
  }

  private resetStep(): void {
    this.parser = new SpokenStreamParser()
    this.stepText = ''
    this.blockClosed = false
  }
}

/** The model narrating its own steps about the person ("The user confirmed…"), not words for them. */
export function narratesAboutUser(text: string): boolean {
  return /\b(?:the user|user['’]s|the person)\b/i.test(text)
}
