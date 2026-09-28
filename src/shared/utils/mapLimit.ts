/**
 * `items.map(fn)` with at most `limit` calls in flight; results keep input
 * order. For per-file work on the main process: enough at once to keep the
 * disk busy, few enough that a thousand files do not queue ahead of every
 * other read in the thread pool. The first rejection rejects the whole map
 * and no further calls start.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let next = 0
  let failed = false
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i]!, i)
      } catch (err) {
        failed = true
        throw err
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, worker))
  return out
}
