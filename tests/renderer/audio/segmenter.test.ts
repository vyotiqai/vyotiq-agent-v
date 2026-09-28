import { describe, expect, it } from 'vitest'
import { FRAME_SAMPLES, Segmenter, levelFromRms, rmsOfInt16 } from '@renderer/lib/audio/segmenter'

const LOUD = 0.2
const QUIET = 0

/** Feed `ms` of frames at one loudness; returns every cut made. */
function feed(seg: Segmenter, at: { sample: number }, ms: number, rms: number): Array<{ at: number; closedVoicedMs: number }> {
  const cuts: Array<{ at: number; closedVoicedMs: number }> = []
  for (let t = 0; t < ms; t += 20) {
    at.sample += FRAME_SAMPLES
    const res = seg.frame(rms, at.sample)
    if (res.cut) cuts.push(res.cut)
  }
  return cuts
}

describe('Segmenter', () => {
  it('cuts after a pause once the segment has speech and is long enough', () => {
    const seg = new Segmenter()
    const at = { sample: 0 }
    expect(feed(seg, at, 1500, LOUD)).toEqual([])
    const cuts = feed(seg, at, 800, QUIET)
    expect(cuts).toHaveLength(1)
    // 1.5 s of speech then the 600 ms pause that closed it.
    expect(cuts[0]!.at).toBe(((1500 + 600) / 20) * FRAME_SAMPLES)
    expect(cuts[0]!.closedVoicedMs).toBe(1500)
    expect(seg.openStart).toBe(cuts[0]!.at)
  })

  it('does not cut a short burst, however long the pause after it', () => {
    const seg = new Segmenter()
    const at = { sample: 0 }
    feed(seg, at, 300, LOUD)
    // 300 ms + 600 ms pause is under the 1.2 s minimum; the cut waits for length.
    const cuts = feed(seg, at, 600, QUIET)
    expect(cuts).toEqual([])
    const later = feed(seg, at, 400, QUIET)
    expect(later).toHaveLength(1)
    expect(later[0]!.closedVoicedMs).toBe(300)
  })

  it('never cuts silence into speech segments', () => {
    const seg = new Segmenter()
    const at = { sample: 0 }
    expect(feed(seg, at, 5000, QUIET)).toEqual([])
    expect(seg.openVoicedMs).toBe(0)
  })

  it('cuts a segment that runs past the maximum at its quietest recent frame', () => {
    const seg = new Segmenter()
    const at = { sample: 0 }
    feed(seg, at, 11000, LOUD)
    // One quieter frame (still speech) inside the look-back window.
    at.sample += FRAME_SAMPLES
    seg.frame(0.05, at.sample)
    const dip = at.sample
    const cuts = feed(seg, at, 1500, LOUD)
    expect(cuts).toHaveLength(1)
    expect(cuts[0]!.at).toBe(dip)
    // The frames after the dip were carried into the next segment.
    expect(seg.openVoicedMs).toBeGreaterThan(0)
  })

  it('close() hands back what was open', () => {
    const seg = new Segmenter()
    const at = { sample: 0 }
    feed(seg, at, 700, LOUD)
    expect(seg.close(at.sample)).toEqual({ from: 0, voicedMs: 700 })
    expect(seg.openVoicedMs).toBe(0)
  })
})

describe('loudness helpers', () => {
  it('rmsOfInt16 of a full-scale square wave is ~1 and of silence is 0', () => {
    const square = new Int16Array(320).map((_, i) => (i % 2 ? 32767 : -32768))
    expect(rmsOfInt16(square)).toBeCloseTo(1, 3)
    expect(rmsOfInt16(new Int16Array(320))).toBe(0)
  })

  it('levelFromRms maps -55..-10 dBFS onto 0..1', () => {
    expect(levelFromRms(0)).toBe(0)
    expect(levelFromRms(1)).toBe(1)
    const mid = levelFromRms(10 ** (-32.5 / 20))
    expect(mid).toBeCloseTo(0.5, 2)
  })
})
