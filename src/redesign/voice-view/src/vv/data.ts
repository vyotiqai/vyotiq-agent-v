import type { VoiceSessionState } from '@shared/voiceSession'

/*
  What a voice session holds, as the three directions read it. The shapes are
  the controller's (VoiceLine, the run tap's progress) with the one thing the
  shipped view lacks: a hand-off owns the work it started, so the steps and
  the result sit with it instead of in another pane.
*/

/** One step of the agent's work, as the run tap reports it (tool and summary, never output). */
export type Step = { id: string; tool: string; summary: string; state: 'running' | 'done' | 'failed' }

export type Work = {
  /** The brief the voice handed over: an instruction, not narration (A-47). */
  brief: string
  state: 'running' | 'needs' | 'done' | 'failed'
  /** "1 min 12 s" — how long it has run, or ran. */
  elapsed: string
  steps: Step[]
  /** The agent's answer, in its words (the voice says the short form). */
  result?: string
  /** What it is blocked on. `risky`: the command guard's danger, never answered by voice or a click here. */
  ask?: { kind: 'approval'; what: string; command: string; risky?: boolean; always?: boolean } | { kind: 'question'; prompt: string; options: string[] }
  /** The task never took the hand-off, and why (the voice had said "On it."). */
  notSent?: string
}

export type Entry =
  | { id: string; who: 'you'; text: string; /** Heard and left unanswered on purpose (a filler, talk not meant for it). */ unanswered?: boolean }
  | { id: string; who: 'voice'; text: string }
  | { id: string; who: 'work'; work: Work }

export type Scene = {
  state: VoiceSessionState
  /** The session's clock, as the header shows it. */
  time: string
  /** The task the session follows (header), if any. */
  task?: { title: string; state: 'running' | 'needs' | 'done' | 'failed' }
  entries: Entry[]
  /** Words of the turn in progress. */
  partial?: string
  /** What the voice is saying now (speaking). */
  saying?: string
  /** A reply you talked over: it stopped here, and fades back above your words. */
  cut?: string
  problem?: { message: string; detail?: string; fix?: string }
  /** A problem the session survived: a lost turn, or the speaking voice gone (replies stay on screen). */
  trouble?: { message: string; detail?: string; fix?: string }
  /** Esc pressed once: a second press ends the session. */
  escArmed?: boolean
  /** The listener is a fallback for a missing key. */
  fellBackFrom?: string
  reconnectAttempt?: number
  muted?: boolean
}

export type SceneId =
  | 'listening'
  | 'hearing'
  | 'thinking'
  | 'working'
  | 'speaking'
  | 'result'
  | 'needs'
  | 'error'
  | 'muted'
  | 'long'
  | 'connecting'
  | 'reconnecting'
  | 'trouble'
  | 'risky'
  | 'question'
  | 'failed'
  | 'esc'

export const SCENES: { id: SceneId; label: string }[] = [
  { id: 'listening', label: 'Listening' },
  { id: 'hearing', label: 'Hearing' },
  { id: 'thinking', label: 'Thinking' },
  { id: 'working', label: 'Working' },
  { id: 'speaking', label: 'Speaking' },
  { id: 'result', label: 'Result' },
  { id: 'needs', label: 'Needs you' },
  { id: 'error', label: 'Error' },
  { id: 'muted', label: 'Muted' },
  { id: 'long', label: 'Long' },
  { id: 'connecting', label: 'Connecting' },
  { id: 'reconnecting', label: 'Reconnecting' },
  { id: 'trouble', label: 'Trouble' },
  { id: 'risky', label: 'Risky' },
  { id: 'question', label: 'Question' },
  { id: 'failed', label: 'Failed' },
  { id: 'esc', label: 'Esc once' }
]

const TASK = 'Find why the settings test fails on Windows'

const ask1: Entry = { id: 'u1', who: 'you', text: 'The settings test keeps failing on Windows.' }
// Split by a pause in the shipped view as two "You" rows; one turn here.
const ask1b: Entry = { id: 'u1b', who: 'you', text: 'Can you find out why and fix it?' }
const ack1: Entry = { id: 'v1', who: 'voice', text: 'On it. I’ll have it look at the settings test.' }

const steps: Step[] = [
  { id: 's1', tool: 'Searched', summary: 'settings.test.ts', state: 'done' },
  { id: 's2', tool: 'Read', summary: 'tests/main/unit/settings.test.ts', state: 'done' },
  { id: 's3', tool: 'Ran', summary: 'pnpm vitest run tests/main/unit/settings.test.ts', state: 'done' },
  { id: 's4', tool: 'Read', summary: 'src/main/settings/settings.ts', state: 'done' },
  { id: 's5', tool: 'Edited', summary: 'src/main/settings/settings.ts', state: 'done' },
  { id: 's6', tool: 'Running', summary: 'pnpm vitest run tests/main/unit/settings.test.ts', state: 'running' }
]

const BRIEF = 'Find out why tests/main/unit/settings.test.ts fails on Windows, fix the cause, and run the test again.'

const working: Work = { brief: BRIEF, state: 'running', elapsed: '1 min 12 s', steps }

const RESULT =
  'The test built its expected path with a forward slash, and Windows returns a backslash. It now compares with path.join, and the test passes (14 of 14).'

const done: Work = {
  brief: BRIEF,
  state: 'done',
  elapsed: '1 min 40 s',
  steps: steps.map((s) => ({ ...s, tool: s.tool === 'Running' ? 'Ran' : s.tool, state: 'done' as const })),
  result: RESULT
}

const SPOKEN = 'Fixed. The test expected a forward slash and Windows gives a backslash; it uses path.join now, and all 14 pass.'

export function scene(id: SceneId): Scene {
  switch (id) {
    case 'listening':
      return { state: 'listening', time: '0:04', entries: [] }
    case 'hearing':
      return { state: 'hearing', time: '0:09', entries: [ask1], partial: 'Can you find out why and' }
    case 'thinking':
      return { state: 'thinking', time: '0:12', entries: [ask1, ask1b] }
    case 'working':
      return {
        state: 'working',
        time: '1:24',
        task: { title: TASK, state: 'running' },
        entries: [ask1, ask1b, ack1, { id: 'w1', who: 'work', work: working }]
      }
    case 'speaking':
      return {
        state: 'speaking',
        time: '1:53',
        task: { title: TASK, state: 'done' },
        entries: [ask1, ask1b, ack1, { id: 'w1', who: 'work', work: done }, { id: 'v2', who: 'voice', text: SPOKEN }],
        saying: SPOKEN
      }
    case 'result':
      return {
        state: 'listening',
        time: '2:02',
        task: { title: TASK, state: 'done' },
        entries: [ask1, ask1b, ack1, { id: 'w1', who: 'work', work: done }, { id: 'v2', who: 'voice', text: SPOKEN }]
      }
    case 'needs':
      return {
        state: 'waiting_on_you',
        time: '1:31',
        task: { title: TASK, state: 'needs' },
        entries: [
          ask1,
          ask1b,
          ack1,
          {
            id: 'w1',
            who: 'work',
            work: {
              ...working,
              state: 'needs',
              steps: steps.slice(0, 4).concat({ id: 's5', tool: 'Wants to run', summary: 'git stash', state: 'running' }),
              ask: { kind: 'approval', what: 'stash your uncommitted changes', command: 'git stash' }
            }
          },
          { id: 'v2', who: 'voice', text: 'It wants to stash your uncommitted changes. Say yes or no.' }
        ]
      }
    case 'error':
      return {
        state: 'error',
        time: '0:31',
        entries: [ask1],
        problem: {
          message: 'The voice provider says the account is out of credit.',
          detail: 'OpenRouter (402): audio needs at least $0.50 of credit',
          fix: 'Voice settings'
        }
      }
    case 'muted':
      return {
        state: 'paused',
        time: '1:40',
        task: { title: TASK, state: 'running' },
        entries: [ask1, ask1b, ack1, { id: 'w1', who: 'work', work: working }],
        muted: true
      }
    case 'connecting':
      return { state: 'connecting', time: '0:00', entries: [] }
    case 'reconnecting':
      return { state: 'reconnecting', time: '0:48', entries: [ask1, ask1b, ack1], reconnectAttempt: 2, fellBackFrom: 'Deepgram' }
    case 'trouble':
      return {
        state: 'listening',
        time: '0:52',
        entries: [
          ask1,
          ask1b,
          ack1,
          { id: 'w1', who: 'work', work: { ...working, state: 'failed', steps: [], elapsed: '0 s', notSent: 'Not sent: the task wasn’t ready to take it' } },
          { id: 'v2', who: 'voice', text: 'It didn’t go through: the task wasn’t ready. Ask again in a moment.' },
          { id: 'u2', who: 'you', text: 'Hmm.', unanswered: true }
        ],
        trouble: { message: 'The speaking provider is out of credit. Replies are on screen.', detail: 'ElevenLabs (402)', fix: 'Voice settings' }
      }
    case 'risky':
      return {
        state: 'waiting_on_you',
        time: '1:31',
        task: { title: TASK, state: 'needs' },
        entries: [
          ask1,
          ask1b,
          ack1,
          {
            id: 'w1',
            who: 'work',
            work: {
              ...working,
              state: 'needs',
              steps: steps.slice(0, 4).concat({ id: 's5', tool: 'Wants to run', summary: 'rm -rf build', state: 'running' }),
              ask: { kind: 'approval', what: 'delete the build folder', command: 'rm -rf build', risky: true }
            }
          },
          { id: 'v2', who: 'voice', text: 'It wants to delete the build folder, which could be risky. Approve or deny it on screen.' }
        ]
      }
    case 'question':
      return {
        state: 'waiting_on_you',
        time: '1:40',
        task: { title: TASK, state: 'needs' },
        entries: [
          ask1,
          ask1b,
          ack1,
          {
            id: 'w1',
            who: 'work',
            work: { ...working, state: 'needs', steps: steps.slice(0, 5), ask: { kind: 'question', prompt: 'Which branch should it commit to?', options: ['main', 'fix/settings-path'] } }
          },
          { id: 'v2', who: 'voice', text: 'Which branch should it commit to: main, or a new fix branch?' }
        ]
      }
    case 'failed':
      return {
        state: 'listening',
        time: '2:20',
        task: { title: TASK, state: 'failed' },
        entries: [
          ask1,
          ask1b,
          ack1,
          {
            id: 'w1',
            who: 'work',
            work: {
              ...working,
              state: 'failed',
              elapsed: '58 s',
              steps: steps.slice(0, 3).map((s) => ({ ...s, state: s.id === 's3' ? ('failed' as const) : ('done' as const) })),
              result: 'The test runner could not start: vitest is not installed in this worktree (pnpm install was never run).'
            }
          },
          { id: 'v2', who: 'voice', text: 'It stopped: the test runner isn’t installed in that worktree. Want it to run pnpm install first?' }
        ]
      }
    case 'esc':
      return { state: 'listening', time: '3:05', entries: [ask1, ask1b, ack1], escArmed: true }
    case 'long':
      return {
        state: 'listening',
        time: '9:47',
        task: { title: 'Rename the voice settings keys', state: 'done' },
        entries: [
          ask1,
          ask1b,
          ack1,
          { id: 'w1', who: 'work', work: done },
          { id: 'v2', who: 'voice', text: SPOKEN },
          { id: 'u2', who: 'you', text: 'Nice. How long did that take?' },
          { id: 'v3', who: 'voice', text: 'About a minute and forty seconds, six steps.' },
          { id: 'u3', who: 'you', text: 'While you’re there, rename the voice settings keys to match the docs.' },
          { id: 'v4', who: 'voice', text: 'Sure. Starting that now.' },
          {
            id: 'w2',
            who: 'work',
            work: {
              brief: 'Rename the voice settings keys in src/shared/ipc/schemas/voice.ts to the names in docs/voice-mode.md §12, with a settings migration, and update every reader.',
              state: 'done',
              elapsed: '4 min 05 s',
              steps: [
                { id: 'a1', tool: 'Read', summary: 'docs/voice-mode.md', state: 'done' },
                { id: 'a2', tool: 'Searched', summary: 'sttProvider|ttsProvider', state: 'done' },
                { id: 'a3', tool: 'Edited', summary: 'src/shared/ipc/schemas/voice.ts', state: 'done' },
                { id: 'a4', tool: 'Edited', summary: 'src/main/settings/settings.ts', state: 'done' },
                { id: 'a5', tool: 'Edited', summary: '7 more files', state: 'done' },
                { id: 'a6', tool: 'Ran', summary: 'pnpm typecheck', state: 'done' },
                { id: 'a7', tool: 'Ran', summary: 'pnpm vitest run tests/main/unit/voice', state: 'done' }
              ],
              result:
                'Renamed four keys and added settings format 9, which moves old values across once. Typecheck is clean and the voice tests pass (304).'
            }
          },
          { id: 'v5', who: 'voice', text: 'Done. Four keys renamed, with a migration for old settings, and the voice tests pass.' },
          { id: 'u4', who: 'you', text: 'Great, that’s all for now.' },
          { id: 'v6', who: 'voice', text: 'Okay. I’m here if you need me.' }
        ]
      }
  }
}

/**
 * Turns as you'd say them: a pause mid-thought became two "You" rows in the
 * shipped view; consecutive lines from one side read as one.
 */
export function mergeTurns(entries: Entry[]): Entry[] {
  const out: Entry[] = []
  for (const e of entries) {
    const last = out.at(-1)
    if (last && e.who !== 'work' && last.who === e.who) {
      out[out.length - 1] = { ...last, text: `${last.text} ${e.text}` } as Entry
    } else out.push(e)
  }
  return out
}

/** The work the session is on now (the last hand-off), if any. */
export function currentWork(s: Scene): Work | undefined {
  for (let i = s.entries.length - 1; i >= 0; i--) {
    const e = s.entries[i]!
    if (e.who === 'work') return e.work
  }
  return undefined
}
