/**
 * The transcript's own voice for the phases that have no verb of their own.
 *
 * Tool rows already say what they are doing ("Grepping pattern", "Editing
 * foo.ts"). The gaps between them — the loop iterating, the model reasoning,
 * the answer being drafted — collapsed into one flat word that sat there for
 * minutes, which reads as a stalled run rather than a working one.
 *
 * Three rules keep this from turning into noise:
 *
 *  - Only *live* phases get a voice. Gates the user has to answer, failures,
 *    terminal outcomes, and housekeeping (compaction) stay literal — a clever
 *    word there hides what the user has to do, or how the turn ended.
 *  - A phase opens on the plain word and takes on character only as it holds,
 *    so a phrase doubles as a duration cue beside the elapsed clock and a
 *    one-beat phase never reads as a flourish.
 *  - The phrase is display-only. Announcements keep `formatRunActivityLabel`,
 *    so a word that rotates on a timer never re-announces the same phase.
 *
 * The phrase is a pure function of how long the phase has held, so a row
 * renders the same word on every re-render — which matters, because the
 * transcript re-renders on every streamed token. Callers own the anchor, and
 * measure from the moment the phase began rather than from the turn's start:
 * a phase entered ten seconds in must still open on its plain word. A row that
 * unmounts and remounts (virtualization) loses its anchor and restarts at the
 * plain word, which is the honest answer — it no longer knows when the phase
 * began. Only one turn is live at a time, so there is nothing to tell apart
 * and no reason to randomize: walking the pool in order is the whole
 * mechanism.
 */

export type VoicePhase = 'working' | 'thinking' | 'planning' | 'writing'

/**
 * Each pool leads with the plain word. Keep entries to a few words: they share
 * a truncating row with the elapsed time and the token receipt.
 *
 * `thinking` is deliberately the deepest pool. Measured over ~300 thinking
 * phases in 12 stored run logs, a thought holds the row for a median of 38s,
 * 72s at p75 and 114s at p90 — so a five-word pool visibly restarted two to
 * four times inside a single thought. Ten words is a minute of rotation
 * before anything repeats, which carries 70% of thoughts to the end without
 * one. The other phases are short-lived by comparison and do not need the
 * depth.
 */
export const RUN_VOICE_PHRASES: Record<VoicePhase, readonly string[]> = {
  working: ['Working', 'Heads down', 'Chipping away', 'Making headway', 'Back at it'],
  thinking: [
    'Thinking',
    'Turning it over',
    'Weighing options',
    'Chasing the thread',
    'Tracing the logic',
    'Narrowing it down',
    'Piecing it together',
    'Ruling things out',
    'Checking the edges',
    'Sizing up the risk'
  ],
  planning: ['Planning', 'Sketching the order', 'Laying out steps', 'Mapping the route'],
  writing: ['Writing', 'Drafting the answer', 'Putting it in words', 'Writing it up']
}

/** Slow enough to read in full, quick enough that a long phase stays alive. */
export const RUN_VOICE_ROTATE_MS = 6_000

/** Which rotation slot an elapsed duration falls in; 0 until the first passes. */
export function runVoiceTick(elapsedMs: number | null | undefined): number {
  if (elapsedMs == null || !Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0
  return Math.floor(elapsedMs / RUN_VOICE_ROTATE_MS)
}

/** The phrase for a phase that has been on screen for `tick` rotations. */
export function runVoicePhrase(phase: VoicePhase, tick = 0): string {
  const pool = RUN_VOICE_PHRASES[phase]
  const step = Number.isFinite(tick) ? Math.max(0, Math.trunc(tick)) : 0
  return pool[step % pool.length]!
}
