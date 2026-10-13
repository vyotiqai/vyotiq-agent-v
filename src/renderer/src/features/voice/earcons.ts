/**
 * The voice bar's sounds (docs/voice-mode.md §13.8): a soft rising tone when
 * voice mode starts, falling when it ends, a tick when your turn is
 * accepted, and two low soft notes when a slow step starts with spoken
 * progress off. Synthesised (no asset files), quiet, and under 150 ms.
 */
export type Earcon = 'start' | 'end' | 'turn' | 'work'

const SHAPES: Record<Earcon, Array<{ freq: number; at: number; dur: number }>> = {
  start: [
    { freq: 660, at: 0, dur: 0.07 },
    { freq: 880, at: 0.06, dur: 0.08 }
  ],
  end: [
    { freq: 880, at: 0, dur: 0.07 },
    { freq: 587, at: 0.06, dur: 0.09 }
  ],
  turn: [{ freq: 1046, at: 0, dur: 0.045 }],
  work: [
    { freq: 523, at: 0, dur: 0.05 },
    { freq: 523, at: 0.08, dur: 0.05 }
  ]
}

let ctx: AudioContext | null = null

export function playEarcon(kind: Earcon, enabled: boolean): void {
  if (!enabled || typeof AudioContext === 'undefined') return
  try {
    ctx ??= new AudioContext()
    const c = ctx
    const now = c.currentTime
    for (const tone of SHAPES[kind]) {
      const osc = c.createOscillator()
      const gain = c.createGain()
      osc.type = 'sine'
      osc.frequency.value = tone.freq
      // A quick fade in and out: no clicks, nothing startling.
      gain.gain.setValueAtTime(0, now + tone.at)
      gain.gain.linearRampToValueAtTime(0.06, now + tone.at + 0.01)
      gain.gain.linearRampToValueAtTime(0, now + tone.at + tone.dur)
      osc.connect(gain)
      gain.connect(c.destination)
      osc.start(now + tone.at)
      osc.stop(now + tone.at + tone.dur + 0.02)
    }
  } catch {
    /* sound is a nicety */
  }
}
