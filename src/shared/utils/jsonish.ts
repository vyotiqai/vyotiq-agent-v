/**
 * First complete JSON value in `text` when trailing junk follows it, else null.
 * Recovers payloads a host closed twice (`[…]}`) instead of discarding them.
 */
export function completeJsonPrefix(text: string): string | null {
  const first = text[0]
  if (first !== '{' && first !== '[') return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
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
    if (ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch !== '}' && ch !== ']') continue
    depth--
    if (depth < 0) return null
    if (depth === 0) {
      return i + 1 < text.length ? text.slice(0, i + 1) : null
    }
  }
  return null
}

function endsAfterCompleteValue(text: string): boolean {
  let i = text.length - 1
  while (i >= 0 && /\s/.test(text[i]!)) i--
  if (i < 0) return false
  const ch = text[i]!
  if (ch === '}' || ch === ']' || ch === '"') return true
  if (/[0-9]/.test(ch)) return true
  const slice = text.slice(Math.max(0, i - 4), i + 1)
  return /(?:^|[^a-zA-Z])(?:true|false|null)$/.test(slice)
}

/**
 * Append missing `]` / `}` when containers are still open and the walk ended
 * after a complete value (not inside a string, not after `:` / `,`).
 */
export function closeUnterminatedJson(text: string): string | null {
  const first = text[0]
  if (first !== '{' && first !== '[') return null

  const stack: Array<'{' | '['> = []
  let inString = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
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
    if (ch === '{' || ch === '[') {
      stack.push(ch)
      continue
    }
    if (ch !== '}' && ch !== ']') continue
    const open = stack.pop()
    if (!open) return null
    if ((ch === '}' && open !== '{') || (ch === ']' && open !== '[')) return null
  }

  if (inString || stack.length === 0) return null
  if (!endsAfterCompleteValue(text)) return null

  let closed = text
  for (let i = stack.length - 1; i >= 0; i--) {
    closed += stack[i] === '{' ? '}' : ']'
  }
  return closed
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return undefined
  }
}

function parseJsonValue(text: string): unknown | undefined {
  const direct = tryParseJson(text)
  if (direct !== undefined) return direct
  const prefix = completeJsonPrefix(text)
  if (prefix) {
    const parsed = tryParseJson(prefix)
    if (parsed !== undefined) return parsed
  }
  const closed = closeUnterminatedJson(text)
  return closed ? tryParseJson(closed) : undefined
}

/**
 * Nested tool-arg JSON that models stringify, double-encode, or close one
 * bracket short. Truncation inside a string is never salvaged.
 */
export function parseJsonish(text: string): unknown | undefined {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  const parsed = parseJsonValue(trimmed)
  if (typeof parsed === 'string') {
    const inner = parsed.trim()
    if (inner.startsWith('{') || inner.startsWith('[')) {
      const again = parseJsonValue(inner)
      if (again !== undefined) return again
    }
  }
  return parsed
}

function skipJsonWs(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i]!)) i++
  return i
}

function parseJsonStringToken(
  text: string,
  start: number
): { value: string; end: number } | null {
  if (text[start] !== '"') return null
  let escaped = false
  for (let i = start + 1; i < text.length; i++) {
    const ch = text[i]!
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      escaped = true
      continue
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(text.slice(start, i + 1)) as string, end: i + 1 }
      } catch {
        return null
      }
    }
  }
  return null
}

function skipJsonContainer(text: string, start: number): number {
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
    if (ch === '{' || ch === '[') {
      depth++
      continue
    }
    if (ch !== '}' && ch !== ']') continue
    depth--
    if (depth === 0) return i + 1
  }
  return -1
}

function skipJsonValue(text: string, i: number): number {
  i = skipJsonWs(text, i)
  if (i >= text.length) return -1
  const ch = text[i]!
  if (ch === '"') {
    const token = parseJsonStringToken(text, i)
    return token ? token.end : -1
  }
  if (ch === '{' || ch === '[') return skipJsonContainer(text, i)
  if (ch === 't' && text.startsWith('true', i)) return i + 4
  if (ch === 'f' && text.startsWith('false', i)) return i + 5
  if (ch === 'n' && text.startsWith('null', i)) return i + 4
  if (ch === '-' || (ch >= '0' && ch <= '9')) {
    let j = i + 1
    while (j < text.length && /[0-9.eE+-]/.test(text[j]!)) j++
    return j
  }
  return -1
}

function displayJsonValue(raw: string): string {
  const trimmed = raw.trim()
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === 'string') return parsed
  } catch {
    // keep the raw slice
  }
  return trimmed
}

/**
 * Top-level duplicate keys in a JSON object. `JSON.parse` keeps only the last
 * value, so `{"path":"a","path":"b"}` silently drops `a`.
 */
export function topLevelDuplicateJsonKeys(
  raw: string
): Array<{ key: string; values: string[] }> {
  const text = raw.trim()
  if (!text.startsWith('{')) return []

  const byKey = new Map<string, string[]>()
  let i = skipJsonWs(text, 1)
  while (i < text.length) {
    i = skipJsonWs(text, i)
    if (i >= text.length || text[i] === '}') break
    const keyTok = parseJsonStringToken(text, i)
    if (!keyTok) return []
    i = skipJsonWs(text, keyTok.end)
    if (text[i] !== ':') return []
    i++
    const valueStart = skipJsonWs(text, i)
    const valueEnd = skipJsonValue(text, valueStart)
    if (valueEnd < 0) return []
    const list = byKey.get(keyTok.value) ?? []
    list.push(displayJsonValue(text.slice(valueStart, valueEnd)))
    byKey.set(keyTok.value, list)
    i = skipJsonWs(text, valueEnd)
    if (text[i] === ',') {
      i++
      continue
    }
    break
  }

  const dupes: Array<{ key: string; values: string[] }> = []
  for (const [key, values] of byKey) {
    if (values.length > 1) dupes.push({ key, values })
  }
  return dupes
}

/** Error when tool-arg JSON repeats a top-level key. Null when keys are unique. */
export function duplicateTopLevelJsonKeyError(raw: string): string | null {
  const dupes = topLevelDuplicateJsonKeys(raw)
  if (dupes.length === 0) return null
  const first = dupes[0]!
  const listed = first.values.map((value) => JSON.stringify(value)).join(' and ')
  const once =
    first.key === 'path'
      ? 'Call the tool once per file.'
      : `Call the tool once per ${first.key}.`
  return `Duplicate JSON key "${first.key}" (${listed}). JSON keeps only the last value. ${once}`
}
