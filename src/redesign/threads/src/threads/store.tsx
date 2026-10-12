import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import { SESSION_ANSWER, THREADS, cannedAnswer, type Step, type Thread, type Turn, type Work } from './data'
import { arrivedLength, streamDuration } from './stream'

/*
  One reducer for everything that happens in a session. Live runs are
  scripted as beats — Thread → Thread functions applied on a timer — so every
  direction shows the same run moving from live to settled, and a StrictMode
  double-reduce can't duplicate a step.

  A settling turn streams its answer first (state stays `running`, the clock
  is `streamStart`) and only then settles, so files, checks and the footer
  arrive after the words, in the order they would from a real model.
*/

type Beat = { ms: number; fn: (t: Thread) => Thread }

export type Queued = { id: string; text: string; mode: 'agent' | 'ask'; attachments?: string[]; model?: string }

type State = { threads: Thread[]; selected: string | null; queued: Record<string, Queued[]> }

type Action =
  | { type: 'select'; id: string | null }
  | { type: 'apply'; id: string; fn: (t: Thread) => Thread }
  | { type: 'create'; thread: Thread }
  | { type: 'enqueue'; id: string; item: Queued }
  | { type: 'unqueue'; id: string; itemId: string }
  /** New activity: the thread moves to the top of Today. */
  | { type: 'bump'; id: string }

function reduce(s: State, a: Action): State {
  switch (a.type) {
    case 'select':
      return { ...s, selected: a.id, threads: s.threads.map((t) => (t.id === a.id && t.unread ? { ...t, unread: false } : t)) }
    case 'apply':
      return {
        ...s,
        threads: s.threads.map((t) => {
          if (t.id !== a.id) return t
          const next = a.fn(t)
          // A run that settles while you look elsewhere is news: mark it unread.
          const settledNow = isLive(lastTurn(t)) && !isLive(lastTurn(next))
          return settledNow && t.id !== s.selected ? { ...next, unread: true } : next
        })
      }
    case 'bump': {
      const t = s.threads.find((x) => x.id === a.id)
      if (!t) return s
      return { ...s, threads: [{ ...t, day: 'today', age: 'now' }, ...s.threads.filter((x) => x.id !== a.id)] }
    }
    case 'create':
      return { ...s, threads: [a.thread, ...s.threads], selected: a.thread.id }
    case 'enqueue':
      return { ...s, queued: { ...s.queued, [a.id]: [...(s.queued[a.id] ?? []), a.item] } }
    case 'unqueue':
      return { ...s, queued: { ...s.queued, [a.id]: (s.queued[a.id] ?? []).filter((q) => q.id !== a.itemId) } }
  }
}

/* ─── Pure helpers over the last turn and its live step ─────────────────── */

const lastTurn = (t: Thread): Turn => t.turns[t.turns.length - 1]

const isLive = (turn: Turn): boolean => turn.state === 'running' || turn.state === 'needs'

function onLast(fn: (turn: Turn) => Turn): (t: Thread) => Thread {
  return (t) => ({ ...t, turns: [...t.turns.slice(0, -1), fn(lastTurn(t))] })
}

function onLiveStep(fn: (step: Step) => Step): (t: Thread) => Thread {
  return onLast((turn) => {
    const i = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
    if (i < 0) return turn
    return { ...turn, steps: turn.steps.map((s, k) => (k === i ? fn(s) : s)) }
  })
}

const addWork = (w: Work): ((t: Thread) => Thread) => onLiveStep((s) => ({ ...s, work: [...s.work, w] }))

/** Close the live step and start the next queued one (or none). */
const nextStep = (secs: number): ((t: Thread) => Thread) =>
  onLast((turn) => {
    const i = turn.steps.findIndex((s) => s.state === 'running' || s.state === 'needs')
    return {
      ...turn,
      steps: turn.steps.map((s, k) => (k === i ? { ...s, state: 'done', secs } : k === i + 1 && s.state === 'queued' ? { ...s, state: 'running' } : s))
    }
  })

/** The live command: show `n` more lines. */
const streamLines = (n: number): ((t: Thread) => Thread) =>
  onLiveStep((s) => ({
    ...s,
    work: s.work.map((w) => (w.kind === 'command' && w.live ? { ...w, shown: Math.min(w.out.length, (w.shown ?? 0) + n) } : w))
  }))

const finishCommand = (exit: number, secs: number): ((t: Thread) => Thread) =>
  onLiveStep((s) => ({
    ...s,
    work: s.work.map((w) => (w.kind === 'command' && w.live ? { ...w, live: false, exit, secs, shown: undefined } : w))
  }))

const elapsedOf = (turn: Turn): number => (turn.startedAt ? Math.max(1, Math.round((Date.now() - turn.startedAt) / 1000)) : turn.secs)

/** What is left of the turn's time once its closed steps are counted. */
const remaining = (turn: Turn): number => Math.max(1, elapsedOf(turn) - turn.steps.reduce((n, s) => n + (s.state === 'done' ? (s.secs ?? 0) : 0), 0))

/** Close every open step, take the patch, and stop the clock. */
const finishTurn = (patch: Partial<Turn>): ((t: Thread) => Thread) => (t) => ({
  ...onLast((turn) => ({
    ...turn,
    state: 'done',
    secs: elapsedOf(turn),
    ...patch,
    startedAt: undefined,
    steps: turn.steps.map((s) => (s.state === 'running' ? { ...s, state: 'done', secs: s.secs ?? remaining(turn) } : s))
  }))(t),
  age: 'now',
  // New edits need a fresh review; an answer that changed nothing keeps the old verdict.
  settled: patch.files?.length ? undefined : t.settled
})

/** The words first, streamed; then the turn settles with everything else. */
function settle(patch: Partial<Turn>, gap = 600): Beat[] {
  const answer = patch.answer
  if (!answer) return [{ ms: gap, fn: finishTurn(patch) }]
  return [
    { ms: gap, fn: onLast((turn) => ({ ...turn, state: 'running', answer, streamStart: Date.now() })) },
    { ms: streamDuration(answer) + 300, fn: finishTurn({ ...patch, streamStart: undefined }) }
  ]
}

function streamAll(lines: number, every: number): Beat[] {
  return Array.from({ length: lines }, () => ({ ms: every, fn: streamLines(1) }))
}

/* ─── Scripts ────────────────────────────────────────────────────────────── */

const RATE_ANSWER = [
  'Public routes are now limited to **100 requests a minute per API key**. The 101st request in a window gets `429 Too Many Requests` with a `Retry-After` header.',
  '### How it works',
  '- `rateLimit()` keeps a sliding one-minute window per key, keyed on `req.apiKey` — auth has already resolved it, so there is no second lookup.\n- It sits right after auth and before the public routes, so a request with a bad key never counts against anyone.\n- `tests/rateLimit.test.ts` covers counting per key, the 101st request, and the window reset.',
  "```ts\napp.use('/v1', auth())\napp.use('/v1', rateLimit())\napp.use('/v1', publicRoutes)\n```",
  '> The window lives in memory. With more than one instance, pass a shared store — `rateLimit(redisStore)` — so every instance counts the same requests.'
].join('\n\n')

function rateScript(): Beat[] {
  return [
    ...streamAll(11, 650),
    { ms: 500, fn: finishCommand(0, 8) },
    { ms: 300, fn: nextStep(41) },
    { ms: 700, fn: addWork({ kind: 'thought', secs: 2, text: 'Tests are green. Last, the API reference should say what the limit is and what a client sees past it.' }) },
    { ms: 900, fn: addWork({ kind: 'read', paths: ['docs/api/reference.md'] }) },
    {
      ms: 1300,
      fn: addWork({
        kind: 'edit',
        path: 'docs/api/reference.md',
        add: 14,
        del: 0,
        hunk: [
          { t: '+', s: '## Rate limits' },
          { t: '+', s: '' },
          { t: '+', s: 'Each API key may make 100 requests a minute. Past that, the API answers' },
          { t: '+', s: '`429 Too Many Requests` with a `Retry-After` header in seconds.' }
        ]
      })
    },
    ...settle({
      cost: 0.18,
      answer: RATE_ANSWER,
      files: [
        { path: 'src/middleware/rateLimit.ts', add: 64, del: 0, created: true },
        { path: 'src/server.ts', add: 3, del: 1 },
        { path: 'tests/rateLimit.test.ts', add: 48, del: 0, created: true },
        { path: 'docs/api/reference.md', add: 14, del: 0 }
      ],
      checks: [
        { text: 'The api tests pass', state: 'met', evidence: 'pnpm test --filter api · 46 passed' },
        { text: 'The 101st request in a minute gets a 429 with Retry-After', state: 'met', evidence: 'rateLimit.test.ts › answers the 101st request with 429' }
      ]
    })
  ]
}

function approvedScript(): Beat[] {
  const install = ['Downloading Chromium 141.0.7390.37 (playwright build v1194)', '|████████████████████| 100% of 148.2 MiB', 'Chromium downloaded to ~/.cache/ms-playwright/chromium-1194']
  const rerun = ['Running 20 tests using 4 workers', '  20 passed (2.4m)']
  return [
    { ms: 500, fn: addWork({ kind: 'command', cmd: 'pnpm exec playwright install chromium', live: true, shown: 0, out: install }) },
    ...streamAll(3, 900),
    { ms: 400, fn: finishCommand(0, 31) },
    {
      ms: 900,
      fn: addWork({
        kind: 'thought',
        secs: 5,
        text: 'Confirmed: in full Chromium the Pay button exists before the iframe’s script binds its handler. Waiting for the frame’s `ready` message fixes the race; the 5s timeout was hiding it.'
      })
    },
    { ms: 600, fn: nextStep(48) },
    {
      ms: 1000,
      fn: addWork({
        kind: 'edit',
        path: 'e2e/fixtures/payment.ts',
        add: 9,
        del: 2,
        hunk: [
          { t: '-', s: '  await page.waitForTimeout(500)' },
          { t: '+', s: '  await page.waitForFunction(() => window.__payFrameReady === true)' }
        ]
      })
    },
    { ms: 700, fn: addWork({ kind: 'command', cmd: 'pnpm e2e checkout --repeat-each 20', live: true, shown: 0, out: rerun }) },
    ...streamAll(2, 1100),
    { ms: 400, fn: finishCommand(0, 144) },
    ...settle({
      cost: 0.31,
      files: [{ path: 'e2e/fixtures/payment.ts', add: 9, del: 2 }],
      checks: [{ text: 'checkout.spec passes 20 runs in a row', state: 'met', evidence: 'pnpm e2e checkout --repeat-each 20 · 20 passed' }],
      answer: [
        'The test clicked **Pay** before the payment iframe had bound its handler. It only showed up when the iframe loaded late, which is why it failed about one run in three.',
        "The fixture now waits for the frame's `ready` message instead of a fixed pause:",
        "```ts\n// e2e/fixtures/payment.ts\nawait page.waitForFunction(() => window.__payFrameReady === true)\n```",
        'It passed **20 runs in a row** in full Chromium.'
      ].join('\n\n')
    })
  ]
}

function deniedScript(): Beat[] {
  return [
    ...settle(
      {
        state: 'stopped',
        answer: 'I stopped here: without full Chromium I can’t reproduce the late iframe the way CI does.\n\nAllow the install, or tell me another way to try — for example, slowing the iframe down with a route handler instead.'
      },
      300
    )
  ]
}

function retryScript(): Beat[] {
  return [
    { ms: 600, fn: addWork({ kind: 'command', cmd: 'pnpm test --filter auth', live: true, shown: 0, out: [' ✓ tests/pkce.test.ts (8 tests)', ' ✓ tests/session.test.ts (14 tests)', '', ' Test Files  2 passed (2)'] }) },
    ...streamAll(4, 700),
    { ms: 400, fn: finishCommand(0, 7) },
    { ms: 500, fn: nextStep(14) },
    { ms: 1200, fn: addWork({ kind: 'edit', path: 'src/auth/session.ts', add: 22, del: 4, hunk: [] }) },
    ...settle({
      cost: 0.23,
      error: undefined,
      checks: [{ text: 'The auth tests pass', state: 'met', evidence: 'pnpm test --filter auth · 22 passed' }],
      files: [
        { path: 'src/auth/pkce.ts', add: 52, del: 0, created: true },
        { path: 'src/auth/routes.ts', add: 34, del: 19 },
        { path: 'src/auth/session.ts', add: 22, del: 4 }
      ],
      answer:
        'Sign-in now uses the authorization code flow with **PKCE**.\n\nExisting sessions keep working: a session from the password grant is upgraded on its next refresh in `src/auth/session.ts`, instead of being signed out.'
    })
  ]
}

function mockRedisScript(): Beat[] {
  return [
    { ms: 800, fn: addWork({ kind: 'read', paths: ['tests/session.test.ts', 'src/auth/session.ts'] }) },
    {
      ms: 1100,
      fn: addWork({
        kind: 'edit',
        path: 'tests/session.test.ts',
        add: 12,
        del: 1,
        hunk: [
          { t: '-', s: "import Redis from 'ioredis'" },
          { t: '+', s: "import Redis from 'ioredis-mock'" }
        ]
      })
    },
    { ms: 700, fn: addWork({ kind: 'command', cmd: 'pnpm test --filter auth', live: true, shown: 0, out: [' ✓ tests/pkce.test.ts (8 tests)', ' ✓ tests/session.test.ts (14 tests)', '', ' Test Files  2 passed (2)'] }) },
    ...streamAll(4, 600),
    { ms: 300, fn: finishCommand(0, 6) },
    ...settle({
      cost: 0.04,
      files: [{ path: 'tests/session.test.ts', add: 12, del: 1 }],
      checks: [{ text: 'The auth tests pass', state: 'met', evidence: 'pnpm test --filter auth · 22 passed' }],
      answer: 'The session tests now use `ioredis-mock`, so they no longer need a Redis server. All **22** auth tests pass.\n\nThe PKCE flow itself is unchanged; the sessions step can carry on from here.'
    })
  ]
}

/** A follow-up: it works on the files this thread already touched. */
function followUpScript(thread: Thread | null, ask: string, mode: 'agent' | 'ask'): Beat[] {
  if (mode === 'agent' && /mock/i.test(ask) && /redis/i.test(ask)) return mockRedisScript()
  const seen = [...new Set((thread?.turns ?? []).flatMap((u) => u.files.map((f) => f.path)))]
  const paths = seen.length ? seen.slice(0, 2) : ['README.md', 'src/index.ts']
  const file = paths[0]
  return [
    { ms: 900, fn: addWork({ kind: 'read', paths }) },
    { ms: 1100, fn: addWork({ kind: 'thought', secs: 3, text: `The change belongs in ${file.split('/').pop()}; nothing else needs to move.` }) },
    ...(mode === 'agent'
      ? [{ ms: 1000, fn: addWork({ kind: 'edit', path: file, add: 4, del: 1, hunk: [] }) } satisfies Beat]
      : []),
    ...settle({
      cost: 0.02,
      answer: cannedAnswer(ask, mode, file),
      files: mode === 'agent' ? [{ path: file, add: 4, del: 1 }] : []
    })
  ]
}

function freshTurn(id: string, ask: string, mode: 'agent' | 'ask', attachments?: string[], model?: string): Turn {
  return {
    id,
    ask,
    at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false }),
    mode,
    state: 'running',
    secs: 0,
    cost: 0,
    startedAt: Date.now(),
    attachments: attachments?.length ? attachments : undefined,
    model,
    files: [],
    checks: [],
    steps: [{ title: mode === 'ask' ? 'Look into it' : 'Make the change', state: 'running', work: [] }]
  }
}

/** A live turn loaded from data gets a start time, so its clock reads true. */
/** Opening on the rich answer's scene starts it from before its answer. */
function replaying(threads: Thread[], initial: string | null): Thread[] {
  if (initial !== 'session') return threads
  return threads.map((t) => (t.id === 'session' ? { ...t, turns: t.turns.map((u) => ({ ...u, state: 'running', answer: undefined, secs: 66 })) } : t))
}

function withClocks(threads: Thread[]): Thread[] {
  const now = Date.now()
  return threads.map((t) => ({ ...t, turns: t.turns.map((u) => (isLive(u) ? { ...u, startedAt: now - u.secs * 1000 } : u)) }))
}

/* ─── Provider ───────────────────────────────────────────────────────────── */

export type SendOptions = { attachments?: string[]; model?: string }

type Store = {
  threads: Thread[]
  selected: Thread | null
  queued: Queued[]
  select: (id: string | null) => void
  send: (text: string, mode: 'agent' | 'ask', opts?: SendOptions) => void
  /** Deliver a queued message into the live run now, instead of after it. */
  steer: (itemId: string) => void
  /** Deliver words straight into the live run (Shift Enter while it works). */
  steerNow: (text: string, attachments?: string[]) => void
  unqueue: (itemId: string) => void
  answer: (choice: 'once' | 'always' | 'deny') => void
  stop: () => void
  retry: () => void
  /** Replace a turn's ask and run it again; later turns are dropped. */
  rerun: (turnId: string, text: string) => void
  rate: (turnId: string, rating: 'up' | 'down' | null) => void
  /** Keep or undo every edit in the thread, from Review. */
  settleEdits: (how: 'kept' | 'undone') => void
}

const Ctx = createContext<Store | null>(null)

export function useThreads(): Store {
  const s = useContext(Ctx)
  if (!s) throw new Error('useThreads outside ThreadsProvider')
  return s
}

export function ThreadsProvider({ initial, children }: { initial: string | null; children: ReactNode }) {
  const [state, dispatch] = useReducer(reduce, undefined, (): State => ({ threads: withClocks(replaying(THREADS, initial)), selected: initial, queued: {} }))
  const timers = useRef(new Map<string, number[]>())
  const seq = useRef(0)
  const sent = useRef(new Set<string>())

  const cancel = useCallback((id: string) => {
    for (const h of timers.current.get(id) ?? []) clearTimeout(h)
    timers.current.delete(id)
  }, [])

  const play = useCallback(
    (id: string, beats: Beat[]) => {
      cancel(id)
      let at = 0
      const hs = beats.map((b) => {
        at += b.ms
        return window.setTimeout(() => dispatch({ type: 'apply', id, fn: b.fn }), at)
      })
      timers.current.set(id, hs)
    },
    [cancel]
  )

  /** Start a new turn on an existing thread. */
  const follow = useCallback(
    (thread: Thread, ask: string, mode: 'agent' | 'ask', opts?: SendOptions) => {
      const id = thread.id
      dispatch({ type: 'apply', id, fn: (t) => ({ ...t, turns: [...t.turns, freshTurn(`${t.id}-${t.turns.length + 1}`, ask, mode, opts?.attachments, opts?.model)] }) })
      dispatch({ type: 'bump', id })
      play(id, followUpScript(thread, ask, mode))
    },
    [play]
  )

  // The live thread starts moving as soon as the mockup opens.
  useEffect(() => {
    play('rate', [{ ms: 0, fn: streamLines(0) }, ...rateScript()])
    // The rich answer's scene writes it again, so its streaming can be watched.
    if (initial === 'session') play('session', settle({ answer: SESSION_ANSWER, secs: 71 }, 700))
    const all = timers.current
    return () => {
      for (const hs of all.values()) hs.forEach(clearTimeout)
      all.clear()
    }
  }, [play, initial])

  // A queued message goes out the moment its run finishes. After a stop, a
  // denial or a failure it waits: you decide whether it still makes sense.
  useEffect(() => {
    for (const t of state.threads) {
      const next = state.queued[t.id]?.[0]
      if (!next || lastTurn(t).state !== 'done' || lastTurn(t).streamStart != null || sent.current.has(next.id)) continue
      sent.current.add(next.id)
      dispatch({ type: 'unqueue', id: t.id, itemId: next.id })
      follow(t, next.text, next.mode, { attachments: next.attachments, model: next.model })
    }
  }, [state.threads, state.queued, follow])

  const selected = state.threads.find((t) => t.id === state.selected) ?? null

  const store = useMemo<Store>(() => {
    const id = selected?.id
    return {
      threads: state.threads,
      selected,
      queued: id ? (state.queued[id] ?? []) : [],
      select: (next) => dispatch({ type: 'select', id: next }),
      send: (text, mode, opts) => {
        const ask = text.trim()
        if (!ask) return
        seq.current += 1
        if (!selected) {
          const tid = `new-${seq.current}`
          dispatch({
            type: 'create',
            thread: {
              id: tid,
              title: ask.length > 48 ? `${ask.slice(0, 46).trimEnd()}…` : ask,
              workspace: 'storefront',
              branch: 'main',
              age: 'now',
              day: 'today',
              turns: [freshTurn(`${tid}-1`, ask, mode, opts?.attachments, opts?.model)]
            }
          })
          play(tid, followUpScript(null, ask, mode))
          return
        }
        if (isLive(lastTurn(selected))) {
          dispatch({ type: 'enqueue', id: selected.id, item: { id: `q-${seq.current}`, text: ask, mode, attachments: opts?.attachments, model: opts?.model } })
          return
        }
        follow(selected, ask, mode, opts)
      },
      steer: (itemId) => {
        if (!id || !selected) return
        const item = state.queued[id]?.find((q) => q.id === itemId)
        if (!item) return
        dispatch({ type: 'unqueue', id, itemId })
        // Into the run while it works; once it has stopped, as the next turn.
        if (isLive(lastTurn(selected))) dispatch({ type: 'apply', id, fn: addWork({ kind: 'steer', text: item.text, attachments: item.attachments }) })
        else follow(selected, item.text, item.mode, { attachments: item.attachments, model: item.model })
      },
      steerNow: (text, attachments) => {
        if (!id || !selected || !isLive(lastTurn(selected)) || !text.trim()) return
        dispatch({ type: 'apply', id, fn: addWork({ kind: 'steer', text: text.trim(), attachments: attachments?.length ? attachments : undefined }) })
      },
      unqueue: (itemId) => id && dispatch({ type: 'unqueue', id, itemId }),
      answer: (choice) => {
        if (!id || !selected || !pendingAsk(lastTurn(selected))) return
        // Denying ends the wait at once, so nothing still reads "waiting" while it wraps up.
        dispatch({
          type: 'apply',
          id,
          fn: onLast((turn) => ({
            ...turn,
            state: 'running',
            steps: turn.steps.map((s) =>
              s.state === 'needs'
                ? { ...s, state: choice === 'deny' ? 'stopped' : 'running', work: s.work.map((w) => (w.kind === 'approval' && !w.answer ? { ...w, answer: choice } : w)) }
                : s
            )
          }))
        })
        play(id, choice === 'deny' ? deniedScript() : approvedScript())
      },
      stop: () => {
        if (!id) return
        cancel(id)
        dispatch({
          type: 'apply',
          id,
          fn: onLast((turn) => {
            // A half-streamed answer keeps what had arrived, never the rest.
            const answer = turn.answer && turn.streamStart ? turn.answer.slice(0, arrivedLength(turn.answer, Date.now() - turn.streamStart)) : turn.answer
            return {
              ...turn,
              state: 'stopped',
              answer,
              streamStart: undefined,
              secs: elapsedOf(turn),
              startedAt: undefined,
              steps: turn.steps.map((s) =>
                s.state === 'running' || s.state === 'needs'
                  ? { ...s, state: 'stopped', work: s.work.map((w) => (w.kind === 'command' && w.live ? { ...w, live: false, shown: undefined, out: w.out.slice(0, w.shown ?? 0) } : w)) }
                  : s
              )
            }
          })
        })
      },
      retry: () => {
        if (!id || !selected) return
        const last = lastTurn(selected).state
        if (last !== 'failed' && last !== 'stopped') return
        dispatch({
          type: 'apply',
          id,
          fn: onLast((turn) => ({
            ...turn,
            state: 'running',
            error: undefined,
            startedAt: Date.now() - turn.secs * 1000,
            steps: turn.steps.map((s) => (s.state === 'failed' || s.state === 'stopped' ? { ...s, state: 'running', work: [] } : s))
          }))
        })
        play(id, retryScript())
      },
      rerun: (turnId, text) => {
        if (!id || !selected) return
        const at = selected.turns.findIndex((u) => u.id === turnId)
        if (at < 0 || !text.trim()) return
        const { mode, model, attachments } = selected.turns[at]
        cancel(id)
        seq.current += 1
        dispatch({
          type: 'apply',
          id,
          fn: (t) => ({ ...t, turns: [...t.turns.slice(0, at), freshTurn(`${t.id}-r${seq.current}`, text.trim(), mode, attachments, model)] })
        })
        dispatch({ type: 'bump', id })
        play(id, followUpScript(selected, text.trim(), mode))
      },
      rate: (turnId, rating) => {
        if (!id) return
        dispatch({ type: 'apply', id, fn: (t) => ({ ...t, turns: t.turns.map((u) => (u.id === turnId ? { ...u, rating: rating ?? undefined } : u)) }) })
      },
      settleEdits: (how) => {
        if (!id || !selected || isLive(lastTurn(selected))) return
        dispatch({ type: 'apply', id, fn: (t) => ({ ...t, settled: how }) })
      }
    }
  }, [state.threads, state.queued, selected, play, cancel, follow])

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>
}

/* ─── Derived facts every direction reads ───────────────────────────────── */

export type ThreadState = 'running' | 'needs' | 'review' | 'done' | 'failed' | 'stopped'

export function threadState(t: Thread): ThreadState {
  const turn = lastTurn(t)
  if (turn.state === 'done') return !t.settled && t.turns.some((u) => u.files.length > 0) ? 'review' : 'done'
  return turn.state
}

export function liveActivity(turn: Turn): string | null {
  if (turn.state !== 'running') return null
  if (turn.answer) return 'Writing the answer'
  const step = turn.steps.find((s) => s.state === 'running')
  const running = step?.work.find((x) => x.kind === 'command' && x.live)
  if (running?.kind === 'command') return `Running ${running.cmd}`
  const w = step?.work[step.work.length - 1]
  if (!w) return 'Thinking'
  if (w.kind === 'steer') return 'Reading what you said'
  if (w.kind === 'command') return w.live ? `Running ${w.cmd}` : 'Thinking'
  if (w.kind === 'edit') return `Editing ${w.path.split('/').pop()}`
  if (w.kind === 'read') return `Reading ${w.paths[w.paths.length - 1].split('/').pop()}`
  if (w.kind === 'search') return `Searching ${w.query}`
  return 'Thinking'
}

export function pendingAsk(turn: Turn): Extract<Work, { kind: 'approval' }> | null {
  if (turn.state !== 'needs') return null
  for (const s of turn.steps) if (s.state === 'needs') for (const w of s.work) if (w.kind === 'approval' && !w.answer) return w
  return null
}

const DAY_ORDER: Thread['day'][] = ['today', 'yesterday', 'earlier']

/** The order the list shows: anything waiting on you first, then by day, newest first. */
export function listOrder(threads: Thread[]): Thread[] {
  const needs = threads.filter((t) => threadState(t) === 'needs')
  const rest = threads.filter((t) => threadState(t) !== 'needs')
  return [...needs, ...DAY_ORDER.flatMap((d) => rest.filter((t) => t.day === d))]
}

export { lastTurn, isLive }
