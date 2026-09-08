/** Typed ask_question form items and legacy → canonical normalization. */

import { parseJsonish } from './jsonish'

export const AGENT_QUESTION_TYPES = ['single', 'multi', 'boolean', 'text'] as const
export type AgentQuestionType = (typeof AGENT_QUESTION_TYPES)[number]

export const AGENT_QUESTION_MAX_ITEMS = 8
export const AGENT_QUESTION_MAX_OPTIONS = 12
export const AGENT_QUESTION_MAX_PROMPT_CHARS = 2000
export const AGENT_QUESTION_MAX_OPTION_CHARS = 300
export const AGENT_QUESTION_MAX_TITLE_CHARS = 200
export const AGENT_QUESTION_MAX_ANSWER_CHARS = 2000
export const AGENT_QUESTION_MAX_ANSWER_VALUES = 16

/** Model-facing example embedded in validation errors. */
export const ASK_QUESTION_ARGS_HINT =
  'Pass questions: [{ id, prompt, type: "boolean"|"text"|"single"|"multi", options? }] (type defaults to "single" when 2+ options are given, else "text") or legacy { question: "…" }.'

/** Tool result when the user skips, dismisses, or the wait times out. */
export const ASK_QUESTION_NO_ANSWER_GUIDANCE =
  'Question timed out or was dismissed without answers. Continue with a reasonable default.'

/** Tool result when autonomous mode skips the form. */
export const ASK_QUESTION_AUTONOMOUS_SKIP_GUIDANCE =
  'Question skipped (autonomous mode). Continue with a reasonable default.'

export type AgentQuestionItem = {
  id: string
  prompt: string
  type: AgentQuestionType
  options?: string[]
  allowCustom?: boolean
}

export type AgentQuestionAnswer = {
  questionId: string
  values: string[]
}

export type NormalizedAskQuestionForm = {
  title?: string
  questions: AgentQuestionItem[]
}

function uniqueTrimmedStrings(values: unknown): string[] {
  let list: unknown = values
  if (typeof list === 'string') {
    const parsed = parseJsonish(list)
    if (Array.isArray(parsed)) list = parsed
  }
  if (!Array.isArray(list)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of list) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    out.push(trimmed)
  }
  return out
}

function isQuestionType(value: unknown): value is AgentQuestionType {
  return (
    value === 'single' || value === 'multi' || value === 'boolean' || value === 'text'
  )
}

function questionPromptFromRecord(rec: Record<string, unknown>): string {
  if (typeof rec.prompt === 'string' && rec.prompt.trim()) return rec.prompt.trim()
  if (typeof rec.question === 'string' && rec.question.trim()) return rec.question.trim()
  return ''
}

function validateItem(item: AgentQuestionItem, index: number): string | null {
  if (!item.id.trim()) return `questions[${index}].id is required`
  if (!item.prompt.trim()) return `questions[${index}].prompt is required`
  return null
}

function coerceQuestionRecord(raw: unknown): Record<string, unknown> | null {
  let value: unknown = raw
  if (typeof value === 'string') {
    value = parseJsonish(value)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

/** Normalize one raw question object from tool args. */
function parseTypedItem(raw: unknown, index: number): AgentQuestionItem | { error: string } {
  const rec = coerceQuestionRecord(raw)
  if (!rec) {
    return { error: `questions[${index}] must be an object` }
  }
  const id = typeof rec.id === 'string' ? rec.id.trim() : ''
  const prompt = questionPromptFromRecord(rec)
  const options = uniqueTrimmedStrings(rec.options)
  const allowCustom = rec.allowCustom === true
  // Models routinely omit `type` on items that carry options (live failures:
  // 3d334c22/870cde12/829b9ada all sent id+prompt+options without type).
  // Infer it the same way the legacy {question, options, allowMultiple} form
  // does instead of failing the whole form: options ⇒ single, else text.
  let requestedType: AgentQuestionType
  if (isQuestionType(rec.type)) {
    requestedType = rec.type
  } else if (rec.type == null) {
    requestedType = options.length >= 2 ? 'single' : 'text'
  } else {
    return { error: `questions[${index}].type must be single, multi, boolean, or text` }
  }
  // Fewer than 2 distinct non-blank options cannot render a choice — degrade
  // to freeform text instead of failing the whole form.
  const type: AgentQuestionType =
    (requestedType === 'single' || requestedType === 'multi') && options.length < 2
      ? 'text'
      : requestedType

  const item: AgentQuestionItem = {
    id: id || `q${index + 1}`,
    prompt,
    type,
    ...(type === 'single' || type === 'multi'
      ? {
          ...(options.length ? { options } : {}),
          ...(allowCustom ? { allowCustom: true } : {})
        }
      : {})
  }

  const err = validateItem(item, index)
  if (err) return { error: err }
  return item
}

/**
 * Accepts typed `questions[]` or legacy `{ question, options, allowMultiple, allowCustom }`.
 * Typed forms default `allowCustom` off; legacy defaults it on when options exist.
 */
export function normalizeAskQuestionArgs(
  args: Record<string, unknown>
): { ok: true; form: NormalizedAskQuestionForm } | { ok: false; error: string } {
  const title =
    typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
  let questionsInput = args.questions
  if (typeof questionsInput === 'string') {
    const parsed = parseJsonish(questionsInput)
    if (parsed !== undefined) questionsInput = parsed
  }
  if (questionsInput !== null && typeof questionsInput === 'object' && !Array.isArray(questionsInput)) {
    questionsInput = [questionsInput]
  }

  if (Array.isArray(questionsInput)) {
    if (questionsInput.length === 0) {
      return {
        ok: false,
        error: `questions must contain at least 1 item. ${ASK_QUESTION_ARGS_HINT}`
      }
    }
    const questions: AgentQuestionItem[] = []
    const ids = new Set<string>()
    for (let i = 0; i < questionsInput.length; i++) {
      const parsed = parseTypedItem(questionsInput[i], i)
      if ('error' in parsed) return { ok: false, error: parsed.error }
      if (ids.has(parsed.id)) {
        return { ok: false, error: `duplicate question id: ${parsed.id}` }
      }
      ids.add(parsed.id)
      questions.push(parsed)
    }
    return { ok: true, form: { ...(title ? { title } : {}), questions } }
  }

  if (questionsInput != null) {
    return {
      ok: false,
      error: `ask_question.questions must be a JSON array of question objects. ${ASK_QUESTION_ARGS_HINT}`
    }
  }

  const prompt =
    typeof args.question === 'string' && args.question.trim()
      ? args.question.trim()
      : typeof args.prompt === 'string' && args.prompt.trim()
        ? args.prompt.trim()
        : ''
  if (!prompt) {
    return { ok: false, error: `question or questions is required. ${ASK_QUESTION_ARGS_HINT}` }
  }

  const options = uniqueTrimmedStrings(args.options)
  const allowMultiple = args.allowMultiple === true
  // Legacy: custom text on by default when options are present.
  const allowCustom = args.allowCustom !== false

  // Fewer than 2 distinct non-blank options cannot render a choice — degrade
  // to freeform text instead of failing the whole form.
  let type: AgentQuestionType
  if (options.length < 2) {
    type = 'text'
  } else if (allowMultiple) {
    type = 'multi'
  } else {
    type = 'single'
  }

  const item: AgentQuestionItem = {
    id: 'q1',
    prompt,
    type,
    ...(type === 'single' || type === 'multi'
      ? {
          options,
          ...(allowCustom ? { allowCustom: true } : { allowCustom: false })
        }
      : {})
  }

  return {
    ok: true,
    form: { ...(title ? { title } : {}), questions: [item] }
  }
}

/**
 * Validate + sanitize renderer answers against the asked questions: unknown
 * question ids are dropped, values are trimmed and capped, and single/boolean
 * keep at most one value. An empty result means the user skipped the form.
 */
export function sanitizeQuestionAnswers(
  questions: readonly AgentQuestionItem[],
  answers: readonly AgentQuestionAnswer[]
): AgentQuestionAnswer[] {
  if (!answers.length) return []
  const byId = new Map(questions.map((q) => [q.id, q]))
  const out: AgentQuestionAnswer[] = []
  for (const answer of answers) {
    const question = byId.get(answer.questionId)
    if (!question) continue
    const rawValues = Array.isArray(answer.values) ? answer.values : []
    const values = rawValues
      .map((value) => String(value).trim())
      .filter(Boolean)
    if (question.type === 'single' || question.type === 'boolean') {
      values.length = Math.min(values.length, 1)
    }
    if (values.length === 0) continue
    out.push({ questionId: question.id, values })
  }
  return out
}

/** Human-readable tool result for the model. */
export function formatQuestionAnswers(
  form: NormalizedAskQuestionForm,
  answers: AgentQuestionAnswer[]
): string {
  if (answers.length === 0) return 'User provided no answer.'

  const byId = new Map(answers.map((a) => [a.questionId, a.values.filter((v) => v.trim())]))
  const { questions } = form

  if (questions.length === 1) {
    const q = questions[0]!
    const values = byId.get(q.id) ?? []
    if (values.length === 0) return 'User provided no answer.'
    if (values.length === 1) return `User answered: ${values[0]}`
    return `User answered:\n${values.map((a) => `- ${a}`).join('\n')}`
  }

  const lines = ['User answered:']
  for (const q of questions) {
    const values = byId.get(q.id) ?? []
    const formatted =
      values.length === 0 ? '(no answer)' : values.length === 1 ? values[0]! : values.join(', ')
    lines.push(`- ${q.prompt}: ${formatted}`)
  }
  return lines.join('\n')
}

/** Short summary for tool row / activity label. */
export function askQuestionSummary(form: NormalizedAskQuestionForm): string {
  if (form.title) return form.title.slice(0, 80)
  if (form.questions.length === 1) return form.questions[0]!.prompt.slice(0, 80)
  return `${form.questions.length} questions`
}

export function questionTypeHint(type: AgentQuestionType): string {
  switch (type) {
    case 'single':
      return 'Choose one'
    case 'multi':
      return 'Select all that apply'
    case 'boolean':
      return 'Yes or no'
    case 'text':
      return 'Your answer'
  }
}
