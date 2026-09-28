import {
  MAX_TAKE_MS,
  TAKE_WARN_MS,
  parseDictationIpcCode,
  type DictationEngine,
  type DictationErrorCode,
  type DictationLiveEvent,
  type DictationLiveOpenRequest,
  type DictationTakeStats,
  type DictationTranscribeRequest,
  type DictationTranscribeResult,
  type IpcResult
} from '@shared/ipc'
import {
  MicCaptureError,
  PCM_SAMPLE_RATE,
  int16ToBase64,
  type MicCapture,
  type MicCaptureFailure,
  type OpenMicCapture
} from '@renderer/lib/audio/micCapture'
import { FRAME_SAMPLES, Segmenter, levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'

/*
  A take: one stretch of dictation, from the mic opening to the words landing.

  The controller owns everything that is not React: the microphone, the PCM
  the take has captured, its segments, and the requests for their words. It
  publishes a snapshot on every change; `useTake` renders it and decides what
  the words do once the take finishes.

  Segments are cut at pauses (see Segmenter) and each is transcribed as soon
  as it closes, so by the time you stop only the last one is left. The PCM is
  kept until the take is over, so a failed segment can be retried — on
  another engine, if need be — without speaking again.

  With Whisper on this PC there are two lanes, one request in each: finals
  from the chosen model, and drafts for live words — from Whisper Tiny when
  it is installed, in a worker of its own. Whisper pads every call to 30 s of
  audio, so Small takes seconds a call on a busy laptop whatever the length;
  in one lane, live words stalled behind every final. The draft lane drafts
  the open segment as you speak and each segment again as it closes, so a
  whole phrase is on screen moments after you pause while its final is still
  on its way. After you stop, finals get `FINISH_BUDGET_MS`; anything still
  waiting then lands as its draft rather than keep you waiting.

  A draft of speech that is still coming in ends mid-word, and Whisper
  finishes the sentence itself ("Please refactor the video."), so it shows
  without its last word — or as far as two drafts agree, if that is further —
  unless it heard all the speech so far, when it shows whole.

  With OpenAI's live words on (Settings → Voice), the take streams its audio
  to one live session instead: each phrase cut is a commit, words arrive as
  they are spoken, and the session's transcript is the phrase's final words.
  If the session fails, or a phrase has no transcript when the finish budget
  runs out, that phrase goes the usual way — one request for it.
*/

export const METER_BARS = 28
/** One meter bar per this many ms of audio. */
const BAR_MS = 110
/** No speech at all for this long after the mic opens: say so, and name the device. */
export const SILENT_AFTER_MS = 4000
/** A discarded take can be restored for this long. */
export const RESTORE_WINDOW_MS = 8000
/** A live draft runs once this much new audio has come in since the last one. */
const DRAFT_EVERY_MS = 600
/** Below this much speech a segment is breath or a click: never sent. */
const MIN_SPEECH_MS = 200
/** A draft that reaches this far past the last speech has heard all of it. */
const COVER_MARGIN_MS = 250
/** Drafts that fail this many times in a row stop for the rest of the take. */
const MAX_DRAFT_FAILURES = 3
/** How much of what came before a cloud segment goes with it as context. */
const PROMPT_CHARS = 200
/** After you stop, finals get this long before drafts stand in for them. */
export const FINISH_BUDGET_MS = 3000
/** What a final is assumed to cost until one has been timed. */
const DEFAULT_FINAL_CALL_MS = 2500
/**
 * Finals this quick (Moonshine) land about when a whole-phrase draft would:
 * drafting the phrase again as it closes would only compete with its final.
 */
const QUICK_FINAL_MS = 1000

/** How long a final takes on each engine, learned across takes in this window. */
const finalCallMs = new Map<DictationEngine, number>()

export function resetTakeTimingsForTests(): void {
  finalCallMs.clear()
}

export type TakeFailureCode = DictationErrorCode | 'nothing_heard'

export type TakeFailure = { code: TakeFailureCode; message: string }

export type TakePhase =
  | 'idle'
  /** The mic is opening. */
  | 'starting'
  | 'listening'
  /** Stopped listening; the last segments are being transcribed. */
  | 'finishing'
  | 'failed'
  /** Discarded, but restorable for `RESTORE_WINDOW_MS`. */
  | 'discarded'

export type TakeSnapshot = {
  phase: TakePhase
  engine: DictationEngine
  /** Audio captured so far. */
  elapsedMs: number
  /** Time left before the take stops itself; only inside the last `TAKE_WARN_MS`. */
  leftMs: number | null
  /** Push-to-talk: the shortcut is being held. */
  hold: boolean
  /** Listening, but nothing heard at all since the mic opened, for `SILENT_AFTER_MS`. */
  silent: boolean
  deviceLabel: string
  /** Rolling loudness, 0..1, newest last. */
  levels: number[]
  /** Transcribed and final. */
  settled: string
  /** Provisional words: live drafts, and finals waiting behind an earlier segment. */
  partial: string
  /** Speech captured that has no words on screen yet — shown as a marker at the caret. */
  pending: boolean
  /** Share of segments transcribed while finishing; null when it would not mean anything. */
  progress: number | null
  failure: TakeFailure | null
  /** Words a failed take already has, which Insert can keep. */
  keptWords: number
  /** What `restore` returns to. */
  discardedFrom: 'listening' | 'finishing' | 'failed' | null
}

type SegmentStatus = 'open' | 'queued' | 'working' | 'done' | 'failed' | 'skipped'

type Segment = {
  id: number
  from: number
  to: number | null
  voicedMs: number
  /** The last sample of speech in a closed segment. */
  voicedEnd: number
  status: SegmentStatus
  text: string
  /** Draft words on screen for a segment without its final words. */
  partial: string
  /** The latest draft as it came back, for the next one to agree with. */
  draftRaw: string
  /** Samples the latest draft covered. */
  draftTo: number
  /** The latest draft came from the model finals use, so it can stand as final. */
  draftFinalQuality: boolean
  /** Closed without a draft that heard all of it: the draft lane owes it one. */
  needsDraft: boolean
  /** Where its words came from once done: a final, a final-quality draft, or a stand-in draft. */
  settledBy: 'final' | 'reuse' | 'standin' | null
  /** Committed to the live session, which owes it words; when it was. */
  liveAt: number | null
}

type Slot = { id: string; segmentId: number; startedAt: number }

export type TakeDeps = {
  openCapture: OpenMicCapture
  transcribe: (req: DictationTranscribeRequest) => Promise<IpcResult<DictationTranscribeResult>>
  cancel: (requestId: string) => void
  /** Warm the engine up while the mic opens (loads Whisper on this PC). */
  prepare?: (engine: DictationEngine) => void
  onChange: (snap: TakeSnapshot) => void
  /** The take finished listening and every segment has words. */
  onDone: (text: string, reason: TakeFinish) => void
  /** The microphone could not open. */
  onMicFailure?: (kind: MicCaptureFailure, message: string) => void
  /** How the take went, once it is over — timings and counts for the log. */
  onStats?: (stats: DictationTakeStats) => void
  /** OpenAI live words; absent where there is no live session to open. */
  live?: LiveTranscriber
  now?: () => number
  newId?: () => string
}

/** A live transcription session, as the take sees it (main owns the socket). */
export type LiveTranscriber = {
  open: (req: DictationLiveOpenRequest) => Promise<IpcResult<boolean>>
  audio: (takeId: string, pcm16k: string) => void
  commit: (takeId: string) => void
  close: (takeId: string) => void
  subscribe: (handler: (event: DictationLiveEvent) => void) => () => void
}

/** Why the take finished: whoever asked decides what the words do. */
export type TakeFinish = 'insert' | 'send'

export type TakeStartOptions = {
  engine: DictationEngine
  deviceId?: string
  language?: string
  /** The composer's workspace: cloud finals listen for its file names. */
  workspacePath?: string
  /** OpenAI: write words while they are spoken, through a live session. */
  live?: boolean
  /** On this PC: draft live words (off when only Moonshine could, which makes words up mid-phrase). */
  drafts?: boolean
}

const IDLE: TakeSnapshot = {
  phase: 'idle',
  engine: 'openai',
  elapsedMs: 0,
  leftMs: null,
  hold: false,
  silent: false,
  deviceLabel: '',
  levels: Array.from({ length: METER_BARS }, () => 0),
  settled: '',
  partial: '',
  pending: false,
  progress: null,
  failure: null,
  keptWords: 0,
  discardedFrom: null
}

export function idleSnapshot(): TakeSnapshot {
  return { ...IDLE, levels: [...IDLE.levels] }
}

export function joinWords(parts: readonly string[]): string {
  return parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join(' ')
}

function splitWords(text: string): string[] {
  return text.split(/\s+/).filter(Boolean)
}

/** A word as two drafts compare it: case and punctuation are the model's mood, not a disagreement. */
function wordKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '')
}

/** The words `next` starts with that `prev` started with too, spelled as `next` has them. */
export function agreedPrefix(prev: string, next: string): string {
  const a = splitWords(prev)
  const b = splitWords(next)
  let n = 0
  while (n < a.length && n < b.length && wordKey(a[n]!) === wordKey(b[n]!)) n++
  return b.slice(0, n).join(' ')
}

/**
 * What Whisper says over a breath, a click or room noise. Nobody dictates
 * "you" alone; the rest are only dropped when there was barely any speech.
 */
const PHANTOM_ALWAYS = new Set(['you'])
const PHANTOM_SHORT = new Set([
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'thank you very much',
  'please subscribe',
  'bye'
])
const PHANTOM_ALWAYS_MAX_MS = 1500
const PHANTOM_SHORT_MAX_MS = 500

export function dropPhantom(text: string, voicedMs: number): string {
  const t = text.trim()
  const key = splitWords(t).map(wordKey).filter(Boolean).join(' ')
  if (!key) return ''
  if (PHANTOM_ALWAYS.has(key) && voicedMs < PHANTOM_ALWAYS_MAX_MS) return ''
  if (PHANTOM_SHORT.has(key) && voicedMs < PHANTOM_SHORT_MAX_MS) return ''
  return collapseLoops(t)
}

/** A word this many times running is a decoder loop, not dictation ("very very very" is three). */
const LOOP_WORD_RUN = 4
/** A two-word phrase this many times running, likewise. */
const LOOP_PAIR_RUN = 3

/**
 * Whisper, Tiny especially, can loop on audio cut mid-word — "small small
 * small small", "the chain the chain the chain". Main blocks most of it
 * while decoding; what gets through keeps one copy.
 */
export function collapseLoops(text: string): string {
  const words = splitWords(text)
  if (words.length < LOOP_PAIR_RUN * 2) return text
  const keys = words.map(wordKey)
  const out: string[] = []
  let i = 0
  while (i < words.length) {
    let run = 1
    while (i + run < words.length && keys[i + run] === keys[i] && keys[i]) run++
    if (run >= LOOP_WORD_RUN) {
      out.push(words[i + run - 1]!)
      i += run
      continue
    }
    let pairs = 1
    while (
      i + 2 * pairs + 1 < words.length &&
      keys[i] &&
      keys[i + 2 * pairs] === keys[i] &&
      keys[i + 2 * pairs + 1] === keys[i + 1]
    ) {
      pairs++
    }
    if (pairs >= LOOP_PAIR_RUN && keys[i] !== keys[i + 1]) {
      out.push(words[i + 2 * pairs - 2]!, words[i + 2 * pairs - 1]!)
      i += 2 * pairs
      continue
    }
    out.push(words[i]!)
    i++
  }
  return out.length === words.length ? text : out.join(' ')
}

/** The last `max` characters of `text`, starting on a word. */
function tailWords(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(text.length - max)
  const space = cut.indexOf(' ')
  return space >= 0 ? cut.slice(space + 1) : cut
}

const COVER_MARGIN = (PCM_SAMPLE_RATE * COVER_MARGIN_MS) / 1000

/** What a take counts as it runs, for `onStats`. */
function newStats() {
  return {
    listenAt: null as number | null,
    firstWordsAt: null as number | null,
    stopAt: null as number | null,
    speechMs: 0,
    finals: 0,
    finalMs: 0,
    drafts: 0,
    draftFailures: 0,
    failed: false,
    sent: false
  }
}

export class TakeController {
  private readonly deps: TakeDeps
  private readonly now: () => number
  private readonly newId: () => string
  private snap: TakeSnapshot = idleSnapshot()

  private pcm = new Int16Array(PCM_SAMPLE_RATE * 60)
  private samples = 0
  private frameRemainder = 0
  private segmenter = new Segmenter(0)
  private segments: Segment[] = []
  private nextSegmentId = 1
  private capture: MicCapture | null = null
  private opts: TakeStartOptions = { engine: 'openai' }
  private engineOverride: DictationEngine | null = null
  /** Bumped when the take ends for good: late answers from the old take are dropped. */
  private generation = 0
  /** The final lane's request in flight. */
  private working: Slot | null = null
  /** The draft lane's request in flight. */
  private drafting: Slot | null = null
  /** Drafts come from a faster model than finals; null until one answers. */
  private draftsProvisional: boolean | null = null
  private finishTimer: ReturnType<typeof setTimeout> | null = null
  private lastVoicedSample = 0
  /** Speech heard on the current device: "nothing heard" is only said before any. */
  private heardMs = 0
  /** Where the current device started, for "nothing heard" after a switch. */
  private deviceFrom = 0
  private barPeak = 0
  private barSamples = 0
  private finishReason: TakeFinish = 'insert'
  private restoreTimer: ReturnType<typeof setTimeout> | null = null
  private starting = false
  /** A final failed: hold the queue until the take finishes and offers Retry. */
  private blocked = false
  private draftFailures = 0
  private stats = newStats()
  /** The live session this take streams to; null when off, or once it failed. */
  private liveId: string | null = null
  private liveUnsubscribe: (() => void) | null = null
  /** Segment ids in the order they were committed: a live event's `ordinal` indexes this. */
  private liveOrder: number[] = []

  constructor(deps: TakeDeps) {
    this.deps = deps
    this.now = deps.now ?? (() => Date.now())
    this.newId = deps.newId ?? (() => crypto.randomUUID())
  }

  get snapshot(): TakeSnapshot {
    return this.snap
  }

  get engine(): DictationEngine {
    return this.engineOverride ?? this.opts.engine
  }

  /** Open the mic and start listening. Resolves once listening, or false when the mic refused. */
  async start(opts: TakeStartOptions): Promise<boolean> {
    if (this.starting || this.capture) return false
    this.clearRestoreTimer()
    this.resetTake()
    this.opts = opts
    this.starting = true
    this.set({ ...idleSnapshot(), phase: 'starting', engine: opts.engine })
    this.deps.prepare?.(opts.engine)
    this.openLive()
    const gen = this.generation
    const ok = await this.openMic(opts.deviceId)
    this.starting = false
    if (gen !== this.generation) return false
    if (!ok) {
      this.closeLive()
      this.set(idleSnapshot())
      return false
    }
    this.stats.listenAt = this.now()
    this.set({ phase: 'listening' })
    return true
  }

  /** Stop listening and finish: the words go to `onDone` once every segment has them. */
  finish(reason: TakeFinish = 'insert'): void {
    const phase = this.snap.phase
    if (phase === 'starting') {
      // Nothing captured yet: finishing is the same as never starting.
      this.discardForGood()
      return
    }
    if (phase !== 'listening') return
    this.finishReason = reason
    this.stats.stopAt = this.now()
    this.stopMic()
    this.closeOpenSegment()
    this.set({ phase: 'finishing', hold: false, silent: false, progress: this.progress(), ...this.words() })
    this.armFinishBudget()
    this.pump()
  }

  /** Once the budget is spent, whatever has a full draft lands as it. */
  private armFinishBudget(): void {
    this.clearFinishTimer()
    const gen = this.generation
    this.finishTimer = setTimeout(() => {
      this.finishTimer = null
      if (gen !== this.generation || this.snap.phase !== 'finishing') return
      this.takeBackFromLive()
      this.useDrafts()
      this.set({ ...this.words(), progress: this.progress() })
      this.pump()
    }, FINISH_BUDGET_MS)
  }

  setHold(hold: boolean): void {
    if (this.snap.phase === 'listening' || this.snap.phase === 'starting') this.set({ hold })
  }

  /** Esc: stop, keep everything for `RESTORE_WINDOW_MS`. */
  discard(): void {
    const phase = this.snap.phase
    if (phase === 'starting') {
      this.discardForGood()
      return
    }
    if (phase !== 'listening' && phase !== 'finishing' && phase !== 'failed') return
    this.stopMic()
    this.set({ phase: 'discarded', discardedFrom: phase, hold: false, silent: false })
    this.clearRestoreTimer()
    this.restoreTimer = setTimeout(() => this.discardForGood(), RESTORE_WINDOW_MS)
  }

  /** Put a discarded take back where it was — listening again, or finishing. */
  async restore(): Promise<void> {
    if (this.snap.phase !== 'discarded') return
    this.clearRestoreTimer()
    const from = this.snap.discardedFrom
    if (from === 'listening') {
      this.set({ phase: 'starting', discardedFrom: null })
      const gen = this.generation
      const ok = await this.openMic(this.opts.deviceId)
      if (gen !== this.generation) return
      if (!ok) {
        // The mic would not reopen: keep what there is and finish it.
        this.closeOpenSegment()
        this.set({ phase: 'finishing' })
        this.pump()
        return
      }
      this.set({ phase: 'listening' })
      this.pump()
      return
    }
    this.set({ phase: from === 'failed' ? 'failed' : 'finishing', discardedFrom: null })
    if (from !== 'failed') {
      this.armFinishBudget()
      this.pump()
    }
  }

  /** Send the failed segments again, on `engine` when given. */
  retry(engine?: DictationEngine): void {
    if (this.snap.phase !== 'failed') return
    if (engine) this.engineOverride = engine
    this.blocked = false
    for (const s of this.segments) if (s.status === 'failed') s.status = 'queued'
    this.set({ phase: 'finishing', failure: null, keptWords: 0, engine: this.engine })
    this.pump()
  }

  /** A failed take: land the words it does have and let the rest go. */
  keep(): void {
    if (this.snap.phase !== 'failed') return
    const text = this.doneText()
    if (!text) return
    const reason = this.finishReason === 'send' ? 'insert' : this.finishReason
    this.report('kept')
    this.resetTake()
    this.set(idleSnapshot())
    this.deps.onDone(text, reason)
  }

  /** Move the take to another microphone without losing what it has. */
  async switchDevice(deviceId: string): Promise<void> {
    this.opts = { ...this.opts, deviceId }
    if (!this.capture) return
    this.stopMic()
    const gen = this.generation
    const ok = await this.openMic(deviceId)
    if (gen !== this.generation) return
    if (!ok) this.finish('insert')
  }

  /** Throw the take away now, with no restore (a new take, the composer going away). */
  dispose(): void {
    this.discardForGood()
  }

  // ─── internals ────────────────────────────────────────────────────────

  private discardForGood(): void {
    this.clearRestoreTimer()
    this.stopMic()
    // A request to Whisper on this PC runs to the end: cancelling it tears
    // the worker down, and the next take would wait for the model to reload.
    if (this.working && this.engine !== 'local') this.deps.cancel(this.working.id)
    this.report(this.stats.failed ? 'failed' : 'discarded')
    this.resetTake()
    this.set(idleSnapshot())
  }

  private resetTake(): void {
    this.closeLive()
    this.generation += 1
    this.working = null
    this.drafting = null
    this.clearFinishTimer()
    this.samples = 0
    this.frameRemainder = 0
    this.segmenter = new Segmenter(0)
    this.segments = []
    this.engineOverride = null
    this.lastVoicedSample = 0
    this.heardMs = 0
    this.deviceFrom = 0
    this.barPeak = 0
    this.barSamples = 0
    this.finishReason = 'insert'
    this.starting = false
    this.blocked = false
    this.draftFailures = 0
    this.stats = newStats()
  }

  /** Once per take, when it is over for good. */
  private report(outcome: DictationTakeStats['outcome']): void {
    const st = this.stats
    if (st.sent || this.samples === 0 || st.listenAt == null) return
    st.sent = true
    const voiced = this.segments.filter((s) => s.status !== 'skipped')
    const by = (kind: Segment['settledBy']): number =>
      voiced.filter((s) => s.status === 'done' && s.settledBy === kind).length
    const ms = (n: number): number => Math.max(0, Math.round(n))
    this.deps.onStats?.({
      outcome,
      engine: this.engine,
      audioMs: ms((this.samples / PCM_SAMPLE_RATE) * 1000),
      speechMs: ms(st.speechMs),
      firstWordsMs: st.firstWordsAt != null ? ms(st.firstWordsAt - st.listenAt) : null,
      finishWaitMs: st.stopAt != null ? ms(this.now() - st.stopAt) : null,
      segments: voiced.length,
      finals: st.finals,
      finalAvgMs: st.finals > 0 ? ms(st.finalMs / st.finals) : null,
      drafts: st.drafts,
      draftFailures: st.draftFailures,
      standIns: by('standin'),
      reusedDrafts: by('reuse')
    })
  }

  // ─── live words ───────────────────────────────────────────────────────

  private openLive(): void {
    const live = this.deps.live
    if (!live || !this.opts.live || this.opts.engine !== 'openai') return
    const takeId = this.newId()
    this.liveId = takeId
    this.liveOrder = []
    const gen = this.generation
    this.liveUnsubscribe = live.subscribe((event) => {
      if (gen !== this.generation || event.takeId !== this.liveId) return
      this.onLive(event)
    })
    const req: DictationLiveOpenRequest = { takeId }
    if (this.opts.language) req.language = this.opts.language
    if (this.opts.workspacePath) req.workspacePath = this.opts.workspacePath
    void live.open(req).then(
      (res) => {
        if (!res.ok && gen === this.generation && this.liveId === takeId) this.liveFailed()
      },
      () => {
        if (gen === this.generation && this.liveId === takeId) this.liveFailed()
      }
    )
  }

  private closeLive(): void {
    const id = this.liveId
    this.liveId = null
    this.liveUnsubscribe?.()
    this.liveUnsubscribe = null
    this.liveOrder = []
    if (id) this.deps.live?.close(id)
  }

  /** The live session owes this segment its words. */
  private liveOwns(s: Segment): boolean {
    return this.liveId != null && s.liveAt != null
  }

  /** The session is gone: every phrase it still owed goes the usual way. */
  private liveFailed(): void {
    this.closeLive()
    for (const s of this.segments) s.liveAt = null
    this.set({ ...this.words(), progress: this.progress() })
    this.pump()
  }

  /** Past the budget: phrases the session has not finished get a request of their own too. */
  private takeBackFromLive(): void {
    for (const s of this.segments) if (s.status === 'queued' && s.liveAt != null) s.liveAt = null
  }

  private onLive(event: DictationLiveEvent): void {
    if (event.kind === 'open') return
    if (event.kind === 'error') {
      this.liveFailed()
      return
    }
    const seg = this.liveSegment(event.ordinal)
    if (!seg) return
    if (event.kind === 'item_failed') {
      seg.liveAt = null
    } else if (event.final) {
      if (seg.status !== 'done' || seg.settledBy !== 'final') {
        if (seg.liveAt != null) {
          this.stats.finals += 1
          this.stats.finalMs += this.now() - seg.liveAt
        }
        if (seg.status === 'open') seg.partial = event.text
        else this.settle(seg, event.text, 'final')
      }
    } else if (seg.status !== 'done' && seg.status !== 'skipped') {
      seg.partial = collapseLoops(event.text)
    }
    this.set({ ...this.words(), progress: this.progress() })
    this.pump()
  }

  /** Committed phrases by order; one past them is the phrase being spoken. */
  private liveSegment(ordinal: number): Segment | null {
    const id = this.liveOrder[ordinal]
    if (id != null) return this.segments.find((s) => s.id === id) ?? null
    if (ordinal !== this.liveOrder.length) return null
    const open = this.segments[this.segments.length - 1]
    return open && open.status === 'open' ? open : null
  }

  private clearFinishTimer(): void {
    if (this.finishTimer != null) {
      clearTimeout(this.finishTimer)
      this.finishTimer = null
    }
  }

  private clearRestoreTimer(): void {
    if (this.restoreTimer != null) {
      clearTimeout(this.restoreTimer)
      this.restoreTimer = null
    }
  }

  private async openMic(deviceId: string | undefined): Promise<boolean> {
    try {
      const gen = this.generation
      const capture = await this.deps.openCapture({
        deviceId: deviceId || undefined,
        onSamples: (pcm) => {
          if (gen === this.generation) this.onSamples(pcm)
        },
        onEnded: () => {
          if (gen !== this.generation) return
          // The device went away: keep what was said and finish it.
          this.finish(this.finishReason)
        }
      })
      if (gen !== this.generation) {
        capture.stop()
        return false
      }
      this.capture = capture
      this.heardMs = 0
      this.deviceFrom = this.samples
      this.set({ deviceLabel: capture.deviceLabel, silent: false })
      return true
    } catch (err) {
      const e = err instanceof MicCaptureError ? err : new MicCaptureError('failed', 'The microphone could not start')
      this.deps.onMicFailure?.(e.kind, e.message)
      return false
    }
  }

  private stopMic(): void {
    const capture = this.capture
    this.capture = null
    capture?.stop()
  }

  private append(pcm: Int16Array): void {
    const need = this.samples + pcm.length
    if (need > this.pcm.length) {
      let size = this.pcm.length
      while (size < need) size *= 2
      const next = new Int16Array(size)
      next.set(this.pcm.subarray(0, this.samples))
      this.pcm = next
    }
    this.pcm.set(pcm, this.samples)
    this.samples = need
  }

  private onSamples(chunk: Int16Array): void {
    if (this.snap.phase !== 'listening' && this.snap.phase !== 'starting') return
    const start = this.samples
    this.append(chunk)
    if (this.liveId) this.deps.live?.audio(this.liveId, int16ToBase64(chunk))
    if (this.segments.length === 0 || this.segments[this.segments.length - 1]!.to !== null) {
      this.openSegment(this.segmenter.openStart)
    }

    // Loudness frames → segment cuts and speech tracking.
    let frameStart = start - this.frameRemainder
    this.frameRemainder = 0
    while (frameStart + FRAME_SAMPLES <= this.samples) {
      const end = frameStart + FRAME_SAMPLES
      const rms = rmsOfInt16(this.pcm, frameStart, end)
      const res = this.segmenter.frame(rms, end)
      if (res.voiced) {
        this.lastVoicedSample = end
        this.heardMs += (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000
        this.stats.speechMs += (FRAME_SAMPLES / PCM_SAMPLE_RATE) * 1000
      }
      if (res.cut) this.closeSegmentAt(res.cut.at, res.cut.closedVoicedMs)
      frameStart = end
    }
    this.frameRemainder = this.samples - frameStart

    // Meter bars.
    const perBar = (PCM_SAMPLE_RATE * BAR_MS) / 1000
    let levels: number[] | null = null
    for (let i = 0; i < chunk.length; i += FRAME_SAMPLES) {
      const rms = rmsOfInt16(chunk, i, Math.min(chunk.length, i + FRAME_SAMPLES))
      if (rms > this.barPeak) this.barPeak = rms
      this.barSamples += Math.min(FRAME_SAMPLES, chunk.length - i)
      if (this.barSamples >= perBar) {
        levels ??= [...this.snap.levels]
        levels.push(levelFromRms(this.barPeak))
        if (levels.length > METER_BARS) levels.splice(0, levels.length - METER_BARS)
        this.barPeak = 0
        this.barSamples = 0
      }
    }

    const elapsedMs = Math.round((this.samples / PCM_SAMPLE_RATE) * 1000)
    const onDeviceMs = ((this.samples - this.deviceFrom) / PCM_SAMPLE_RATE) * 1000
    const remaining = MAX_TAKE_MS - elapsedMs
    this.set({
      elapsedMs,
      leftMs: remaining <= TAKE_WARN_MS ? Math.max(0, remaining) : null,
      // A pause after speaking is thinking, not a dead mic.
      silent: this.heardMs < MIN_SPEECH_MS && onDeviceMs >= SILENT_AFTER_MS,
      ...(levels ? { levels } : {}),
      ...this.words()
    })
    if (remaining <= 0) {
      this.finish(this.finishReason)
      return
    }
    this.pump()
  }

  private openSegment(from: number): void {
    this.segments.push({
      id: this.nextSegmentId++,
      from,
      to: null,
      voicedMs: 0,
      voicedEnd: from,
      status: 'open',
      text: '',
      partial: '',
      draftRaw: '',
      draftTo: from,
      draftFinalQuality: false,
      needsDraft: false,
      settledBy: null,
      liveAt: null
    })
  }

  /** Close `seg` at `to`: queue it, skip it, or — when its last draft heard all of it — settle it now. */
  private close(seg: Segment, to: number, voicedMs: number): void {
    seg.to = to
    seg.voicedMs = voicedMs
    seg.voicedEnd = Math.min(this.lastVoicedSample, to)
    if (seg.draftTo > to) {
      // Cut at a quiet point behind the draft: the draft has words from the next segment.
      seg.partial = ''
      seg.draftRaw = ''
      seg.draftTo = seg.from
    }
    if (voicedMs < MIN_SPEECH_MS || to <= seg.from) {
      // A live session hears it anyway; it joins the next phrase's item.
      seg.status = 'skipped'
      return
    }
    seg.status = 'queued'
    if (this.liveId) {
      this.deps.live?.commit(this.liveId)
      this.liveOrder.push(seg.id)
      seg.liveAt = this.now()
      return
    }
    if (this.draftCovers(seg)) {
      // Speech ended well inside the last draft: the draft is the words.
      this.settle(seg, seg.draftRaw, 'reuse')
      return
    }
    if (this.heardAll(seg)) {
      // Everything the draft heard is all there is: show it whole until the final lands.
      seg.partial = seg.draftRaw
      return
    }
    // A draft of the whole phrase is quick; the final may not be. Unless the
    // drafts come from the final model, where the final is the same work,
    // or finals are as quick as the draft would be.
    seg.needsDraft = this.draftsOn() && this.draftsProvisional !== false && !this.finalsQuick()
  }

  private draftsOn(): boolean {
    return this.engine === 'local' && this.opts.drafts !== false && this.draftFailures < MAX_DRAFT_FAILURES
  }

  /**
   * The segment's last draft heard all of its speech, and nothing past its
   * end: it reached the end, or went well past the last speech in it.
   */
  private heardAll(seg: Segment): boolean {
    if (seg.to === null || seg.draftTo <= seg.from || seg.draftTo > seg.to) return false
    return seg.draftTo === seg.to || seg.draftTo >= seg.voicedEnd + COVER_MARGIN
  }

  private closeSegmentAt(at: number, voicedMs: number): void {
    const open = this.segments[this.segments.length - 1]
    if (!open || open.to !== null) return
    this.close(open, at, voicedMs)
    this.openSegment(at)
  }

  private closeOpenSegment(): void {
    const open = this.segments[this.segments.length - 1]
    const { voicedMs } = this.segmenter.close(this.samples)
    if (!open || open.to !== null) return
    this.close(open, this.samples, voicedMs)
  }

  /** The segment's last draft came from the final model and heard all its speech. */
  private draftCovers(seg: Segment): boolean {
    return seg.draftFinalQuality && this.heardAll(seg)
  }

  /**
   * Finals are running past the budget: segments whose draft heard all of
   * them take the draft's words. A final that lands later still replaces them.
   */
  private useDrafts(): void {
    for (const s of this.segments) {
      if ((s.status === 'queued' || s.status === 'working') && s.draftRaw && this.heardAll(s)) {
        this.settle(s, s.draftRaw, s.draftFinalQuality ? 'reuse' : 'standin')
      }
    }
  }

  private finalsQuick(): boolean {
    return (finalCallMs.get(this.engine) ?? DEFAULT_FINAL_CALL_MS) < QUICK_FINAL_MS
  }

  /** Waiting on the finals would run past the budget. */
  private overBudget(): boolean {
    const per = finalCallMs.get(this.engine) ?? DEFAULT_FINAL_CALL_MS
    const inFlight = this.working ? Math.max(0, per - (this.now() - this.working.startedAt)) : 0
    const queued = this.segments.filter((s) => s.status === 'queued' && !this.liveOwns(s)).length
    return inFlight + queued * per > FINISH_BUDGET_MS
  }

  private settle(seg: Segment, text: string, by: NonNullable<Segment['settledBy']>): void {
    seg.status = 'done'
    seg.settledBy = by
    seg.text = dropPhantom(text, seg.voicedMs)
    seg.partial = ''
  }

  private doneText(): string {
    return joinWords(this.segments.filter((s) => s.status === 'done').map((s) => s.text))
  }

  /** Settled words, the provisional tail, and whether speech is still waiting for words. */
  private words(): Pick<TakeSnapshot, 'settled' | 'partial' | 'pending'> {
    // Settled is everything up to the first segment without final words;
    // from there on it is provisional, so words never show out of order.
    const first = this.segments.findIndex((s) => s.status !== 'done' && s.status !== 'skipped')
    if (first < 0) return { settled: this.doneText(), partial: '', pending: false }
    const tail = this.segments.slice(first).filter((s) => s.status !== 'skipped')
    return {
      settled: joinWords(this.segments.slice(0, first).filter((s) => s.status === 'done').map((s) => s.text)),
      partial: joinWords(tail.map((s) => (s.status === 'done' ? s.text : s.partial))),
      pending: tail.some((s) => this.awaitsWords(s))
    }
  }

  /** Speech in this segment is not on screen yet. */
  private awaitsWords(s: Segment): boolean {
    if (s.status === 'done') return false
    if (s.status === 'open' && this.segmenter.openVoicedMs < MIN_SPEECH_MS) return false
    if (!s.partial) return true
    // Live words are whole words as they come; the rest are on their way.
    if (this.liveId && (s.status === 'open' || s.liveAt != null)) return false
    if (splitWords(s.partial).length < splitWords(s.draftRaw).length) return true
    const voicedEnd = s.status === 'open' ? this.lastVoicedSample : s.voicedEnd
    return voicedEnd > s.draftTo
  }

  private progress(): number | null {
    const voiced = this.segments.filter((s) => s.status !== 'skipped' && s.status !== 'open')
    if (voiced.length < 2) return null
    return voiced.filter((s) => s.status === 'done').length / voiced.length
  }

  /** Start whatever each lane can take next. */
  private pump(): void {
    const phase = this.snap.phase
    if (phase !== 'listening' && phase !== 'finishing') return
    this.pumpDraft()
    this.pumpFinal()
    if (phase === 'finishing') {
      if (this.overBudget()) this.useDrafts()
      this.settleIfDone()
    }
  }

  private pumpFinal(): void {
    if (this.working) return
    if (this.blocked) {
      // A segment failed in a way the rest would too (no key, offline): hold
      // them until the take finishes, then offer Retry for all of them.
      if (this.snap.phase === 'finishing') {
        for (const s of this.segments) if (s.status === 'queued') s.status = 'failed'
      }
      return
    }
    const next = this.segments.find((s) => s.status === 'queued' && !this.liveOwns(s))
    if (next) void this.run(next, false)
  }

  private pumpDraft(): void {
    if (this.drafting || !this.draftsOn()) return
    // A phrase that just closed first: all of it on screen at once.
    const closing = this.segments.find((s) => s.needsDraft && (s.status === 'queued' || s.status === 'working'))
    if (closing) {
      void this.run(closing, true)
      return
    }
    // Live words: only Whisper on this PC — a cloud call per second would be billed.
    if (this.snap.phase !== 'listening') return
    const open = this.segments[this.segments.length - 1]
    if (!open || open.to !== null || this.segmenter.openVoicedMs < MIN_SPEECH_MS) return
    // Nothing said since the last draft: another would hear the same.
    if (this.lastVoicedSample <= open.draftTo) return
    const newAudioMs = ((this.samples - open.draftTo) / PCM_SAMPLE_RATE) * 1000
    if (newAudioMs < DRAFT_EVERY_MS) return
    void this.run(open, true)
  }

  private request(seg: Segment, to: number, draft: boolean): DictationTranscribeRequest {
    const engine = this.engine
    const req: DictationTranscribeRequest = {
      requestId: '',
      pcm16k: int16ToBase64(this.pcm.slice(seg.from, to)),
      mime: 'audio/wav',
      engine,
      allowEmpty: true
    }
    if (this.opts.language && engine !== 'local') req.language = this.opts.language
    if (draft) req.draft = true
    if (!draft && engine !== 'local') {
      const before = joinWords(this.segments.filter((s) => s.id < seg.id && s.status === 'done').map((s) => s.text))
      if (before) req.prompt = tailWords(before, PROMPT_CHARS)
      if (this.opts.workspacePath) req.workspacePath = this.opts.workspacePath
    }
    return req
  }

  private async run(seg: Segment, draft: boolean): Promise<void> {
    const gen = this.generation
    const id = this.newId()
    const to = seg.to ?? this.samples
    const voicedMs = seg.status === 'open' ? this.segmenter.openVoicedMs : seg.voicedMs
    const slot: Slot = { id, segmentId: seg.id, startedAt: this.now() }
    if (draft) {
      this.drafting = slot
      seg.needsDraft = false
    } else {
      this.working = slot
      seg.status = 'working'
    }
    const req = { ...this.request(seg, to, draft), requestId: id }
    const engine = req.engine ?? this.engine
    let res: IpcResult<DictationTranscribeResult>
    try {
      res = await this.deps.transcribe(req)
    } catch (err) {
      res = { ok: false, error: err instanceof Error ? err.message : 'Transcription failed' }
    }
    if (gen !== this.generation) return

    if (draft) {
      this.drafting = null
      this.onDraft(seg, to, voicedMs, res)
    } else {
      this.working = null
      if (res.ok) {
        const took = this.now() - slot.startedAt
        const prev = finalCallMs.get(engine)
        finalCallMs.set(engine, prev == null ? took : prev * 0.6 + took * 0.4)
        this.stats.finals += 1
        this.stats.finalMs += took
        // Also when a draft already stood in for it: the final is the better words.
        this.settle(seg, res.data.text, 'final')
      } else if (seg.status !== 'done') {
        seg.status = 'failed'
        this.blocked = true
        const code = parseDictationIpcCode(res.code) ?? 'engine_failed'
        this.set({ failure: { code, message: res.error || 'Transcription failed' } })
      }
    }
    this.set({ ...this.words(), progress: this.progress() })
    this.pump()
  }

  private onDraft(seg: Segment, to: number, voicedMs: number, res: IpcResult<DictationTranscribeResult>): void {
    // Whatever happened, this stretch has been tried: the next draft waits
    // for new audio instead of retrying at once.
    seg.draftTo = Math.max(seg.draftTo, to)
    if (!res.ok) {
      this.draftFailures += 1
      this.stats.draftFailures += 1
      return
    }
    this.draftFailures = 0
    this.stats.drafts += 1
    this.draftsProvisional = res.data.provisional === true
    if (seg.status === 'done' || seg.status === 'skipped' || seg.status === 'failed') return
    const text = dropPhantom(res.data.text, voicedMs)
    const voicedEnd = seg.status === 'open' ? this.lastVoicedSample : seg.voicedEnd
    if (to >= voicedEnd + COVER_MARGIN) {
      seg.partial = text
    } else {
      // The tail is mid-word: drop it, unless two drafts agree further.
      const agreed = agreedPrefix(seg.draftRaw, text)
      const trimmed = splitWords(text).slice(0, -1).join(' ')
      seg.partial = splitWords(agreed).length >= splitWords(trimmed).length ? agreed : trimmed
    }
    seg.draftRaw = text
    seg.draftFinalQuality = res.data.provisional !== true
    // A draft sent before the pause that still heard it all: no second one needed.
    if (this.heardAll(seg)) seg.needsDraft = false
    if ((seg.status === 'queued' || seg.status === 'working') && this.draftCovers(seg)) this.settle(seg, text, 'reuse')
  }

  private settleIfDone(): void {
    if (this.segments.some((s) => s.status === 'queued' || s.status === 'working' || s.status === 'open')) return
    const failedSeg = this.segments.find((s) => s.status === 'failed')
    if (failedSeg) {
      this.stats.failed = true
      this.set({
        phase: 'failed',
        failure: this.snap.failure ?? { code: 'engine_failed', message: 'Transcription failed' },
        keptWords: splitWords(this.doneText()).length,
        progress: null
      })
      return
    }
    const text = this.doneText()
    if (!text) {
      this.stats.failed = true
      this.set({
        phase: 'failed',
        failure: {
          code: 'nothing_heard',
          message: this.snap.deviceLabel ? `Nothing heard from ${this.snap.deviceLabel}` : 'Nothing was heard'
        },
        keptWords: 0,
        progress: null
      })
      return
    }
    const reason = this.finishReason
    this.report(reason)
    this.resetTake()
    this.set(idleSnapshot())
    this.deps.onDone(text, reason)
  }

  private set(patch: Partial<TakeSnapshot>): void {
    this.snap = { ...this.snap, ...patch }
    const st = this.stats
    if (st.firstWordsAt == null && st.listenAt != null && (this.snap.settled || this.snap.partial)) {
      st.firstWordsAt = this.now()
    }
    this.deps.onChange(this.snap)
  }
}
