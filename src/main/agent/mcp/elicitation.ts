import type { AgentQuestionAnswer, AgentQuestionItem } from '../../../shared/ipc'
import {
  AGENT_QUESTION_MAX_ITEMS,
  AGENT_QUESTION_MAX_OPTION_CHARS,
  AGENT_QUESTION_MAX_OPTIONS,
  AGENT_QUESTION_MAX_PROMPT_CHARS,
  AGENT_QUESTION_MAX_TITLE_CHARS
} from '../../../shared/utils/agentQuestionForm'

/**
 * MCP elicitation, form mode: a server asks the person for a few values while
 * one of its tools runs. The form is shown the way the agent's own questions
 * are (the task says it needs you), and the answers go back typed as the
 * server's schema asks. Only flat forms exist in the protocol: strings,
 * numbers, booleans, and single or multiple choice.
 */

type Option = { value: string; label: string }

export type ElicitField =
  | { key: string; kind: 'text'; prompt: string; required: boolean; minLength?: number; maxLength?: number; format?: string }
  | { key: string; kind: 'number' | 'integer'; prompt: string; required: boolean; minimum?: number; maximum?: number }
  | { key: string; kind: 'boolean'; prompt: string; required: boolean }
  | { key: string; kind: 'single'; prompt: string; required: boolean; options: Option[] }
  | { key: string; kind: 'multi'; prompt: string; required: boolean; options: Option[]; minItems?: number; maxItems?: number }

export type ElicitForm = { title: string; fields: ElicitField[]; questions: AgentQuestionItem[] }

type Json = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const clip = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1)}…`)

function options(def: Json): Option[] | null {
  if (Array.isArray(def.oneOf) || Array.isArray(def.anyOf)) {
    const list = (Array.isArray(def.oneOf) ? def.oneOf : def.anyOf) as unknown[]
    const out: Option[] = []
    for (const entry of list) {
      const value = str((entry as Json)?.const)
      if (!value) return null
      out.push({ value, label: str((entry as Json).title) ?? value })
    }
    return out
  }
  if (Array.isArray(def.enum)) {
    const names = Array.isArray(def.enumNames) ? (def.enumNames as unknown[]) : []
    const out: Option[] = []
    for (const [i, entry] of (def.enum as unknown[]).entries()) {
      const value = str(entry)
      if (!value) return null
      out.push({ value, label: str(names[i]) ?? value })
    }
    return out
  }
  return null
}

function describe(field: ElicitField): string {
  switch (field.kind) {
    case 'number':
    case 'integer': {
      const range =
        field.minimum !== undefined && field.maximum !== undefined
          ? ` from ${field.minimum} to ${field.maximum}`
          : field.minimum !== undefined
            ? `, at least ${field.minimum}`
            : field.maximum !== undefined
              ? `, at most ${field.maximum}`
              : ''
      return ` (${field.kind === 'integer' ? 'a whole number' : 'a number'}${range})`
    }
    case 'text':
      return field.format ? ` (${field.format === 'uri' ? 'a link' : field.format === 'date-time' ? 'a date and time' : `an ${field.format === 'email' ? 'email address' : field.format}`})` : ''
    default:
      return ''
  }
}

/** The server's schema as fields and question-card items, or why it can't be shown. */
export function elicitationForm(
  serverName: string,
  message: string,
  requestedSchema: unknown
): { ok: true; form: ElicitForm } | { ok: false; reason: string } {
  const schema = (requestedSchema ?? {}) as Json
  const properties = (schema.properties ?? {}) as Record<string, Json>
  const required = new Set(Array.isArray(schema.required) ? (schema.required as unknown[]).filter((k): k is string => typeof k === 'string') : [])
  const keys = Object.keys(properties)
  if (keys.length > AGENT_QUESTION_MAX_ITEMS) {
    return { ok: false, reason: `asks for ${keys.length} values; at most ${AGENT_QUESTION_MAX_ITEMS} can be shown` }
  }
  const fields: ElicitField[] = []
  for (const key of keys) {
    const def = properties[key] ?? {}
    const label = str(def.title) ?? key
    const note = str(def.description)
    const base = { key, prompt: note ? `${label} — ${note}` : label, required: required.has(key) }
    let field: ElicitField
    if (def.type === 'boolean') {
      field = { ...base, kind: 'boolean' }
    } else if (def.type === 'number' || def.type === 'integer') {
      field = { ...base, kind: def.type, ...(num(def.minimum) !== undefined ? { minimum: num(def.minimum) } : {}), ...(num(def.maximum) !== undefined ? { maximum: num(def.maximum) } : {}) }
    } else if (def.type === 'array') {
      const opts = options((def.items ?? {}) as Json)
      if (!opts || opts.length < 1) return { ok: false, reason: `field “${key}” is a list without fixed choices` }
      field = {
        ...base,
        kind: 'multi',
        options: opts,
        ...(num(def.minItems) !== undefined ? { minItems: num(def.minItems) } : {}),
        ...(num(def.maxItems) !== undefined ? { maxItems: num(def.maxItems) } : {})
      }
    } else if (def.type === 'string') {
      const opts = options(def)
      field = opts
        ? { ...base, kind: 'single', options: opts }
        : {
            ...base,
            kind: 'text',
            ...(num(def.minLength) !== undefined ? { minLength: num(def.minLength) } : {}),
            ...(num(def.maxLength) !== undefined ? { maxLength: num(def.maxLength) } : {}),
            ...(str(def.format) ? { format: str(def.format) } : {})
          }
    } else {
      return { ok: false, reason: `field “${key}” has a type the protocol doesn't allow in a form` }
    }
    if ((field.kind === 'single' || field.kind === 'multi') && field.options.length > AGENT_QUESTION_MAX_OPTIONS) {
      return { ok: false, reason: `field “${key}” has ${field.options.length} choices; at most ${AGENT_QUESTION_MAX_OPTIONS} can be shown` }
    }
    fields.push(field)
  }
  if (fields.length === 0) return { ok: false, reason: 'asks for nothing' }

  const questions: AgentQuestionItem[] = fields.map((field, i) => {
    // The server's message leads the first field; the card has no other place for it.
    const lead = i === 0 ? `${message.trim()}\n\n` : ''
    const prompt = clip(`${lead}${field.prompt}${describe(field)}${field.required ? '' : ' (optional)'}`, AGENT_QUESTION_MAX_PROMPT_CHARS)
    const id = `f${i}`
    switch (field.kind) {
      case 'boolean':
        return { id, prompt, type: 'boolean' }
      case 'single':
        // The card needs two choices; one fixed choice still reads as a pick.
        return field.options.length >= 2
          ? { id, prompt, type: 'single', options: field.options.map((o) => clip(o.label, AGENT_QUESTION_MAX_OPTION_CHARS)) }
          : { id, prompt: `${prompt} — “${field.options[0]!.label}”`, type: 'boolean' }
      case 'multi':
        return field.options.length >= 2
          ? { id, prompt, type: 'multi', options: field.options.map((o) => clip(o.label, AGENT_QUESTION_MAX_OPTION_CHARS)) }
          : { id, prompt: `${prompt} — “${field.options[0]!.label}”`, type: 'boolean' }
      default:
        return { id, prompt, type: 'text' }
    }
  })
  return { ok: true, form: { title: clip(`${serverName} asks`, AGENT_QUESTION_MAX_TITLE_CHARS), fields, questions } }
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

function textError(field: Extract<ElicitField, { kind: 'text' }>, value: string): string | null {
  if (field.minLength !== undefined && value.length < field.minLength) return `at least ${field.minLength} characters`
  if (field.maxLength !== undefined && value.length > field.maxLength) return `at most ${field.maxLength} characters`
  if (field.format === 'email' && !EMAIL.test(value)) return 'an email address'
  if (field.format === 'uri') {
    try {
      new URL(value)
    } catch {
      return 'a full link, like https://…'
    }
  }
  if (field.format === 'date' && !DATE.test(value)) return 'a date as YYYY-MM-DD'
  if (field.format === 'date-time' && Number.isNaN(Date.parse(value))) return 'a date and time'
  return null
}

/**
 * The answers as the server's content, or the first problem in words. All
 * answers empty is the card's Skip: the person declined.
 */
export function elicitationContent(
  form: ElicitForm,
  answers: readonly AgentQuestionAnswer[]
): { action: 'decline' } | { action: 'accept'; content: Record<string, string | number | boolean | string[]> } | { action: 'retry'; problem: string } {
  const byId = new Map(answers.map((a) => [a.questionId, a.values.map((v) => v.trim()).filter(Boolean)]))
  if ([...byId.values()].every((values) => values.length === 0)) return { action: 'decline' }
  const content: Record<string, string | number | boolean | string[]> = {}
  for (const [i, field] of form.fields.entries()) {
    const values = byId.get(`f${i}`) ?? []
    const name = field.prompt.split(' — ')[0]
    if (values.length === 0) {
      if (field.required) return { action: 'retry', problem: `${name} is needed` }
      continue
    }
    const first = values[0]!
    switch (field.kind) {
      case 'boolean':
        content[field.key] = first === 'Yes'
        break
      case 'number':
      case 'integer': {
        const n = Number(first)
        if (!Number.isFinite(n) || (field.kind === 'integer' && !Number.isInteger(n))) {
          return { action: 'retry', problem: `${name} should be ${field.kind === 'integer' ? 'a whole number' : 'a number'}` }
        }
        if (field.minimum !== undefined && n < field.minimum) return { action: 'retry', problem: `${name} should be at least ${field.minimum}` }
        if (field.maximum !== undefined && n > field.maximum) return { action: 'retry', problem: `${name} should be at most ${field.maximum}` }
        content[field.key] = n
        break
      }
      case 'text': {
        const problem = textError(field, first)
        if (problem) return { action: 'retry', problem: `${name} should be ${problem}` }
        content[field.key] = first
        break
      }
      case 'single': {
        // A one-choice field was shown as Yes/No.
        const pick = field.options.length >= 2 ? field.options.find((o) => clip(o.label, AGENT_QUESTION_MAX_OPTION_CHARS) === first) : first === 'Yes' ? field.options[0] : undefined
        if (!pick) {
          if (field.required) return { action: 'retry', problem: `${name} is needed` }
          break
        }
        content[field.key] = pick.value
        break
      }
      case 'multi': {
        const picked =
          field.options.length >= 2
            ? field.options.filter((o) => values.includes(clip(o.label, AGENT_QUESTION_MAX_OPTION_CHARS))).map((o) => o.value)
            : first === 'Yes'
              ? [field.options[0]!.value]
              : []
        if (field.minItems !== undefined && picked.length < field.minItems) return { action: 'retry', problem: `pick at least ${field.minItems} for ${name}` }
        if (field.maxItems !== undefined && picked.length > field.maxItems) return { action: 'retry', problem: `pick at most ${field.maxItems} for ${name}` }
        content[field.key] = picked
        break
      }
    }
  }
  return { action: 'accept', content }
}
