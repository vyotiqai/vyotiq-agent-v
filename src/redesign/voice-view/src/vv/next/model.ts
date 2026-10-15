import type { VoiceSessionState } from '@shared/voiceSession'
import { currentWork, mergeTurns, type Entry, type Scene, type Work } from '../data'

/*
  The redesign's reading of a scene (2026-10-15 picks, memory
  voice-full-redesign-decisions): the current exchange as live captions,
  everything before it in a history drawer, and the task's work as one strip.
*/

export type Placement = 'inline' | 'companion' | 'conversation' | 'orb' | 'split' | 'capsule' | 'capsule-open' | 'mini' | 'mini-open' | 'summary'
export type VoiceStyle = 'ambient' | 'quiet'
export type Pop = 'none' | 'voice' | 'devices' | 'history' | 'layout'

/** What's happening, in a word or two. */
export const HEADLINE: Readonly<Record<VoiceSessionState, string>> = {
  off: 'Off',
  connecting: 'Connecting',
  listening: 'Listening',
  hearing: 'Listening',
  thinking: 'Thinking',
  working: 'Working on it',
  speaking: 'Speaking',
  waiting_on_you: 'Needs you',
  paused: 'Muted',
  reconnecting: 'Reconnecting',
  error: 'Stopped'
}

/** One line under the headline: never the brief, step or question the strip already shows. */
export function hint(s: Scene): string {
  const work = currentWork(s)
  switch (s.state) {
    case 'connecting':
      return 'Opening the microphone'
    case 'reconnecting':
      // The headline already says Reconnecting: here, how many tries and that nothing is lost.
      return `Try ${s.reconnectAttempt ?? 1} · what you say is kept`
    case 'listening':
      return s.entries.length === 0 ? 'Say what you want done, or ask about the work' : 'Talk any time'
    case 'hearing':
      return 'Pause when you’re done'
    case 'thinking':
      return 'Working out an answer'
    case 'working':
      return work ? `${work.steps.length} steps · ${work.elapsed}` : 'Getting started'
    case 'speaking':
      return 'Talk to interrupt'
    case 'waiting_on_you': {
      const ask = work?.ask
      if (ask?.kind === 'approval') return ask.risky ? 'It could be risky: answer it on the task' : `Say yes${ask.always ? ', no, or always allow' : ' or no'}, or use the buttons`
      return ask?.options.length ? 'Say your answer, or pick one' : 'Say your answer, or answer it on the task'
    }
    case 'paused':
      return work?.state === 'running' ? 'The task keeps working · M to talk' : 'Press M to talk'
    case 'error':
      return s.problem?.message ?? 'Something went wrong'
    default:
      return ''
  }
}

/** The current exchange: your last turn and what came back to it. */
export function exchange(s: Scene): { you: string; voice: string; live: 'you' | 'voice' | null } {
  const turns = mergeTurns(s.entries).filter((e): e is Extract<Entry, { who: 'you' | 'voice' }> => e.who !== 'work')
  if (s.partial) return { you: s.partial, voice: '', live: 'you' }
  if (s.state === 'speaking' && s.saying) {
    const you = [...turns].reverse().find((e) => e.who === 'you')?.text ?? ''
    return { you, voice: s.saying, live: 'voice' }
  }
  const lastYou = turns.map((e) => e.who).lastIndexOf('you')
  if (lastYou < 0) return { you: '', voice: '', live: null }
  // Its newest reply only: "On it." and the result a minute later are two moments, not one paragraph.
  const voice = [...turns.slice(lastYou + 1)].reverse().find((e) => e.who === 'voice')?.text ?? ''
  return { you: turns[lastYou]!.text, voice, live: null }
}

/** Everything before the current exchange, for the drawer, as merged turns. */
export function history(s: Scene): Entry[] {
  return mergeTurns(s.entries)
}

export function work(s: Scene): Work | undefined {
  return currentWork(s)
}

export const VOICES = [
  { id: 'bella', label: 'Bella', note: 'Warm, clear' },
  { id: 'adam', label: 'Adam', note: 'Low, calm' },
  { id: 'nova', label: 'Nova', note: 'Bright, quick' },
  { id: 'onyx', label: 'Onyx', note: 'Deep, even' }
] as const

export const SPEEDS = ['0.9', '1.0', '1.2', '1.5'] as const

/** The speaking provider in the samples, and the speeds it takes (ElevenLabs: 0.7–1.2×). */
export const SPEAKS_WITH = 'ElevenLabs'
export const SPEED_RANGE: readonly [number, number] = [0.7, 1.2]

export const MICS = ['Desk mic (Yeti Nano)', 'Headset (WH-1000XM5)', 'Laptop microphone array'] as const
export const OUTPUTS = ['Headset (WH-1000XM5)', 'Speakers (Realtek)', 'Monitor (DELL U2723QE)'] as const

/** What End shows: what you asked, what got done, where. */
type SummaryTask = { title: string; state: 'done' | 'running' | 'failed'; elapsed: string; outcome: string }

export const SUMMARY: { length: string; tasks: SummaryTask[] } = {
  length: '9 min 47 s',
  tasks: [
    {
      title: 'Find why the settings test fails on Windows',
      state: 'done' as const,
      elapsed: '1 min 40 s',
      outcome: 'Compares paths with path.join now; 14 of 14 pass.'
    },
    {
      title: 'Rename the voice settings keys',
      state: 'done' as const,
      elapsed: '4 min 05 s',
      outcome: 'Four keys renamed, settings format 9 migrates old values.'
    },
    {
      title: 'Audit the release notes',
      state: 'running' as const,
      elapsed: '2 min 10 s',
      outcome: 'Reading CHANGELOG.md against the 1.3.0 commits.'
    }
  ]
}
