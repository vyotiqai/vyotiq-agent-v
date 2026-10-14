/**
 * The voice conversation, kept (docs/voice-mode.md §24.8): what you said, what
 * the voice said, what the agent said aloud, and what became of each request
 * — handed to a task (and which run), not sent (and why), answered by voice,
 * or not a turn at all. Until 2026-10-14 it lived only in memory, so a
 * session could not be looked back on once it ended.
 *
 * One JSON line per entry, in `<workspace data>/voice/<started>_<session>.jsonl`,
 * beside the workspace's task runs: removed with the workspace and by Delete
 * all data. Words are redacted for secrets before they reach the disk.
 * Writes are batched and asynchronous: nothing here waits on the disk.
 */
import { mkdir, appendFile, readdir, rm } from 'fs/promises'
import { join } from 'path'
import { logger } from '../../shared/logger'
import { redactSecretsInText } from '../../shared/utils/redactSecrets'

export type VoiceLogEntry =
  | { kind: 'start'; listener: string; speaker: string | null }
  /** A turn of yours. `stop`: a stop phrase, which stops the work without the voice model. */
  | { kind: 'you'; turnId: string; text: string; stop?: boolean }
  /** Said aloud, one sentence at a time; lines of one `contextId` are one reply. */
  | { kind: 'voice' | 'agent'; contextId: string; text: string }
  | { kind: 'hand_off'; handOffId: string; brief: string }
  /** The task took the hand-off: this run does the work. */
  | { kind: 'followed'; runId: string; handOffId?: string }
  | { kind: 'not_sent'; handOffId: string; reason: string }
  /** You answered the agent's approval or question by voice: it never became a message. */
  | { kind: 'answered'; what: 'approval' | 'question'; text: string; decision?: string; tool?: string }
  | { kind: 'stop_agent'; by: 'you' | 'voice' }
  /** Heard, but not a turn: no words, the agent's own echo, or noise. No words kept. */
  | { kind: 'dropped'; reason: 'empty' | 'echo' | 'noise'; chars: number }
  /** `detail`: the provider's reason, one line, redacted; the code alone said "out_of_credit" and not why. */
  | { kind: 'error'; side: string; code: string; detail?: string }
  | { kind: 'end' }

/** Kept per workspace; the oldest sessions go first. */
export const MAX_VOICE_LOGS = 200
const FLUSH_MS = 250

export type VoiceConversationLogDeps = {
  dir: string
  sessionId: string
  now?: () => Date
}

export class VoiceConversationLog {
  readonly file: string
  private lines: string[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  /** Every write after the first waits for the one before: lines land in order. */
  private chain: Promise<void>
  private failed = false
  private closed = false
  private readonly now: () => Date

  constructor(private readonly deps: VoiceConversationLogDeps) {
    this.now = deps.now ?? (() => new Date())
    const started = this.now().toISOString().replace(/[:.]/g, '-')
    this.file = join(deps.dir, `${started}_${deps.sessionId}.jsonl`)
    this.chain = mkdir(deps.dir, { recursive: true }).then(
      () => pruneVoiceLogs(deps.dir, MAX_VOICE_LOGS - 1),
      (err) => this.fail(err)
    )
  }

  add(entry: VoiceLogEntry): void {
    if (this.closed) return
    this.lines.push(JSON.stringify({ at: this.now().toISOString(), ...redactEntry(entry) }))
    if (!this.timer) {
      this.timer = setTimeout(() => void this.flush(), FLUSH_MS)
      this.timer.unref?.()
    }
  }

  /** Write what's buffered; resolves once it's on disk (or failed). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.lines.length === 0) return this.chain
    const text = `${this.lines.join('\n')}\n`
    this.lines = []
    this.chain = this.chain.then(() => (this.failed ? undefined : appendFile(this.file, text, 'utf8').catch((err) => this.fail(err))))
    return this.chain
  }

  /** The session ended: an `end` line, then everything to disk. */
  close(): Promise<void> {
    if (this.closed) return this.chain
    this.add({ kind: 'end' })
    this.closed = true
    return this.flush()
  }

  private fail(err: unknown): void {
    if (this.failed) return
    this.failed = true
    logger.warn('Voice conversation could not be saved', {
      scope: 'voice',
      reason: err instanceof Error ? err.message : String(err)
    })
  }
}

function redactEntry(entry: VoiceLogEntry): VoiceLogEntry {
  if ('text' in entry) return { ...entry, text: redactSecretsInText(entry.text) }
  if (entry.kind === 'hand_off') return { ...entry, brief: redactSecretsInText(entry.brief) }
  if (entry.kind === 'error' && entry.detail) return { ...entry, detail: redactSecretsInText(entry.detail) }
  return entry
}

/** Keep the newest `keep` logs in the folder. Names start with the start time, so they sort by age. */
export async function pruneVoiceLogs(dir: string, keep: number): Promise<void> {
  try {
    const logs = (await readdir(dir)).filter((n) => n.endsWith('.jsonl')).sort()
    await Promise.all(logs.slice(0, Math.max(0, logs.length - keep)).map((n) => rm(join(dir, n), { force: true })))
  } catch {
    /* nothing to prune */
  }
}
