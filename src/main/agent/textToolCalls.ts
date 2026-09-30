/**
 * Tool calls a model wrote as text instead of structured `tool_calls`.
 *
 * Local models served through Ollama, llama.cpp or vLLM often answer a tool
 * turn with the call spelled out in their chat template's own syntax, and the
 * server passes it through as plain text. The step then looked like a final
 * answer and the run simply ended. These are the shapes seen in practice:
 *
 * - `<tool_call>{"name": …, "arguments": …}</tool_call>`   (Qwen, Hermes)
 * - `[TOOL_CALLS][{"name": …, "arguments": …}]`           (Mistral, older)
 * - `[TOOL_CALLS]name[ARGS]{…}`                             (Mistral, newer)
 * - `<|python_tag|>{"name": …, "parameters": …}`            (Llama 3.x)
 * - `<function=name>{…}</function>`                         (Llama 3.1 alt)
 * - a reply that is nothing but `{"name": …, "arguments": …}`, bare or in a
 *   ```json fence (Llama 3.x JSON tool calling, small coder models)
 *
 * Only names of tools this step actually offered are recovered, and bare or
 * fenced JSON only when it is essentially the whole reply — a model showing
 * what a call looks like, in the middle of an explanation, is not calling it.
 */

export type RecoveredToolCall = { name: string; arguments: string }

export type RecoveredToolCalls = {
  calls: RecoveredToolCall[]
  /** The reply with the call text taken out. */
  text: string
}

/** Around a bare or fenced JSON call: more prose than this means it's an explanation. */
const MAX_SURROUNDING_PROSE = 160
const MAX_CALLS = 16

type Candidate = { name: unknown; args: unknown }

function asObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (!trimmed.startsWith('{')) return null
    try {
      return asObject(JSON.parse(trimmed))
    } catch {
      return null
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
}

/** `{name, arguments|parameters|args|input}` or `{type:"function", function:{name, arguments}}`. */
function candidateFrom(value: unknown): Candidate | null {
  const obj = asObject(value)
  if (!obj) return null
  const fn = asObject(obj.function)
  if (fn && typeof fn.name === 'string') {
    return { name: fn.name, args: fn.arguments ?? fn.parameters ?? {} }
  }
  if (typeof obj.name !== 'string') return null
  const args = obj.arguments ?? obj.parameters ?? obj.args ?? obj.input ?? {}
  return { name: obj.name, args }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

/** One JSON value (object or array) at the start of `text`; returns it and where it ended. */
function leadingJson(text: string): { value: unknown; end: number } | null {
  const start = text.search(/\S/)
  if (start < 0) return null
  const open = text[start]
  if (open !== '{' && open !== '[') return null
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) {
        const value = parseJson(text.slice(start, i + 1))
        return value === undefined ? null : { value, end: i + 1 }
      }
    }
  }
  return null
}

function candidatesFrom(value: unknown): Candidate[] {
  if (Array.isArray(value)) return value.map(candidateFrom).filter((c): c is Candidate => c !== null)
  const one = candidateFrom(value)
  return one ? [one] : []
}

type Span = { start: number; end: number; candidates: Candidate[] }

function taggedSpans(text: string): Span[] {
  const spans: Span[] = []

  // <tool_call> … </tool_call>, the closing tag optional at the very end.
  const toolCallRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g
  for (let m = toolCallRe.exec(text); m; m = toolCallRe.exec(text)) {
    spans.push({ start: m.index, end: m.index + m[0].length, candidates: candidatesFrom(parseJson(m[1]!)) })
    if (m[0].length === 0) toolCallRe.lastIndex += 1
  }

  // <function=name>{…}</function>
  const functionRe = /<function=([A-Za-z0-9_.:-]+)>([\s\S]*?)(?:<\/function>|$)/g
  for (let m = functionRe.exec(text); m; m = functionRe.exec(text)) {
    spans.push({
      start: m.index,
      end: m.index + m[0].length,
      candidates: [{ name: m[1], args: parseJson(m[2]!) ?? {} }]
    })
  }

  // [TOOL_CALLS] — either a JSON array, or name[ARGS]{…} repeated.
  const mistralRe = /\[TOOL_CALLS\]/g
  for (let m = mistralRe.exec(text); m; m = mistralRe.exec(text)) {
    const after = m.index + m[0].length
    const rest = text.slice(after)
    const json = leadingJson(rest)
    if (json) {
      spans.push({ start: m.index, end: after + json.end, candidates: candidatesFrom(json.value) })
      continue
    }
    const named = /^\s*([A-Za-z0-9_.:-]+)\[ARGS\]/.exec(rest)
    if (named) {
      const args = leadingJson(rest.slice(named[0].length))
      if (args) {
        spans.push({
          start: m.index,
          end: after + named[0].length + args.end,
          candidates: [{ name: named[1], args: args.value }]
        })
      }
    }
  }

  // <|python_tag|>{…} (Llama 3.x), possibly several separated by ';'.
  const pythonTagRe = /<\|python_tag\|>/g
  for (let m = pythonTagRe.exec(text); m; m = pythonTagRe.exec(text)) {
    let cursor = m.index + m[0].length
    const candidates: Candidate[] = []
    for (;;) {
      const json = leadingJson(text.slice(cursor))
      if (!json) break
      candidates.push(...candidatesFrom(json.value))
      cursor += json.end
      const sep = /^\s*;/.exec(text.slice(cursor))
      if (!sep) break
      cursor += sep[0].length
    }
    const end = /^\s*<\|eom_id\|>/.exec(text.slice(cursor))
    spans.push({ start: m.index, end: cursor + (end ? end[0].length : 0), candidates })
  }

  return spans.sort((a, b) => a.start - b.start)
}

/** A reply that is only a JSON call, bare or in one fenced block, with little prose around it. */
function wholeReplySpan(text: string): Span | null {
  const fence = /```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)```/i.exec(text)
  const body = fence ? fence[1]! : text
  const json = leadingJson(body)
  if (!json) return null
  const candidates = candidatesFrom(json.value)
  if (candidates.length === 0) return null
  const start = fence ? fence.index : text.search(/\S/)
  const end = fence ? fence.index + fence[0].length : text.search(/\S/) + json.end
  const surrounding = `${text.slice(0, start)}${text.slice(end)}`.trim()
  if (!fence && body.slice(json.end).trim().length > 0) return null
  if (surrounding.length > MAX_SURROUNDING_PROSE) return null
  return { start, end, candidates }
}

/**
 * Recover the calls in `text`. `offered` holds the names of the tools this
 * step sent; `canonical` maps an alias the model used to the real name.
 * Null when there is nothing to recover — the reply stays a reply.
 */
export function recoverTextToolCalls(
  text: string,
  offered: ReadonlySet<string>,
  canonical: (name: string) => string = (name) => name
): RecoveredToolCalls | null {
  if (!text.trim() || offered.size === 0) return null
  let spans = taggedSpans(text)
  if (spans.length === 0) {
    const whole = wholeReplySpan(text)
    spans = whole ? [whole] : []
  }
  const calls: RecoveredToolCall[] = []
  const kept: Span[] = []
  for (const span of spans) {
    const valid: RecoveredToolCall[] = []
    for (const c of span.candidates) {
      if (typeof c.name !== 'string' || !c.name.trim()) continue
      const name = canonical(c.name.trim())
      if (!offered.has(name)) continue
      const args = asObject(c.args) ?? (c.args === undefined || c.args === null ? {} : null)
      if (!args) continue
      valid.push({ name, arguments: JSON.stringify(args) })
    }
    if (valid.length > 0) {
      calls.push(...valid)
      kept.push(span)
    }
  }
  if (calls.length === 0) return null
  let remaining = ''
  let cursor = 0
  for (const span of kept) {
    if (span.start < cursor) continue
    remaining += text.slice(cursor, span.start)
    cursor = span.end
  }
  remaining += text.slice(cursor)
  return { calls: calls.slice(0, MAX_CALLS), text: remaining.replace(/\n{3,}/g, '\n\n').trim() }
}
