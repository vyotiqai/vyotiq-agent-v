/**
 * Merge one streamed tool-arg chunk into accumulated args.
 * Hosts may re-send growing full JSON (suffix-only yield), complete-so-far
 * snapshots (path-only object, then path+contents), or true fragments.
 * The renderer applies `mergeOpenAiCompatToolArgDelta(...).arguments` — it does
 * not concatenate `yieldDelta` blindly. `yieldDelta` must be non-empty when
 * `arguments` changed so IPC actually delivers the paint.
 */

/**
 * Cheap structural pre-filter for `isCompleteJson`.
 *
 * A complete JSON value can only end in `}`, `]`, `"`, a digit, or the last
 * letter of a bare literal (`true`/`false` → `e`, `null` → `l`). Rejecting
 * everything else without touching `JSON.parse` matters because `isCompleteJson`
 * runs on the *accumulated* argument buffer on every streamed chunk: for a
 * large `write`/`edit` that was a throwing full parse of a multi-hundred-KB
 * string per chunk, i.e. quadratic in argument size, on the main thread.
 */
function endsLikeCompleteJson(text: string): boolean {
  for (let i = text.length - 1; i >= 0; i--) {
    const ch = text[i]!
    if (ch > ' ') {
      return (
        ch === '}' ||
        ch === ']' ||
        ch === '"' ||
        (ch >= '0' && ch <= '9') ||
        ch === 'e' ||
        ch === 'l'
      )
    }
  }
  return false
}

function isCompleteJson(text: string): boolean {
  if (!endsLikeCompleteJson(text)) return false
  try {
    JSON.parse(text)
    return true
  } catch {
    return false
  }
}

/** Matches the character set of JS `\s` without allocating. */
function isWhitespaceCode(code: number): boolean {
  return (
    code === 0x20 ||
    (code >= 0x09 && code <= 0x0d) ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  )
}

function nextNonWhitespace(text: string, from: number): number {
  let i = from
  while (i < text.length && isWhitespaceCode(text.charCodeAt(i))) i++
  return i
}

/** Allocation-free equivalent of `withoutWhitespace(a) === withoutWhitespace(b)`. */
function equalsIgnoringWhitespace(a: string, b: string): boolean {
  let i = 0
  let j = 0
  for (;;) {
    i = nextNonWhitespace(a, i)
    j = nextNonWhitespace(b, j)
    if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length
    if (a[i] !== b[j]) return false
    i++
    j++
  }
}

/** Allocation-free equivalent of `withoutWhitespace(t).startsWith(withoutWhitespace(p))`. */
function startsWithIgnoringWhitespace(text: string, prefix: string): boolean {
  let i = 0
  let j = 0
  for (;;) {
    i = nextNonWhitespace(text, i)
    j = nextNonWhitespace(prefix, j)
    if (j >= prefix.length) return true
    if (i >= text.length) return false
    if (text[i] !== prefix[j]) return false
    i++
    j++
  }
}

/** End index (exclusive) of the JSON value starting at `start`, or -1 if open. */
function endOfJsonValue(text: string, start: number): number {
  const open = text[start]
  if (open !== '{' && open !== '[') return -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
      if (depth < 0) return -1
    }
  }
  return -1
}

/**
 * Last complete JSON value in `text`. IPC/rAF batching concatenates consecutive
 * `argumentsDelta` strings; when each was a complete snapshot, take the latest.
 */
function lastCompleteJsonValue(text: string): string | null {
  let last: string | null = null
  let i = 0
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (i >= text.length) break
    const ch = text[i]
    if (ch !== '{' && ch !== '[') break
    const end = endOfJsonValue(text, i)
    if (end < 0) break
    last = text.slice(i, end)
    i = end
  }
  return last
}

export function mergeOpenAiCompatToolArgDelta(
  existing: string,
  incoming: string | undefined
): { arguments: string; yieldDelta: string } {
  if (!incoming) return { arguments: existing, yieldDelta: '' }

  if (!existing) {
    const last = lastCompleteJsonValue(incoming)
    return last && last !== incoming
      ? { arguments: last, yieldDelta: last }
      : { arguments: incoming, yieldDelta: incoming }
  }

  if (incoming.startsWith(existing)) {
    const rest = incoming.slice(existing.length)
    // IPC/rAF concatenates consecutive complete snapshots (`{path}` + `{path,contents}`).
    // That string still `startsWith(existing)` — do not keep the glued payload.
    if (isCompleteJson(existing) && /^\s*[{[]/.test(rest)) {
      const last = lastCompleteJsonValue(incoming)
      if (last && last !== existing) {
        return { arguments: last, yieldDelta: last }
      }
    }
    return {
      arguments: incoming,
      yieldDelta: rest
    }
  }

  const incomingJson = lastCompleteJsonValue(incoming)
  if (incomingJson) {
    if (equalsIgnoringWhitespace(incomingJson, existing)) {
      return { arguments: incomingJson, yieldDelta: '' }
    }
    if (incomingJson.startsWith(existing)) {
      return {
        arguments: incomingJson,
        yieldDelta: incomingJson.slice(existing.length)
      }
    }
    // Complete snapshot that is not a string prefix of `existing`:
    // path-only JSON then path+contents (object hosts / JSON.stringify of a
    // growing parsed object). Suppressing yieldDelta here froze the edit card
    // on "Editing file…" until assistant_message dumped the full args.
    // A fragment that opens a nested array (`{"questions": ` + `[…]`) is
    // incomplete `existing` and must fall through to append.
    if (
      isCompleteJson(existing) ||
      startsWithIgnoringWhitespace(incomingJson, existing)
    ) {
      return { arguments: incomingJson, yieldDelta: incomingJson }
    }
  }

  if (incoming.length >= existing.length) {
    const root = incoming.trimStart()[0]
    // A re-send repeats what we already hold (whitespace may differ). A
    // fragment that merely opens a nested object or array must append:
    // replacing it drops the parent prefix and turns `{"questions": ` + `[…]`
    // + `}` into the unparseable `[…]}`.
    if (
      (root === '{' || root === '[') &&
      startsWithIgnoringWhitespace(incoming, existing)
    ) {
      return { arguments: incoming, yieldDelta: incoming === existing ? '' : incoming }
    }
  }

  return { arguments: existing + incoming, yieldDelta: incoming }
}
