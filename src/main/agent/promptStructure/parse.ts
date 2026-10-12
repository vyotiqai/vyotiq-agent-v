import {
  PROMPT_TASK_TYPES,
  type PromptStructureQuestion,
  type PromptTaskType
} from '../../../shared/ipc/schemas/promptStructure'

export type ParsedStructure =
  | { kind: 'brief'; taskType: PromptTaskType; brief: string }
  | { kind: 'questions'; taskType: PromptTaskType; questions: PromptStructureQuestion[] }

/**
 * Raw newlines and tabs inside JSON strings are the commonest way a model
 * breaks its own JSON when the value is a multi-line brief. Escape them, and
 * nothing outside strings.
 */
export function escapeControlCharsInStrings(json: string): string {
  let out = ''
  let inString = false
  let escaped = false
  for (const ch of json) {
    if (inString) {
      if (escaped) {
        escaped = false
        out += ch
        continue
      }
      if (ch === '\\') {
        escaped = true
        out += ch
        continue
      }
      if (ch === '"') inString = false
      else if (ch === '\n') {
        out += '\\n'
        continue
      } else if (ch === '\r') continue
      else if (ch === '\t') {
        out += '\\t'
        continue
      }
      out += ch
      continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}

/** The first `{` to its matching `}`, skipping braces inside strings. */
function firstObject(text: string): string | null {
  const start = text.indexOf('{')
  if (start < 0) return null
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
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

function asTaskType(value: unknown): PromptTaskType {
  return typeof value === 'string' && (PROMPT_TASK_TYPES as readonly string[]).includes(value)
    ? (value as PromptTaskType)
    : 'other'
}

/** A question or option as plain words: the panel shows text, so code ticks would show as ticks. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = value.replace(/`([^`]*)`/g, '$1').replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** An option as a string, or as the `{ label }` / `{ text }` / `{ value }` object some models write. */
function optionText(option: unknown): string | null {
  if (option && typeof option === 'object') {
    const o = option as Record<string, unknown>
    return cleanText(o.label ?? o.text ?? o.value ?? o.title, 200)
  }
  return cleanText(option, 200)
}

function parseQuestions(value: unknown): PromptStructureQuestion[] {
  if (!Array.isArray(value)) return []
  const out: PromptStructureQuestion[] = []
  for (const raw of value.slice(0, 3)) {
    if (!raw || typeof raw !== 'object') continue
    const q = raw as Record<string, unknown>
    const question = cleanText(q.question ?? q.text ?? q.prompt ?? q.title, 500)
    const list = q.options ?? q.choices
    const options = Array.isArray(list)
      ? [...new Set(list.map(optionText).filter((o): o is string => Boolean(o)))].slice(0, 4)
      : []
    if (!question || options.length < 2) continue
    out.push({ id: `q${out.length + 1}`, question, options, multi: q.multi === true })
  }
  return out
}

/** A brief as text: fences the model wrapped it in, and a trailing "let me know", gone. */
function cleanBrief(value: unknown): string | null {
  if (typeof value !== 'string') return null
  let text = value.replace(/\r\n?/g, '\n').trim()
  const fenced = /^```[a-z]*\n([\s\S]*?)\n```$/i.exec(text)
  if (fenced) text = fenced[1]!.trim()
  text = text.replace(/\n{3,}/g, '\n\n')
  return text || null
}

/**
 * The model's reply as a brief or questions. Null when it is neither — the
 * caller asks once more, then gives up.
 */
export function parseStructureReply(raw: string): ParsedStructure | null {
  const unfenced = raw.replace(/^\s*```[a-z]*\s*/i, '').replace(/\s*```\s*$/i, '')
  const candidate = firstObject(unfenced) ?? firstObject(escapeControlCharsInStrings(unfenced))
  if (!candidate) return null
  let data: unknown
  try {
    data = JSON.parse(candidate)
  } catch {
    try {
      data = JSON.parse(escapeControlCharsInStrings(candidate))
    } catch {
      return null
    }
  }
  if (!data || typeof data !== 'object') return null
  const obj = data as Record<string, unknown>
  const taskType = asTaskType(obj.taskType)
  if (obj.kind === 'questions') {
    const questions = parseQuestions(obj.questions)
    return questions.length ? { kind: 'questions', taskType, questions } : null
  }
  const brief = cleanBrief(obj.brief)
  return brief ? { kind: 'brief', taskType, brief } : null
}

/**
 * Every attached chip's token in the brief exactly once: extra copies go, a
 * token the person never attached goes, and a dropped one comes back on the
 * brief's first line, where the goal is.
 */
export function ensureTokens(brief: string, tokens: readonly string[]): string {
  const wanted = new Set(tokens)
  const seen = new Set<string>()
  let text = brief.replace(/\[\[@\d{1,2}\]\]/g, (token) => {
    if (!wanted.has(token) || seen.has(token)) return ''
    seen.add(token)
    return token
  })
  // Removing a token can leave "see  and" or a space before punctuation.
  text = text.replace(/[ \t]{2,}/g, ' ').replace(/ +([,.;:)])/g, '$1')
  const missing = tokens.filter((t) => !seen.has(t))
  if (missing.length) {
    const lines = text.split('\n')
    // The goal's line, not a heading above it.
    const first = lines.findIndex((l) => l.trim() && !/^\s*#/.test(l))
    const at = first < 0 ? 0 : first
    lines[at] = `${(lines[at] ?? '').trimEnd()} ${missing.join(' ')}`.trim()
    text = lines.join('\n')
  }
  return text.trim()
}
