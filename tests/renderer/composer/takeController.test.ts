import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  DictationLiveEvent,
  DictationTakeStats,
  DictationTranscribeRequest,
  IpcResult,
  DictationTranscribeResult
} from '@shared/ipc'
import { dictationIpcCode } from '@shared/ipc'
import { MicCaptureError, type OpenMicCapture } from '@renderer/lib/audio/micCapture'
import {
  FINISH_BUDGET_MS,
  RESTORE_WINDOW_MS,
  resetTakeTimingsForTests,
  agreedPrefix,
  collapseLoops,
  dropPhantom,
  TakeController,
  type LiveTranscriber,
  type TakeFinish,
  type TakeSnapshot
} from '@renderer/features/chat/components/composer/take/takeController'

const RATE = 16000

function tone(ms: number, amp = 0.3): Int16Array {
  const n = Math.round((RATE * ms) / 1000)
  const out = new Int16Array(n)
  for (let i = 0; i < n; i++) out[i] = Math.round(Math.sin((2 * Math.PI * 220 * i) / RATE) * amp * 32767)
  return out
}

function silence(ms: number): Int16Array {
  return new Int16Array(Math.round((RATE * ms) / 1000))
}

type Pending = { req: DictationTranscribeRequest; resolve: (r: IpcResult<DictationTranscribeResult>) => void }

/** A live session the test drives: what the take sent it, and a way to answer. */
function fakeLive(opts: { openFails?: boolean } = {}) {
  let handler: ((e: DictationLiveEvent) => void) | null = null
  const sent: string[] = []
  let audioChunks = 0
  const live: LiveTranscriber = {
    open: vi.fn(async (req) => {
      sent.push(`open ${req.takeId}`)
      return opts.openFails ? { ok: false as const, error: 'no key' } : { ok: true as const, data: true }
    }),
    audio: () => {
      audioChunks++
    },
    commit: (takeId) => sent.push(`commit ${takeId}`),
    close: (takeId) => sent.push(`close ${takeId}`),
    subscribe: (h) => {
      handler = h
      return () => {
        handler = null
      }
    }
  }
  return {
    live,
    sent,
    audioChunks: () => audioChunks,
    emit: async (e: Omit<Extract<DictationLiveEvent, { kind: 'words' }>, 'takeId' | 'kind'> | { error: string }, takeId = 'req-1') => {
      handler?.('error' in e ? { takeId, kind: 'error', message: e.error } : { takeId, kind: 'words', ...e })
      await flush()
    }
  }
}

function harness(opts: { refuse?: MicCaptureError; live?: LiveTranscriber } = {}) {
  let onSamples: (pcm: Int16Array) => void = () => undefined
  let onEnded: () => void = () => undefined
  const stop = vi.fn()
  const openCapture = vi.fn<OpenMicCapture>(async (o) => {
    if (opts.refuse) throw opts.refuse
    onSamples = o.onSamples
    onEnded = o.onEnded ?? (() => undefined)
    return { deviceLabel: 'Test Mic', deviceId: 'mic-1', stop }
  })
  const calls: Pending[] = []
  const transcribe = vi.fn(
    (req: DictationTranscribeRequest) =>
      new Promise<IpcResult<DictationTranscribeResult>>((resolve) => {
        calls.push({ req, resolve })
      })
  )
  const snaps: TakeSnapshot[] = []
  const done: Array<{ text: string; reason: TakeFinish }> = []
  const micFailures: string[] = []
  const stats: DictationTakeStats[] = []
  let id = 0
  const take = new TakeController({
    openCapture,
    transcribe,
    cancel: vi.fn(),
    onChange: (s) => snaps.push(s),
    onDone: (text, reason) => done.push({ text, reason }),
    onMicFailure: (kind) => micFailures.push(kind),
    onStats: (st) => stats.push(st),
    live: opts.live,
    newId: () => `req-${++id}`
  })
  /** Push audio the way the tap does: 2048-sample chunks. */
  const push = (pcm: Int16Array): void => {
    for (let i = 0; i < pcm.length; i += 2048) onSamples(pcm.subarray(i, i + 2048))
  }
  const answer = async (i: number, text: string, extra: { provisional?: boolean } = {}): Promise<void> => {
    calls[i]!.resolve({ ok: true, data: { text, ...extra } })
    await flush()
  }
  const fail = async (i: number, code: Parameters<typeof dictationIpcCode>[0], error: string): Promise<void> => {
    calls[i]!.resolve({ ok: false, error, code: dictationIpcCode(code) })
    await flush()
  }
  return { take, openCapture, stop, calls, push, answer, fail, done, micFailures, stats, end: () => onEnded(), last: () => take.snapshot }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

afterEach(() => {
  vi.useRealTimers()
  resetTakeTimingsForTests()
})

describe('TakeController', () => {
  it('transcribes each segment as it closes and joins them when the take finishes', async () => {
    const h = harness()
    expect(await h.take.start({ engine: 'openai' })).toBe(true)
    expect(h.last().phase).toBe('listening')
    expect(h.last().deviceLabel).toBe('Test Mic')

    h.push(tone(1500))
    h.push(silence(800))
    // The pause closed the first segment; it went out while still listening.
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.req).toMatchObject({ engine: 'openai', allowEmpty: true, mime: 'audio/wav' })
    const bytes = atob(h.calls[0]!.req.pcm16k!).length
    expect(bytes / 2 / RATE).toBeCloseTo(2.1, 1)

    await h.answer(0, 'hello there')
    expect(h.last().settled).toBe('hello there')

    h.push(tone(1000))
    expect(h.last().pending).toBe(true)
    h.take.finish('insert')
    expect(h.last().phase).toBe('finishing')
    expect(h.stop).toHaveBeenCalled()
    expect(h.calls).toHaveLength(2)
    await h.answer(1, 'general kenobi')

    expect(h.done).toEqual([{ text: 'hello there general kenobi', reason: 'insert' }])
    expect(h.last().phase).toBe('idle')
    expect(h.stats).toHaveLength(1)
    expect(h.stats[0]).toMatchObject({
      outcome: 'insert',
      engine: 'openai',
      segments: 2,
      finals: 2,
      drafts: 0,
      standIns: 0,
      reusedDrafts: 0
    })
    expect(h.stats[0]!.audioMs).toBeGreaterThanOrEqual(3200)
    expect(h.stats[0]!.speechMs).toBeGreaterThanOrEqual(2400)
    expect(h.stats[0]!.firstWordsMs).not.toBeNull()
    expect(h.stats[0]!.finishWaitMs).not.toBeNull()
    expect(h.stats[0]!.finalAvgMs).not.toBeNull()
  })

  it('a cloud engine is never asked for live words — only closed segments', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(3000))
    expect(h.calls).toHaveLength(0)
    expect(h.last().pending).toBe(true)
    expect(h.last().partial).toBe('')
  })

  it('Whisper on this PC drafts the open segment, holding back the word it may have cut', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1200))
    expect(h.calls).toHaveLength(1)
    expect(h.calls[0]!.req.draft).toBe(true)
    // Speech is still coming in: the draft's last word is Whisper's guess.
    await h.answer(0, 'Please refactor the video.')
    expect(h.last().partial).toBe('Please refactor the')
    expect(h.last().pending).toBe(true)

    h.push(tone(700))
    expect(h.calls).toHaveLength(2)
    await h.answer(1, 'please refactor the settings page')
    expect(h.last().partial).toBe('please refactor the settings')
    expect(h.last().settled).toBe('')
    expect(h.last().pending).toBe(true)
  })

  it('a draft that heard all the speech shows whole, and stands as the final words', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1000))
    await h.answer(0, 'hello')
    h.push(silence(300))
    expect(h.calls).toHaveLength(2)
    await h.answer(1, 'Hello there.')
    expect(h.last().partial).toBe('Hello there.')
    expect(h.last().pending).toBe(false)

    // The pause closes the segment; its last draft already covered the speech.
    h.push(silence(800))
    expect(h.calls).toHaveLength(2)
    expect(h.last().settled).toBe('Hello there.')
    h.take.finish()
    expect(h.done).toEqual([{ text: 'Hello there.', reason: 'insert' }])
  })

  it('a draft from the faster model is shown but never stands as final', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1000))
    await h.answer(0, 'hello', { provisional: true })
    h.push(silence(300))
    await h.answer(1, 'hello there', { provisional: true })
    expect(h.last().partial).toBe('hello there')
    h.push(silence(800))
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2]!.req.draft).toBeUndefined()
    await h.answer(2, 'Hello there.')
    expect(h.last().settled).toBe('Hello there.')
  })

  it('drafts run in their own lane: a closed phrase is drafted whole while its final is still working', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(2000))
    expect(h.calls.map((c) => c.req.draft)).toEqual([true])
    h.push(silence(800))
    // The pause closed the segment: its final went out beside the open draft.
    expect(h.calls.map((c) => c.req.draft)).toEqual([true, undefined])
    await h.answer(0, 'hello', { provisional: true })
    // That draft stopped short of the phrase's end: the draft lane drafts it again, whole.
    expect(h.calls).toHaveLength(3)
    expect(h.calls[2]!.req.draft).toBe(true)
    await h.answer(2, 'hello there', { provisional: true })
    expect(h.last().partial).toBe('hello there')
    expect(h.last().pending).toBe(false)
    expect(h.last().settled).toBe('')
    await h.answer(1, 'Hello there.')
    expect(h.last().settled).toBe('Hello there.')
    expect(h.last().partial).toBe('')
  })

  it('after the finish budget, a phrase still waiting on its final lands as its full draft', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1000))
    await h.answer(0, 'hel', { provisional: true })
    h.take.finish()
    // The final and a whole-phrase draft go out together.
    expect(h.calls.map((c) => c.req.draft)).toEqual([true, true, undefined])
    await h.answer(1, 'Hello there', { provisional: true })
    expect(h.done).toEqual([])
    vi.advanceTimersByTime(FINISH_BUDGET_MS + 1)
    await flush()
    expect(h.done).toEqual([{ text: 'Hello there', reason: 'insert' }])
    // The final landing afterwards belongs to a take that is over.
    await h.answer(2, 'Hello there.')
    expect(h.done).toHaveLength(1)
    expect(h.stats).toEqual([
      expect.objectContaining({ outcome: 'insert', segments: 1, finals: 0, drafts: 2, standIns: 1, finishWaitMs: FINISH_BUDGET_MS })
    ])
  })

  it('finals as quick as a draft (Moonshine) get no whole-phrase draft as a phrase closes', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1000))
    await h.answer(0, 'hel', { provisional: true })
    h.push(silence(800))
    // First phrase: finals are untimed, so it gets a closing draft next to its final.
    expect(h.calls.map((c) => c.req.draft)).toEqual([true, true, undefined])
    await h.answer(2, 'Hello there.')
    await h.answer(1, 'Hello there', { provisional: true })
    // That final came back at once: the next phrase goes straight to its final.
    const before = h.calls.length
    h.push(tone(1000))
    const draftsWhileSpeaking = h.calls.length - before
    h.push(silence(800))
    const closing = h.calls.slice(before + draftsWhileSpeaking)
    expect(closing.map((c) => c.req.draft)).toEqual([undefined])
  })

  it('with no Whisper model to draft with, words come at each pause, never mid-phrase', async () => {
    const h = harness()
    await h.take.start({ engine: 'local', drafts: false })
    h.push(tone(2000))
    expect(h.calls).toHaveLength(0)
    h.push(silence(800))
    expect(h.calls.map((c) => c.req.draft)).toEqual([undefined])
  })

  it('a failed draft waits for new audio instead of retrying at once', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(1200))
    await h.fail(0, 'engine_failed', 'Whisper stopped')
    expect(h.calls).toHaveLength(1)
    // A failed draft is not a failed take.
    expect(h.last().failure).toBeNull()
    h.push(tone(700))
    expect(h.calls).toHaveLength(2)
  })

  it('drops what Whisper says over a breath or a click', async () => {
    const h = harness()
    await h.take.start({ engine: 'local' })
    h.push(tone(300))
    h.push(silence(900))
    // A draft went out while the segment was open; the pause closed it and
    // its final went out in the other lane. Both say Whisper's phantom.
    expect(h.calls[0]!.req.draft).toBe(true)
    expect(h.calls[1]!.req.draft).toBeUndefined()
    await h.answer(0, ' you')
    expect(h.last().partial).toBe('')
    await h.answer(1, ' you')
    // The draft heard it all: no second draft of the closed segment.
    expect(h.calls).toHaveLength(2)
    h.take.finish()
    expect(h.done).toEqual([])
    expect(h.last().failure?.code).toBe('nothing_heard')
  })

  it('sends a cloud segment the words before it, for continuity', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(1500))
    h.push(silence(800))
    expect(h.calls[0]!.req.prompt).toBeUndefined()
    await h.answer(0, 'First we open the settings.')
    h.push(tone(1500))
    h.push(silence(800))
    expect(h.calls[1]!.req.prompt).toBe('First we open the settings.')
  })

  it('cloud finals name the workspace, so main can add its file names as words to expect', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai', workspacePath: 'C:/work/app' })
    h.push(tone(1500))
    h.push(silence(800))
    expect(h.calls[0]!.req.workspacePath).toBe('C:/work/app')
    const local = harness()
    await local.take.start({ engine: 'local', workspacePath: 'C:/work/app' })
    local.push(tone(1500))
    expect(local.calls.every((c) => c.req.workspacePath === undefined)).toBe(true)
  })

  it('OpenAI live words: streams the audio, commits each phrase, and its transcript settles it with no request', async () => {
    const f = fakeLive()
    const h = harness({ live: f.live })
    await h.take.start({ engine: 'openai', live: true })
    h.push(tone(1000))
    expect(f.audioChunks()).toBeGreaterThan(0)
    // Words while the phrase is still being spoken.
    await f.emit({ ordinal: 0, text: 'Please refactor', final: false })
    expect(h.last().partial).toBe('Please refactor')
    expect(h.last().pending).toBe(false)
    h.push(silence(800))
    expect(f.sent).toEqual(['open req-1', 'commit req-1'])
    await f.emit({ ordinal: 0, text: 'Please refactor the settings page.', final: true })
    expect(h.last().settled).toBe('Please refactor the settings page.')
    h.push(tone(900))
    await f.emit({ ordinal: 1, text: 'Then run', final: false })
    h.take.finish()
    expect(f.sent.at(-1)).toBe('commit req-1')
    await f.emit({ ordinal: 1, text: 'Then run the tests.', final: true })
    expect(h.done).toEqual([{ text: 'Please refactor the settings page. Then run the tests.', reason: 'insert' }])
    expect(h.calls).toHaveLength(0)
    expect(f.sent.at(-1)).toBe('close req-1')
    expect(h.stats[0]).toMatchObject({ finals: 2, segments: 2 })
  })

  it('a live session that fails hands its phrases to one request each, without losing any', async () => {
    const f = fakeLive()
    const h = harness({ live: f.live })
    await h.take.start({ engine: 'openai', live: true })
    h.push(tone(1000))
    h.push(silence(800))
    expect(h.calls).toHaveLength(0)
    await f.emit({ error: 'socket closed' })
    expect(h.calls).toHaveLength(1)
    await h.answer(0, 'First phrase.')
    h.push(tone(900))
    h.take.finish()
    expect(h.calls).toHaveLength(2)
    await h.answer(1, 'Second phrase.')
    expect(h.done).toEqual([{ text: 'First phrase. Second phrase.', reason: 'insert' }])
  })

  it('a live session that cannot open leaves the take on per-phrase requests', async () => {
    const f = fakeLive({ openFails: true })
    const h = harness({ live: f.live })
    await h.take.start({ engine: 'openai', live: true })
    await flush()
    h.push(tone(1000))
    h.push(silence(800))
    expect(h.calls).toHaveLength(1)
    expect(f.sent).toEqual(['open req-1', 'close req-1'])
  })

  it('past the finish budget, a phrase the session has not finished gets a request of its own', async () => {
    vi.useFakeTimers()
    const f = fakeLive()
    const h = harness({ live: f.live })
    await h.take.start({ engine: 'openai', live: true })
    h.push(tone(1000))
    h.take.finish()
    expect(h.calls).toHaveLength(0)
    vi.advanceTimersByTime(FINISH_BUDGET_MS + 1)
    await flush()
    expect(h.calls).toHaveLength(1)
    await h.answer(0, 'From the request.')
    expect(h.done).toEqual([{ text: 'From the request.', reason: 'insert' }])
  })

  it('live words are only for OpenAI, and only when asked for', async () => {
    const f = fakeLive()
    const h = harness({ live: f.live })
    await h.take.start({ engine: 'openrouter', live: true })
    h.push(tone(1000))
    h.push(silence(800))
    expect(f.sent).toEqual([])
    expect(h.calls).toHaveLength(1)
  })

  it('a failed take can still insert the words it has', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(1500))
    h.push(silence(800))
    await h.answer(0, 'kept words here')
    h.push(tone(1500))
    h.take.finish()
    await h.fail(1, 'rate_limited', 'OpenAI is rate-limiting this key (429)')
    expect(h.last().phase).toBe('failed')
    expect(h.last().keptWords).toBe(3)
    h.take.keep()
    expect(h.done).toEqual([{ text: 'kept words here', reason: 'insert' }])
    expect(h.last().phase).toBe('idle')
  })

  it('passes the language hint and the send reason through', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai', language: 'de' })
    h.push(tone(800))
    h.take.finish('send')
    expect(h.calls[0]!.req.language).toBe('de')
    await h.answer(0, 'hallo')
    expect(h.done).toEqual([{ text: 'hallo', reason: 'send' }])
  })

  it('discard keeps the take; restore reopens the mic and carries on', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(600))
    const before = h.last().elapsedMs
    h.take.discard()
    expect(h.last().phase).toBe('discarded')
    expect(h.last().discardedFrom).toBe('listening')
    expect(h.stop).toHaveBeenCalledTimes(1)

    await h.take.restore()
    expect(h.openCapture).toHaveBeenCalledTimes(2)
    expect(h.last().phase).toBe('listening')
    h.push(tone(600))
    expect(h.last().elapsedMs).toBeGreaterThan(before)
    h.take.finish()
    // One segment: the audio from before and after the discard, together.
    expect(atob(h.calls[0]!.req.pcm16k!).length / 2 / RATE).toBeCloseTo(1.2, 1)
  })

  it('a discarded take is gone for good after the restore window', async () => {
    vi.useFakeTimers()
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(600))
    h.take.discard()
    vi.advanceTimersByTime(RESTORE_WINDOW_MS + 1)
    expect(h.last().phase).toBe('idle')
    await h.take.restore()
    expect(h.last().phase).toBe('idle')
    expect(h.stats).toEqual([expect.objectContaining({ outcome: 'discarded', finishWaitMs: null })])
  })

  it('a failed segment holds the rest; the take fails with its code, and Retry elsewhere keeps the audio', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(1500))
    h.push(silence(800))
    await h.fail(0, 'offline', 'No connection — OpenAI could not be reached')
    h.push(tone(1500))
    h.push(silence(800))
    // Held: the second segment was not sent while the first one's failure stands.
    expect(h.calls).toHaveLength(1)
    h.take.finish()
    expect(h.last().phase).toBe('failed')
    expect(h.last().failure).toEqual({ code: 'offline', message: 'No connection — OpenAI could not be reached' })

    h.take.retry('local')
    expect(h.last().phase).toBe('finishing')
    expect(h.last().engine).toBe('local')
    expect(h.calls[1]!.req.engine).toBe('local')
    await h.answer(1, 'first part')
    expect(h.calls[2]!.req.engine).toBe('local')
    await h.answer(2, 'second part')
    expect(h.done[0]!.text).toBe('first part second part')
  })

  it('reports a take that heard nothing, without sending anything', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(silence(2500))
    h.take.finish()
    expect(h.calls).toHaveLength(0)
    expect(h.last().phase).toBe('failed')
    expect(h.last().failure).toEqual({ code: 'nothing_heard', message: 'Nothing heard from Test Mic' })
  })

  it('flags silence after four seconds and clears it when speech comes back', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(silence(4200))
    expect(h.last().silent).toBe(true)
    h.push(tone(300))
    expect(h.last().silent).toBe(false)
  })

  it('a pause after speaking is not a silent microphone', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(1000))
    h.push(silence(6000))
    expect(h.last().silent).toBe(false)
  })

  it('a refused microphone is reported and the take stays idle', async () => {
    const h = harness({ refuse: new MicCaptureError('blocked', 'The microphone is blocked') })
    expect(await h.take.start({ engine: 'openai' })).toBe(false)
    expect(h.micFailures).toEqual(['blocked'])
    expect(h.last().phase).toBe('idle')
  })

  it('a device that goes away mid-take finishes with what was said', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(800))
    h.end()
    expect(h.last().phase).toBe('finishing')
    await h.answer(0, 'kept')
    expect(h.done[0]!.text).toBe('kept')
  })

  it('finishing before the mic opened throws nothing away but also sends nothing', async () => {
    const h = harness()
    const started = h.take.start({ engine: 'openai' })
    h.take.finish()
    await started
    expect(h.last().phase).toBe('idle')
    expect(h.calls).toHaveLength(0)
    expect(h.done).toEqual([])
    expect(h.stats).toEqual([])
  })

  it('late answers from a disposed take are ignored', async () => {
    const h = harness()
    await h.take.start({ engine: 'openai' })
    h.push(tone(800))
    h.take.finish()
    h.take.dispose()
    await h.answer(0, 'too late')
    expect(h.done).toEqual([])
    expect(h.last().phase).toBe('idle')
  })

  it('hold is shown only while the mic is open', async () => {
    const h = harness()
    h.take.setHold(true)
    expect(h.last().hold).toBe(false)
    await h.take.start({ engine: 'openai' })
    h.take.setHold(true)
    expect(h.last().hold).toBe(true)
    h.push(tone(500))
    h.take.finish()
    expect(h.last().hold).toBe(false)
  })
})

describe('take word helpers', () => {
  it('agreedPrefix keeps the words two drafts share, ignoring case and punctuation', () => {
    expect(agreedPrefix('Please refactor the video.', 'please refactor the settings page')).toBe('please refactor the')
    expect(agreedPrefix('the settings page.', 'The settings page so')).toBe('The settings page')
    expect(agreedPrefix('', 'anything')).toBe('')
  })

  it('collapseLoops keeps one copy of a decoder loop and leaves real repetition alone', () => {
    expect(collapseLoops('Keep the changes small small small small.')).toBe('Keep the changes small.')
    expect(collapseLoops('the chain the chain the chain works')).toBe('the chain works')
    expect(collapseLoops('it is very very very good')).toBe('it is very very very good')
    expect(collapseLoops('no no, not that one')).toBe('no no, not that one')
    expect(collapseLoops('I think that I think that is fine')).toBe('I think that I think that is fine')
    expect(dropPhantom('go go go go go now', 3000)).toBe('go now')
  })

  it('dropPhantom removes Whisper silence phrases only when there was barely any speech', () => {
    expect(dropPhantom(' you', 300)).toBe('')
    expect(dropPhantom('Thank you.', 300)).toBe('')
    expect(dropPhantom('Thank you.', 900)).toBe('Thank you.')
    expect(dropPhantom('you should run the tests', 300)).toBe('you should run the tests')
    expect(dropPhantom('[BLANK_AUDIO]', 300)).toBe('[BLANK_AUDIO]')
  })
})
