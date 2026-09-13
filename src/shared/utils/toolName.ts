/**
 * Merge one streamed tool-name fragment into the accumulated name.
 *
 * Hosts disagree on name streaming: some re-send the full name on every delta
 * (id-echoing gateways that also carry `fn.name` per chunk), some send true
 * fragments (`get_` + `weather`). Two symmetric failure modes must be avoided:
 *  - clobber: replacing the accumulated name with each fragment yields the LAST
 *    fragment (`_weather`) instead of the full name;
 *  - glue: appending full-name re-sends yields `get_weatherget_weather`.
 *
 * Rule: a strict prefix-extension replaces; a re-send of what we already hold
 * is ignored; anything else is appended (true fragments).
 */
export function mergeStreamedToolName(existing: string, incoming: string | undefined): string {
  if (!incoming) return existing
  if (!existing) return incoming
  if (incoming === existing) return existing
  if (incoming.startsWith(existing) && incoming.length > existing.length) return incoming
  if (existing.startsWith(incoming)) return existing
  return existing + incoming
}
