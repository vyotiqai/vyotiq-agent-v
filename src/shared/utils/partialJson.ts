/**
 * Extract JSON string field values from incomplete (streaming) JSON text.
 * Full JSON.parse is preferred when the blob is complete; these helpers cover
 * the common tool-call args shape while the closing braces are still in flight.
 */

/** Decode a JSON string body starting at `start` (first char after opening `"`). */
export function decodeJsonStringPrefix(
  source: string,
  start: number
): { value: string; complete: boolean; endIndex: number } {
  let value = ''
  let i = start
  while (i < source.length) {
    const ch = source[i]!
    if (ch === '"') {
      return { value, complete: true, endIndex: i + 1 }
    }
    if (ch === '\\') {
      if (i + 1 >= source.length) {
        // Trailing backslash mid-stream — wait for the next delta.
        return { value, complete: false, endIndex: source.length }
      }
      const next = source[i + 1]!
      switch (next) {
        case '"':
        case '\\':
        case '/':
          value += next
          i += 2
          break
        case 'b':
          value += '\b'
          i += 2
          break
        case 'f':
          value += '\f'
          i += 2
          break
        case 'n':
          value += '\n'
          i += 2
          break
        case 'r':
          value += '\r'
          i += 2
          break
        case 't':
          value += '\t'
          i += 2
          break
        case 'u': {
          const hex = source.slice(i + 2, i + 6)
          if (hex.length < 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
            return { value, complete: false, endIndex: source.length }
          }
          value += String.fromCharCode(parseInt(hex, 16))
          i += 6
          break
        }
        default:
          // Unknown escape — keep literal next char (tolerant for streaming junk).
          value += next
          i += 2
          break
      }
      continue
    }
    value += ch
    i += 1
  }
  return { value, complete: false, endIndex: source.length }
}

/**
 * Find `"key": "<string…"` (possibly incomplete) and return the decoded value.
 * Returns undefined when the key/opening quote has not appeared yet.
 */
export function extractJsonStringField(raw: string, key: string): string | undefined {
  if (!raw || !key) return undefined
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`"${escapedKey}"\\s*:\\s*"`)
  const match = re.exec(raw)
  if (!match) return undefined
  const start = match.index + match[0].length
  return decodeJsonStringPrefix(raw, start).value
}

const EDIT_STRING_KEYS = [
  'path',
  'diff',
  'contents',
  'old_string',
  'new_string'
] as const

export type PartialEditArgs = {
  path?: string
  diff?: string
  contents?: string
  old_string?: string
  new_string?: string
  edits?: Array<Record<string, unknown>>
}

/**
 * Pull complete edit objects from a streaming `"edits":[…]` array, plus the
 * last incomplete object when its string fields are already visible.
 */
export function extractPartialEditsArray(raw: string): Array<Record<string, unknown>> {
  const editsKey = /"edits"\s*:\s*\[/.exec(raw)
  if (!editsKey) return []
  const body = raw.slice(editsKey.index + editsKey[0].length)
  const out: Array<Record<string, unknown>> = []
  let i = 0
  while (i < body.length) {
    while (i < body.length && /[\s,]/.test(body[i]!)) i += 1
    if (i >= body.length || body[i] === ']') break
    if (body[i] !== '{') break

    let depth = 0
    let inString = false
    let escape = false
    let end = -1
    for (let j = i; j < body.length; j++) {
      const ch = body[j]!
      if (inString) {
        if (escape) {
          escape = false
        } else if (ch === '\\') {
          escape = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          end = j
          break
        }
      }
    }

    if (end >= 0) {
      const slice = body.slice(i, end + 1)
      try {
        const parsed = JSON.parse(slice) as unknown
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          out.push(parsed as Record<string, unknown>)
        }
      } catch {
        // Fall through to partial field extract on this object.
        const partial = extractTopLevelEditStrings(slice)
        if (Object.keys(partial).length > 0) out.push(partial)
      }
      i = end + 1
      continue
    }

    // Incomplete trailing object — extract whatever string fields are present.
    const partial = extractTopLevelEditStrings(body.slice(i))
    if (Object.keys(partial).length > 0) out.push(partial)
    break
  }
  return out
}

function extractTopLevelEditStrings(raw: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of EDIT_STRING_KEYS) {
    const value = extractJsonStringField(raw, key)
    if (value !== undefined) out[key] = value
  }
  if (!out.path) {
    const file = extractJsonStringField(raw, 'file')
    if (file !== undefined) out.path = file
  }
  if (!out.contents) {
    const content = extractJsonStringField(raw, 'content')
    if (content !== undefined) out.contents = content
  }
  return out
}

/**
 * Resolve edit/str_replace tool args from a complete or streaming
 * argsPreview blob. Returns null when nothing useful has arrived yet.
 */
export function extractPartialEditArgs(raw: string | undefined | null): PartialEditArgs | null {
  if (!raw?.trim()) return null

  const last = raw.trimEnd().slice(-1)
  if (last === '}' || last === ']') {
    try {
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as PartialEditArgs
      }
    } catch {
      // Incomplete JSON that merely ends with } inside a string — field extract.
    }
  }

  const out: PartialEditArgs = extractTopLevelEditStrings(raw) as PartialEditArgs

  const edits = extractPartialEditsArray(raw)
  if (edits.length > 0) out.edits = edits

  return Object.keys(out).length > 0 ? out : null
}
