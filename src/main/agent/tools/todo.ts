import { existsSync, readFileSync, rmSync } from 'fs'
import { join } from 'path'
import { z } from 'zod'
import { atomicWriteJson } from '@main/storage/atomicWrite'
import type { ChatMessage } from '../../../shared/ipc'
import { wrapPromptSection } from '../promptSections'

export const TodoStatusSchema = z.enum(['pending', 'in_progress', 'completed', 'cancelled'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  content: z.string().min(1),
  status: TodoStatusSchema
})
export type TodoItem = z.infer<typeof TodoItemSchema>

const TodoFileSchema = z.object({
  updatedAt: z.string(),
  todos: z.array(TodoItemSchema)
})

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: '[ ]',
  in_progress: '[~]',
  completed: '[x]',
  cancelled: '[-]'
}

function todoPath(runDir: string): string {
  return join(runDir, 'todos.json')
}

export function readTodos(runDir: string): TodoItem[] {
  const path = todoPath(runDir)
  if (!existsSync(path)) return []
  try {
    const parsed = TodoFileSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')))
    return parsed.success ? parsed.data.todos : []
  } catch {
    return []
  }
}

export function hasInProgressTodo(runDir: string): boolean {
  return readTodos(runDir).some((todo) => todo.status === 'in_progress')
}

/** True when message history still contains a todo_write tool call/result. */
export function messagesHaveTodoWrite(messages: readonly ChatMessage[]): boolean {
  for (const message of messages) {
    if (message.role === 'assistant' && message.toolCalls?.some((tc) => tc.name === 'todo_write')) {
      return true
    }
    if (message.role === 'tool' && message.toolName === 'todo_write') return true
  }
  return false
}

const ITEM_WITH_ID_RE = /^(\[[ x~-]\])\s+\(([^)]+)\)\s+(.+)$/
const MARK_TO_STATUS: Record<string, TodoStatus> = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[-]': 'cancelled'
}

/** Parse checklist lines produced by {@link serializeTodoContent}. */
export function parseSerializedTodoContent(content: string): TodoItem[] {
  const items: TodoItem[] = []
  for (const line of content.split('\n')) {
    const match = line.match(ITEM_WITH_ID_RE)
    if (!match) continue
    const status = MARK_TO_STATUS[match[1]!]
    if (!status) continue
    const id = match[2]!.trim()
    const text = match[3]!.trim()
    if (!id || !text) continue
    items.push({ id, content: text, status })
  }
  return items
}

function latestTodoWriteContent(messages: readonly ChatMessage[]): string | null {
  let last: string | null = null
  for (const message of messages) {
    if (message.role !== 'tool' || message.toolName !== 'todo_write') continue
    if (message.ok === false) continue
    if (typeof message.content !== 'string' || !message.content.trim()) continue
    last = message.content
  }
  return last
}

/**
 * Keep run-dir todos.json aligned with truncated history after rewind:
 * - no remaining todo_write → delete the file
 * - otherwise rewrite from the latest kept successful todo_write snapshot
 */
export function syncTodosAfterRewind(runDir: string, messages: readonly ChatMessage[]): void {
  const path = todoPath(runDir)
  if (!messagesHaveTodoWrite(messages)) {
    if (existsSync(path)) rmSync(path, { force: true })
    return
  }
  const content = latestTodoWriteContent(messages)
  if (!content) {
    if (existsSync(path)) rmSync(path, { force: true })
    return
  }
  const todos = parseSerializedTodoContent(content)
  if (todos.length === 0) {
    if (existsSync(path)) rmSync(path, { force: true })
    return
  }
  atomicWriteJson(path, { updatedAt: new Date().toISOString(), todos })
}

/** Drop run-dir todos.json when rewind removed every todo_write from history. */
export function clearTodosIfOrphaned(runDir: string, messages: readonly ChatMessage[]): void {
  syncTodosAfterRewind(runDir, messages)
}

/** Collapse whitespace so checklist lines stay one-item-per-line for the UI parser. */
export function sanitizeTodoItemContent(content: string): string {
  return content.replace(/\s+/g, ' ').trim()
}

/**
 * Canonical id safe for the `[x] (id) content` checklist line format: any
 * whitespace or parenthesis in a raw id would break parseSerializedTodoContent
 * (rewind sync re-parses these lines), so ids are canonicalized once at write
 * time. Deterministic, so merge-by-id stays stable across todo_write calls.
 */
function canonicalTodoId(id: string): string {
  return id.replace(/[\s()]+/g, '')
}

function normalizeTodoItems(todos: TodoItem[]): TodoItem[] {
  const byId = new Map<string, TodoItem>()
  for (const todo of todos) {
    // Defense-in-depth for callers that bypass the Zod schema (direct
    // toolTodoWrite calls): schema-validated args are already trimmed and
    // non-empty. Every stored item must keep non-empty id and content so
    // todos.json always round-trips through TodoFileSchema — an item with
    // no usable text is not a task, so it is dropped rather than stored
    // with content:"" (unreadable) or the id as text (silent rename).
    const id = canonicalTodoId(todo.id)
    if (!id) continue
    const sanitized = sanitizeTodoItemContent(todo.content)
    const content = sanitized || todo.content.trim()
    if (!content) continue
    byId.set(id, { id, content, status: todo.status })
  }
  return [...byId.values()]
}

/** Checklist text shown in the transcript and injected into model context. */
export function serializeTodoContent(todos: TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length
  const lines = todos.map((todo) => `${STATUS_MARK[todo.status]} (${todo.id}) ${todo.content}`)
  return [`${done}/${todos.length} complete`, ...lines].join('\n')
}

/** Volatile system section so the list survives compaction folds. */
export function formatTodosContextSection(todos: TodoItem[]): string {
  if (todos.length === 0) return ''
  return wrapPromptSection('task_list', serializeTodoContent(todos))
}

/** Cancel in-progress tasks left open when a run is interrupted. */
export function finalizeInterruptedTodos(runDir: string): string | null {
  return finalizeTodosOnRunEnd(runDir, 'cancelled')
}

/**
 * Close in-progress todos when a run reaches a terminal status.
 * - done / error: demote in_progress → pending (work may resume on a follow-up)
 * - cancelled: demote in_progress → cancelled (interrupt / orphan path)
 */
export function finalizeTodosOnRunEnd(
  runDir: string,
  outcome: 'done' | 'error' | 'cancelled'
): string | null {
  const todos = readTodos(runDir)
  if (!todos.some((todo) => todo.status === 'in_progress')) return null
  const nextStatus: TodoStatus = outcome === 'cancelled' ? 'cancelled' : 'pending'
  const next = todos.map((todo) =>
    todo.status === 'in_progress' ? { ...todo, status: nextStatus } : todo
  )
  atomicWriteJson(todoPath(runDir), { updatedAt: new Date().toISOString(), todos: next })
  return serializeTodoContent(next)
}

/**
 * Replace or merge the run's task list.
 *
 * The list lives in the run directory rather than the message history so it
 * stays the same size no matter how many times the model rewrites it, and it
 * survives a reload of the transcript. After compaction, assembleContext also
 * re-injects the current list from disk into the volatile system section.
 */
export function toolTodoWrite(
  runDir: string,
  todos: TodoItem[],
  merge = false
): { content: string; todos: TodoItem[]; notice?: string } {
  if (!runDir) throw new Error('todo_write is only available inside a run')

  const incoming = normalizeTodoItems(todos)
  let next: TodoItem[]
  if (merge) {
    const byId = new Map(readTodos(runDir).map((todo) => [todo.id, todo]))
    for (const todo of incoming) byId.set(todo.id, { ...byId.get(todo.id), ...todo })
    next = [...byId.values()]
  } else {
    next = incoming
  }

  const inProgressIndexes: number[] = []
  for (let i = 0; i < next.length; i++) {
    if (next[i]!.status === 'in_progress') inProgressIndexes.push(i)
  }
  let notice: string | undefined
  if (inProgressIndexes.length > 1) {
    const keepIdx = inProgressIndexes[inProgressIndexes.length - 1]!
    const demoted: string[] = []
    next = next.map((todo, i) => {
      if (todo.status === 'in_progress' && i !== keepIdx) {
        demoted.push(todo.id)
        return { ...todo, status: 'pending' as const }
      }
      return todo
    })
    notice = `only one task may be in_progress; demoted ${demoted.join(', ')} to pending (kept ${next[keepIdx]!.id})`
  }

  atomicWriteJson(todoPath(runDir), { updatedAt: new Date().toISOString(), todos: next })

  return {
    content: serializeTodoContent(next),
    todos: next,
    ...(notice ? { notice } : {})
  }
}
