/**
 * Time limits for one MCP tool call that stop while the person is answering
 * the server's question: an idle limit that progress from the server resets,
 * and a cap on the call's working time. Time spent waiting on a form counts
 * toward neither — a person reading it for three minutes is not a hung server.
 */
export class PausableCallTimer {
  private handle: ReturnType<typeof setTimeout> | null = null
  private lastActivity = 0
  private workedMs = 0
  private runningSince: number | null = null
  private paused = 0
  private done = false

  constructor(
    private readonly opts: {
      idleMs: number
      totalMs: number
      onTimeout: (limit: 'idle' | 'total') => void
      now?: () => number
    }
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now()
  }

  private schedule(): void {
    if (this.handle) clearTimeout(this.handle)
    this.handle = null
    if (this.done || this.paused > 0 || this.runningSince === null) return
    const now = this.now()
    const idleLeft = this.opts.idleMs - (now - this.lastActivity)
    const totalLeft = this.opts.totalMs - (this.workedMs + (now - this.runningSince))
    if (idleLeft <= 0 || totalLeft <= 0) {
      this.fire(totalLeft <= 0 ? 'total' : 'idle')
      return
    }
    this.handle = setTimeout(() => this.schedule(), Math.min(idleLeft, totalLeft))
  }

  private fire(limit: 'idle' | 'total'): void {
    this.stop()
    this.opts.onTimeout(limit)
  }

  start(): void {
    const now = this.now()
    this.lastActivity = now
    this.runningSince = now
    this.schedule()
  }

  /** The server reported progress: it is alive. */
  progress(): void {
    if (this.done) return
    this.lastActivity = this.now()
    this.schedule()
  }

  /** A question is waiting on the person. Nested: each pause needs its resume. */
  pause(): void {
    if (this.done) return
    if (this.paused === 0 && this.runningSince !== null) {
      this.workedMs += this.now() - this.runningSince
      this.runningSince = null
    }
    this.paused += 1
    this.schedule()
  }

  resume(): void {
    if (this.done || this.paused === 0) return
    this.paused -= 1
    if (this.paused === 0) {
      const now = this.now()
      this.runningSince = now
      // The idle clock starts over: the server gets its full window to use the answer.
      this.lastActivity = now
    }
    this.schedule()
  }

  stop(): void {
    this.done = true
    if (this.handle) clearTimeout(this.handle)
    this.handle = null
  }
}
