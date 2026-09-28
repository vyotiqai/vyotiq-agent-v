/**
 * Put dictated words into a draft at the caret, with exactly one space on
 * each side where the neighbours need one.
 */
export function insertTranscriptAtCaret(
  prev: string,
  transcript: string,
  caret: number
): { text: string; caret: number; start: number } {
  const t = transcript.trim()
  const clamped = Math.max(0, Math.min(caret, prev.length))
  if (!t) return { text: prev, caret: clamped, start: clamped }
  const before = prev.slice(0, clamped)
  const after = prev.slice(clamped)
  const left = before.length > 0 && !/\s$/.test(before) ? ' ' : ''
  const right = after.length > 0 && !/^\s/.test(after) ? ' ' : ''
  const start = before.length + left.length
  return {
    text: `${before}${left}${t}${right}${after}`,
    caret: start + t.length,
    start
  }
}

export function countWords(text: string): number {
  const t = text.trim()
  return t ? t.split(/\s+/).length : 0
}
