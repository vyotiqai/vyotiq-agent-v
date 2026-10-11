/**
 * Speaking the agent's reply during a live session (docs/voice-mode.md §7.3,
 * §7.4, §8). Fed the followed run's events through the run tap:
 *
 *  - the final answer's `<spoken>` block is spoken as it streams, sentence by
 *    sentence; an answer without one gets a short fallback summary;
 *  - narration between tool steps is not spoken (B4); a slow tool gets one
 *    short cue instead, if the person wants spoken progress;
 *  - a retried stream (`stream_reset`) drops what wasn't said yet;
 *  - after a barge-in nothing more is said until the person's next turn (B5).
 *
 * It knows nothing about audio devices or IPC: it opens text-to-speech
 * streams through an injected factory and reports to the session.
 */
import type { AgentEvent } from '../../shared/ipc'
import { SpokenStreamParser } from '../../shared/spokenSummary'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'
import type { TtsStream } from './providers/types'
import { SentenceSplitter, fallbackSummary, toSpeakable } from './speechText'

/** Wait this long into a tool before mentioning it; quick tools pass in silence. */
export const CUE_DELAY_MS = 1500
/** At most one progress cue this often. */
export const CUE_GAP_MS = 6000

export const RUN_FAILED_LINE = 'That run hit an error. The details are on screen.'

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
  if (/\btests?\b|vitest|jest|pytest|cargo test|go test|spec\b/.test(text)) return 'Running the tests.'
  if (/\b(build|compile|tsc|webpack|vite build)\b/.test(text)) return 'Building it.'
  if (/install|pnpm add|npm i\b|pip install/.test(text)) return 'Installing dependencies.'
  if (/browser|navigate|screenshot/.test(text)) return 'Checking in the browser.'
  if (/edit|write|patch|apply|create_file|replace/.test(name.toLowerCase())) return 'Making the change.'
  if (/search|grep|glob|read|list|find|codebase/.test(name.toLowerCase())) return 'Looking through the code.'
  if (/terminal|shell|command|bash|run/.test(name.toLowerCase())) return 'Running a command.'
  return null
}

export class ReplySpeaker {
  private parser = new SpokenStreamParser()
  private stepText = ''
  private reply: Reply | null = null
  private quiet = false
  private active = false
  private lastCueAt = Number.NEGATIVE_INFINITY
  private cueTimers = new Map<string, unknown>()

  constructor(private readonly deps: ReplySpeakerDeps) {}

  /** The followed run is still working. */
  get runActive(): boolean {
    return this.active
  }

  /** A new turn was sent: speak again, from a clean step. */
  beginTurn(): void {
    this.quiet = false
    this.active = true
    this.resetStep()
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
          this.active = true
          return
        }
        this.active = false
        this.clearCues()
        if (ev.status === 'error') this.speakOnce(RUN_FAILED_LINE)
        this.finishReply()
        this.deps.onRunEnd()
        return
      case 'text_delta': {
        this.stepText += ev.text
        const spoken = this.parser.push(ev.text)
        if (spoken) this.speak(spoken)
        return
      }
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
        if (tail) this.speak(tail)
        const final = !ev.toolCalls || ev.toolCalls.length === 0
        if (final) {
          if (this.parser.phase === 'absent') {
            const summary = fallbackSummary(ev.content || this.stepText)
            if (summary) this.speak(`${summary} `)
          }
          this.finishReply()
        }
        this.resetStep()
        return
      }
      default:
        return
    }
  }

  dispose(): void {
    this.clearCues()
    this.reply?.stream.cancel()
    this.reply = null
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
    if (!piece) return
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

  private resetStep(): void {
    this.parser = new SpokenStreamParser()
    this.stepText = ''
  }
}
