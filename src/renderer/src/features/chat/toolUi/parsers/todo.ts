import type { UiToolRow } from '@shared/transcript'

export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled'

export type TodoItem = {
  id?: string
  status: TodoStatus
  content: string
}

export type TodoParsed = {
  done: number
  total: number
  items: TodoItem[]
}

/** In-progress, else first pending, else the first item. */
export function pickCurrentTask(items: readonly TodoItem[]): TodoItem | null {
  return (
    items.find((item) => item.status === 'in_progress') ??
    items.find((item) => item.status === 'pending') ??
    items[0] ??
    null
  )
}

const STATUS_MAP: Record<string, TodoStatus> = {
  '[ ]': 'pending',
  '[~]': 'in_progress',
  '[x]': 'completed',
  '[-]': 'cancelled'
}

const JSON_STATUS = new Set<TodoStatus>(['pending', 'in_progress', 'completed', 'cancelled'])

const PROGRESS_RE = /^(\d+)\/(\d+)\s+complete/
const ITEM_WITH_ID_RE = /^(\[[ x~-]\])\s+\(([^)]+)\)\s+(.+)$/
const ITEM_RE = /^(\[[ x~-]\])\s+(.+)$/

function normalizeStatus(value: unknown): TodoStatus {
  return typeof value === 'string' && JSON_STATUS.has(value as TodoStatus)
    ? (value as TodoStatus)
    : 'pending'
}

/** Parse run-dir `todos.json` (ceiling band + Plan Tasks section). */
export function parseTodosJson(raw: string): TodoParsed | null {
  try {
    const data = JSON.parse(raw) as unknown
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null
    const todos = (data as { todos?: unknown }).todos
    if (!Array.isArray(todos)) return null
    const items: TodoItem[] = []
    for (const entry of todos) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
      const row = entry as { id?: unknown; content?: unknown; status?: unknown }
      if (typeof row.content !== 'string' || !row.content.trim()) continue
      items.push({
        ...(typeof row.id === 'string' && row.id ? { id: row.id } : {}),
        status: normalizeStatus(row.status),
        content: row.content.trim()
      })
    }
    const done = items.filter((item) => item.status === 'completed').length
    return { done, total: items.length, items }
  } catch {
    return null
  }
}

export function parseTodoData(tool: UiToolRow): TodoParsed {
  const content = tool.content ?? ''
  const lines = content.split('\n').filter(Boolean)

  let done = 0
  let total = 0
  let progressIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const progressMatch = lines[i]!.match(PROGRESS_RE)
    if (!progressMatch) continue
    done = Number(progressMatch[1])
    total = Number(progressMatch[2])
    progressIndex = i
    break
  }

  const items: TodoItem[] = []
  for (let i = 0; i < lines.length; i++) {
    if (i === progressIndex) continue
    const withId = lines[i]!.match(ITEM_WITH_ID_RE)
    if (withId) {
      const status = STATUS_MAP[withId[1]!] ?? 'pending'
      items.push({ id: withId[2], status, content: withId[3]! })
      continue
    }
    const match = lines[i]!.match(ITEM_RE)
    if (!match) continue
    const status = STATUS_MAP[match[1]!] ?? 'pending'
    items.push({ status, content: match[2]! })
  }

  return { done, total, items }
}
