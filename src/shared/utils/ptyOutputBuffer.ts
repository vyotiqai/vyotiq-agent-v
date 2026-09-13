/** Soft cap on retained PTY scrollback per session (renderer-side). */
export const PTY_OUTPUT_BUFFER_MAX_CHARS = 200_000

/** Append PTY output for a session, trimming from the front when over maxChars. */
export function appendPtyOutputBuffer(
  buffers: Map<string, string>,
  id: string,
  data: string,
  maxChars = PTY_OUTPUT_BUFFER_MAX_CHARS
): string {
  const prev = buffers.get(id) ?? ''
  let next = prev + data
  if (next.length > maxChars) {
    next = next.slice(next.length - maxChars)
  }
  buffers.set(id, next)
  return next
}

/** Drop buffers for sessions that no longer exist. */
export function prunePtyOutputBuffers(
  buffers: Map<string, string>,
  liveIds: Iterable<string>
): void {
  const keep = new Set(liveIds)
  for (const id of [...buffers.keys()]) {
    if (!keep.has(id)) buffers.delete(id)
  }
}
