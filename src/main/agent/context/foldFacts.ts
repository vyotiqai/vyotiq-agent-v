import type { ChatMessage } from '../../../shared/ipc'
import { contentToText } from '../../../shared/ipc'
import { canonicalizeAgentToolName } from '../schemas/tools'
import { readPathArg } from '../tools/argAccess'
import { parseSerializedTodoContent, type TodoItem } from '../tools/todo'
import { extractAskQuestionDecisions } from './retainedDecisions'

/** Deterministic facts taken from the folded prefix — ground truth for the summarizer. */
export type FoldFacts = {
  /** Inspected, edited, or deleted workspace paths mentioned in tool calls or prose. */
  files: string[]
  /** Successful write/delete paths that must survive the fold. */
  wroteFiles: string[]
  /** ask_question answers from the folded prefix. */
  decisions: string[]
  /** Open (pending / in_progress) todo titles. */
  todos: string[]
  /** Custom contract.md done-when bullets (boilerplate stubs omitted). */
  doneWhen: string[]
  /**
   * User-stated constraints from the folded prefix (do-not / never / must).
   * Optional on older call sites; extractFoldFacts always fills it.
   */
  constraints?: string[]
  /** Distinctive contract.md goal, when present. */
  contractGoal?: string
}

export type FoldFactsExtras = {
  /** Raw contract.md from the run dir. */
  contract?: string
  /** todos.json items from the run dir. */
  todos?: readonly TodoItem[]
}

const WRITE_TOOLS = new Set(['edit', 'str_replace', 'delete', 'edit_notebook'])
const INSPECT_TOOLS = new Set([
  'read',
  'list_dir',
  'grep',
  'glob',
  'search',
  'codebase_search',
  'memory_read',
  'memory_write'
])

const GENERIC_CONTRACT_GOALS = new Set(['chat', 'chat.', 'test', 'test goal'])
const BOILERPLATE_DONE_WHEN =
  /goal above is satisfied|blockers are explained|update this file if scope/i

const PATH_TOKEN_RE =
  /(?:^|[\s`"'([<])((?:[\w.-]+\/)+[\w.-]+\.[A-Za-z][\w.-]*|[\w.-]+\.[A-Za-z][\w.-]{1,12})/g
const BACKTICK_RE = /`([^`]+)`/g

function normalizeRelPath(path: string): string {
  const n = path.trim().replace(/\\/g, '/')
  if (!n || n === '/') return n
  return n.replace(/\/+$/, '')
}

function isConcretePath(value: string): boolean {
  const path = normalizeRelPath(value)
  if (!path || path === '.' || path === '..') return false
  if (/[*?[{]/.test(path)) return false
  return true
}

const SOURCE_EXT_RE =
  /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|json|md|mdc|txt|yml|yaml|toml|css|scss|less|html|astro|vue|svelte|ps1|lock|svg|png|gif|jpe?g|webp|ico|map|wasm|env|sql|py|rs|go|java|kt|kts|swift|rb|php|cs|cpp|cxx|h|hpp|c|mm|xml|ini|cfg|conf|sh|bash|zsh|bat|cmd|ttf|woff2?)$/i
const DOTFILE_RE = /^\.[A-Za-z0-9][\w.-]*$/
const IDENTIFIER_STEM_RE =
  /^(?:process|import|logger|console|module|globalThis|window|document)\./

/** Same bar as receipt/loop path tracking — skip globs, dirs, and junk tokens. */
export function isPlausibleWorkspaceFilePath(value: string): boolean {
  const path = normalizeRelPath(value)
  if (!isConcretePath(path)) return false
  if (/\s/.test(path)) return false
  if (path.includes(',')) return false
  if (/^[=+-]+$/.test(path)) return false
  if (path.startsWith('--')) return false
  if (path.startsWith('@')) return false
  if (path === '/' || /^\/+$/.test(path)) return false
  if (/:\d+$/.test(path)) return false
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(path) && !/^[A-Za-z]:\//.test(path)) return false
  if (path.includes(')') && !path.includes('(')) return false
  if (!/[A-Za-z0-9]/.test(path.replace(/[./\\_-]/g, ''))) return false
  const base = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  if (IDENTIFIER_STEM_RE.test(base) || IDENTIFIER_STEM_RE.test(path)) return false
  if (!(DOTFILE_RE.test(base) || SOURCE_EXT_RE.test(base))) return false
  return true
}

export function normalizeWorkspaceRelPath(path: string): string {
  return normalizeRelPath(path)
}

function parseArgs(argumentsJson: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(argumentsJson)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // ignore malformed args
  }
  return {}
}

function addPath(into: Set<string>, raw: string | null | undefined): void {
  if (!raw) return
  const path = normalizeRelPath(raw)
  if (!isPlausibleWorkspaceFilePath(path)) return
  into.add(path)
}

function pathsFromCall(name: string, args: Record<string, unknown>): string[] {
  const out: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === 'string' && value.trim()) out.push(value)
  }
  if (name === 'grep') {
    push(typeof args.include === 'string' ? args.include : args.path)
    return out
  }
  if (name === 'glob') {
    push(args.pattern)
    return out
  }
  const aliased = readPathArg(args)
  if (aliased) push(aliased)
  return out
}

/** Path-like tokens in prose (backticks and `dir/file.ext`). Skips tool dumps. */
export function collectPathsFromText(text: string): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const push = (raw: string): void => {
    const path = normalizeRelPath(raw.replace(/^[*_`]+|[*_`]+$/g, ''))
    if (!isPlausibleWorkspaceFilePath(path)) return
    const key = path.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    out.push(path)
  }
  for (const match of text.matchAll(BACKTICK_RE)) {
    push(match[1] ?? '')
  }
  PATH_TOKEN_RE.lastIndex = 0
  let token: RegExpExecArray | null
  while ((token = PATH_TOKEN_RE.exec(text))) {
    push(token[1] ?? '')
  }
  return out
}

/** First distinctive ## Goal line from contract.md. Generic stubs like "chat" are ignored. */
export function parseContractGoal(contract: string): string | undefined {
  const lines = contract.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+Goal\s*$/i.test(line.trim()))
  if (start < 0) return undefined
  const parts: string[] = []
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (/^##\s+/.test(line)) break
    if (line) parts.push(line)
  }
  const goal = parts.join(' ').replace(/\s+/g, ' ').trim()
  if (goal.length < 8) return undefined
  if (GENERIC_CONTRACT_GOALS.has(goal.toLowerCase())) return undefined
  return goal.slice(0, 240)
}

/** Custom ## Done when bullets from contract.md. Default createRun stubs are ignored. */
export function parseContractDoneWhen(contract: string): string[] {
  const lines = contract.split(/\r?\n/)
  const start = lines.findIndex((line) => /^##\s+Done when\s*$/i.test(line.trim()))
  if (start < 0) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (/^##\s+/.test(line)) break
    const bullet = line.match(/^[-*]\s+(.+)$/)
    const text = (bullet?.[1] ?? line).replace(/\s+/g, ' ').trim()
    if (!text || text === '(none)') continue
    if (BOILERPLATE_DONE_WHEN.test(text)) continue
    if (seen.has(text)) continue
    seen.add(text)
    out.push(text.slice(0, 240))
  }
  return out
}

function openTodoTitles(items: readonly TodoItem[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of items) {
    if (item.status !== 'pending' && item.status !== 'in_progress') continue
    const title = item.content.replace(/\s+/g, ' ').trim()
    if (!title || seen.has(title)) continue
    seen.add(title)
    out.push(title.slice(0, 240))
  }
  return out
}

function todosFromMessages(messages: readonly ChatMessage[]): string[] {
  let last: string | null = null
  for (const msg of messages) {
    if (msg.role !== 'tool' || msg.toolName !== 'todo_write') continue
    if (msg.ok === false) continue
    const text = contentToText(msg.content).trim()
    if (text) last = text
  }
  if (!last) return []
  return openTodoTitles(parseSerializedTodoContent(last))
}

const CONSTRAINT_CUE =
  /\b(do not|don't|never|must not|must never|mustn't|always|avoid|without|keep (?:diffs?|secrets?|this)|do not mention|never commit|must use)\b/i

function clipFact(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}

/** Constraint-bearing sentences from user turns. Tool dumps and assistant prose are ignored. */
export function extractUserConstraints(messages: readonly ChatMessage[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const msg of messages) {
    if (msg.role !== 'user') continue
    const text = contentToText(msg.content).trim()
    if (!text) continue
    const sentences = text.split(/(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean)
    for (const sentence of sentences) {
      if (sentence.length < 12) continue
      if (!CONSTRAINT_CUE.test(sentence)) continue
      const clipped = clipFact(sentence)
      const key = clipped.toLowerCase()
      if (!clipped || seen.has(key)) continue
      seen.add(key)
      out.push(clipped)
      if (out.length >= 32) return out
    }
  }
  return out
}

/** Extract fold facts from the messages that will be summarized (not the keep-recent tail). */
export function extractFoldFacts(
  messages: readonly ChatMessage[],
  extras?: FoldFactsExtras
): FoldFacts {
  const files = new Set<string>()
  const wrote = new Set<string>()
  const successfulCallIds = new Set<string>()

  for (const msg of messages) {
    if (msg.role === 'tool' && msg.toolCallId && msg.ok !== false) {
      successfulCallIds.add(msg.toolCallId)
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'assistant' || !msg.toolCalls) continue
    for (const call of msg.toolCalls) {
      const name = canonicalizeAgentToolName(call.name)
      const args = parseArgs(call.arguments)
      const paths = pathsFromCall(name, args)
      const track = WRITE_TOOLS.has(name) || INSPECT_TOOLS.has(name)
      if (track) {
        for (const path of paths) addPath(files, path)
      }
      if (!successfulCallIds.has(call.id)) continue
      if (!WRITE_TOOLS.has(name)) continue
      for (const path of paths) addPath(wrote, path)
    }
  }

  for (const msg of messages) {
    if (msg.role !== 'user' && msg.role !== 'assistant') continue
    for (const path of collectPathsFromText(contentToText(msg.content))) {
      addPath(files, path)
    }
  }

  const fromDisk = extras?.todos ? openTodoTitles(extras.todos) : []
  const fromMessages = todosFromMessages(messages)
  const todos = [...new Set([...fromDisk, ...fromMessages])].sort()
  const contractGoal = extras?.contract ? parseContractGoal(extras.contract) : undefined
  const doneWhen = extras?.contract ? parseContractDoneWhen(extras.contract) : []

  return {
    files: [...files].sort(),
    wroteFiles: [...wrote].sort(),
    decisions: extractAskQuestionDecisions(messages),
    todos,
    doneWhen,
    constraints: extractUserConstraints(messages),
    ...(contractGoal ? { contractGoal } : {})
  }
}
