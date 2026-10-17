import type { VoiceSettings, VoiceWork } from '@shared/ipc/schemas/voice'
import type { VoiceSessionState } from '@shared/voiceSession'
import { CURRENT_WORK_BRIEF, type VoiceLine, type VoiceSnapshot } from '../voiceSessionController'
import { buildEntries, currentWork, elapsed, stepVerb, type Entry } from '../view/parts'

/*
  How the redesigned voice view reads a session (docs/voice-mode.md §26):
  the current exchange as captions, everything before it in the history
  drawer, and the task's work as one strip. Pure, so every placement (and
  the mini window, from a mirrored snapshot) reads it the same way.
*/

export type WorkEntry = Extract<Entry, { who: 'work' }>

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

/** Muted until called by name (voice_mute, §24.15): what the headline and its line say. */
export const STANDBY_HEADLINE = 'Standing by'
export const STANDBY_HINT = 'Say “Agent V” to talk'

/** The headline, standby included. */
export function headline(v: Pick<VoiceSnapshot, 'state' | 'standby'>): string {
  return v.standby && (v.state === 'listening' || v.state === 'hearing') ? STANDBY_HEADLINE : HEADLINE[v.state]
}

/** The newest hand-off, work and all; every hand-off, captions or not (it's the task's, not speech). */
export function latestWork(v: Pick<VoiceSnapshot, 'transcript' | 'works'>): WorkEntry | undefined {
  return currentWork(buildEntries(v.transcript, v.works))
}

/**
 * One line under the headline that never repeats what the strip shows: not
 * the brief, not the step, not the question.
 */
export function hint(v: VoiceSnapshot, settings: Pick<VoiceSettings, 'pushToTalkOnly'>, entry: WorkEntry | undefined, now: number): string {
  const work = entry && !entry.continued && !entry.failed ? entry.work : undefined
  switch (v.state) {
    case 'connecting':
      return 'Opening the microphone'
    case 'reconnecting':
      // The headline already says Reconnecting: here, how many tries and that nothing is lost.
      return `Try ${Math.max(1, v.reconnectAttempt)} · what you say is kept`
    case 'listening':
      if (v.standby) return STANDBY_HINT
      if (settings.pushToTalkOnly) return 'Hold Space to talk'
      return v.transcript.length === 0 ? 'Say what you want done, or ask about the work' : 'Talk any time'
    case 'hearing':
      return v.standby ? STANDBY_HINT : 'Pause when you’re done'
    case 'thinking':
      return 'Working out an answer'
    case 'working':
      if (!work) return 'Working on it'
      if (work.state !== 'running') return 'It keeps going while you talk'
      return work.stepCount === 0 ? 'Getting started' : `${work.stepCount} step${work.stepCount === 1 ? '' : 's'} · ${elapsed(work, now)}`
    case 'speaking':
      return 'Talk to interrupt'
    case 'waiting_on_you': {
      const ask = work?.state === 'needs' ? work.ask : undefined
      if (ask?.kind === 'approval') return ask.risky ? "It can't easily be undone. Say yes or no, or use the buttons" : `Say yes${ask.always ? ', no, or always allow' : ' or no'}, or use the buttons`
      if (ask?.kind === 'question') return ask.options.length > 0 ? 'Say your answer, or pick one' : 'Say your answer, or answer it on the task'
      return 'It needs an answer: say it, or use the card on screen'
    }
    case 'paused':
      return work?.state === 'running' || work?.state === 'needs' ? 'The task keeps working · M to talk' : 'Press M to talk'
    default:
      return ''
  }
}

/** The current exchange: your newest turn and the newest reply to it; `live` is the side being said right now. */
export type Exchange = { you: string; voice: string; voiceLineId: string | null; live: 'you' | 'voice' | null; unanswered: boolean }

/**
 * Your newest words (as you say them, or your last turn) and its newest
 * reply after them. Only the newest reply: "On it." and the result a minute
 * later are two moments, not one paragraph.
 */
export function exchange(v: Pick<VoiceSnapshot, 'state' | 'partial' | 'transcript' | 'cutLineId'>): Exchange {
  const lines = v.transcript
  if (v.state === 'hearing' && v.partial) {
    return { you: v.partial, voice: '', voiceLineId: null, live: 'you', unanswered: false }
  }
  let lastYou = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i]!.who === 'you') {
      lastYou = i
      break
    }
  }
  // Your turn, split by a pause, reads as one.
  let start = lastYou
  while (start > 0 && lines[start - 1]!.who === 'you' && Boolean(lines[start - 1]!.unanswered) === Boolean(lines[lastYou]?.unanswered)) start--
  const you = lastYou >= 0 ? lines.slice(start, lastYou + 1).map((l) => l.text).join(' ') : ''
  let reply: VoiceLine | undefined
  for (let i = lines.length - 1; i > lastYou; i--) {
    if (lines[i]!.who === 'voice') {
      reply = lines[i]
      break
    }
  }
  const speaking = v.state === 'speaking' && reply !== undefined && reply.id !== v.cutLineId
  return {
    you,
    voice: reply?.text ?? '',
    voiceLineId: reply?.id ?? null,
    live: speaking ? 'voice' : null,
    unanswered: lastYou >= 0 && Boolean(lines[lastYou]!.unanswered) && !reply
  }
}

/** The running step, verb first: "Running pnpm test". */
export function stepLine(work: VoiceWork): string | null {
  const step = work.steps.at(-1)
  if (!step || step.state !== 'running') return null
  return step.summary ? `${stepVerb(step)} ${step.summary}` : stepVerb(step)
}

// ── After End ─────────────────────────────────────────────────────────────

export type SummaryTask = {
  runId: string
  brief: string
  state: VoiceWork['state']
  /** The result's first line, the running step, or how it ended. */
  outcome: string
  /** "1 min 40 s"; "still going" for a run that hadn't ended. */
  time: string
}

/** The result's first sentence-ish line, plain (no markdown marks), short enough for one row. */
function firstLine(text: string): string {
  const line =
    text
      .split('\n')
      .map((l) => l.replace(/^[#>*\-\s`]+/, '').replace(/[*_`]/g, '').trim())
      .find(Boolean) ?? ''
  return line.length > 180 ? `${line.slice(0, 177).trimEnd()}…` : line
}

/**
 * The summary End leaves (§26.7): one row per run the session handed work
 * to, newest last, with how it ended. A run that hadn't ended "still goes in
 * its task": its steps froze when the session stopped following it.
 */
export function summaryTasks(transcript: readonly VoiceLine[], works: VoiceSnapshot['works'], endedAt: number): SummaryTask[] {
  const out: SummaryTask[] = []
  const seen = new Set<string>()
  for (const l of transcript) {
    if (l.who !== 'agent' || !l.runId || seen.has(l.runId)) continue
    seen.add(l.runId)
    const work = works[l.runId]
    if (!work) continue
    const ended = work.state !== 'running' && work.state !== 'needs'
    const outcome = ended
      ? work.result
        ? firstLine(work.result)
        : work.state === 'done'
          ? 'Done.'
          : work.state === 'failed'
            ? 'Stopped by an error.'
            : 'Stopped.'
      : work.state === 'needs'
        ? 'It was waiting for an answer: it still is, in its task.'
        : 'Still going in its task.'
    out.push({
      runId: l.runId,
      // A run that was already working when voice mode opened has no brief of its own.
      brief: l.text === CURRENT_WORK_BRIEF ? 'Its current work' : l.text,
      state: work.state,
      outcome,
      time: ended ? elapsed(work, endedAt) : 'still going'
    })
  }
  return out
}

/** "2 tasks done · 1 still going", or what happened when no work started. */
export function summaryTitle(tasks: readonly SummaryTask[]): string {
  if (tasks.length === 0) return 'No work started'
  const done = tasks.filter((t) => t.state === 'done').length
  const going = tasks.filter((t) => t.state === 'running' || t.state === 'needs').length
  const stopped = tasks.length - done - going
  return [
    done ? `${done} task${done === 1 ? '' : 's'} done` : null,
    going ? `${going} still going` : null,
    stopped ? `${stopped} stopped` : null
  ]
    .filter(Boolean)
    .join(' · ')
}
