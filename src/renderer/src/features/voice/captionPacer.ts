/**
 * Captions in step with the voice. Main sends each sentence (`say`) the
 * moment it's ready to synthesise, which is 0.5–2 s before its audio plays
 * (measured 2026-10-14: first caption at 1.6–3.6 s, first sound 0.9–2.1 s
 * later). Shown on arrival, the transcript ran ahead of the voice and the
 * reply read as "text first, then speech". Each caption now waits for its
 * own audio to start.
 *
 * Main tags the first chunk of each sentence's audio with its index
 * (`piece`) where the speaking provider can tell (OpenAI, OpenRouter: one
 * request per sentence). Where it can't (streaming sockets), every waiting
 * caption is shown as the next audio starts. Nothing is ever lost: captions
 * whose audio fails or never comes are shown anyway.
 */

/** A caption whose audio hasn't started this long after it, with nothing of its reply playing, is shown anyway. */
export const CAPTION_STALL_MS = 4000

export type CaptionPacerDeps = {
  /** Show this caption now. */
  reveal: (contextId: string, text: string) => void
  /** Audio of this reply is scheduled and not yet played out. */
  sounding: (contextId: string) => boolean
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

type Reply = {
  /** `say`s received: the next one's index. */
  said: number
  pending: { index: number; text: string }[]
  /** Audio arrived for this reply; `marked` once a chunk named its piece. */
  heard: boolean
  marked: boolean
  stall: unknown
  timers: Set<unknown>
}

export class CaptionPacer {
  private replies = new Map<string, Reply>()
  private readonly setTimer: (fn: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void

  constructor(private readonly deps: CaptionPacerDeps) {
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    this.clearTimer = deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  }

  /**
   * A sentence to caption. `audible` false (nothing can speak it) or absent
   * (a main that doesn't say) shows it now.
   */
  say(contextId: string, text: string, audible: boolean | undefined): void {
    const reply = this.reply(contextId)
    const index = reply.said++
    if (audible !== true) {
      this.deps.reveal(contextId, text)
      return
    }
    reply.pending.push({ index, text })
    this.armStall(contextId, reply)
  }

  /**
   * A chunk of this reply's audio was scheduled to play in `delayMs`. `piece`:
   * it is the first audio of that sentence.
   */
  audio(contextId: string, piece: number | undefined, delayMs: number): void {
    const reply = this.replies.get(contextId)
    if (!reply) return
    reply.heard = true
    if (piece !== undefined) reply.marked = true
    // Marked: only a chunk that starts a sentence moves the captions on.
    if ((reply.marked && piece === undefined) || reply.pending.length === 0) return
    this.revealAt(contextId, reply, piece ?? Number.POSITIVE_INFINITY, delayMs)
  }

  /** All of this reply's audio has arrived. One that never sounded shows its captions now. */
  ended(contextId: string): void {
    const reply = this.replies.get(contextId)
    if (reply && !reply.heard) this.flush(contextId)
  }

  /** This reply has played out: anything still waiting is shown, and it's forgotten. */
  drained(contextId: string): void {
    this.flush(contextId)
  }

  /** Barge-in: the rest of this reply won't be heard, so it isn't shown. */
  drop(contextId: string): void {
    const reply = this.replies.get(contextId)
    if (!reply) return
    this.cancelTimers(reply)
    this.replies.delete(contextId)
  }

  /** Speaking failed: no audio is coming for anything waiting. */
  speakFailed(): void {
    for (const id of [...this.replies.keys()]) this.flush(id)
  }

  clear(): void {
    for (const reply of this.replies.values()) this.cancelTimers(reply)
    this.replies.clear()
  }

  private reply(contextId: string): Reply {
    let reply = this.replies.get(contextId)
    if (!reply) {
      reply = { said: 0, pending: [], heard: false, marked: false, stall: null, timers: new Set() }
      this.replies.set(contextId, reply)
    }
    return reply
  }

  private revealAt(contextId: string, reply: Reply, upTo: number, delayMs: number): void {
    const show = (): void => {
      while (reply.pending.length > 0 && reply.pending[0]!.index <= upTo) {
        this.deps.reveal(contextId, reply.pending.shift()!.text)
      }
      if (reply.pending.length > 0) this.armStall(contextId, reply)
    }
    if (delayMs <= 15) {
      show()
      return
    }
    const timer = this.setTimer(() => {
      reply.timers.delete(timer)
      if (this.replies.get(contextId) === reply) show()
    }, delayMs)
    reply.timers.add(timer)
  }

  /** Waiting captions show once their reply has gone quiet without their audio. */
  private armStall(contextId: string, reply: Reply): void {
    if (reply.stall) this.clearTimer(reply.stall)
    reply.stall = this.setTimer(() => {
      reply.stall = null
      if (this.replies.get(contextId) !== reply || reply.pending.length === 0) return
      // Still speaking an earlier sentence: this one's audio may be right behind it.
      if (this.deps.sounding(contextId) || reply.timers.size > 0) this.armStall(contextId, reply)
      else this.revealAll(contextId, reply)
    }, CAPTION_STALL_MS)
  }

  private revealAll(contextId: string, reply: Reply): void {
    for (const p of reply.pending.splice(0)) this.deps.reveal(contextId, p.text)
  }

  private flush(contextId: string): void {
    const reply = this.replies.get(contextId)
    if (!reply) return
    this.cancelTimers(reply)
    this.revealAll(contextId, reply)
    this.replies.delete(contextId)
  }

  private cancelTimers(reply: Reply): void {
    if (reply.stall) this.clearTimer(reply.stall)
    reply.stall = null
    for (const t of reply.timers) this.clearTimer(t)
    reply.timers.clear()
  }
}
