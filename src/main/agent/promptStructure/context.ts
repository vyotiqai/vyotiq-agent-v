import { existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { contentDisplayText, type ChatMessage } from '../../../shared/ipc'
import type { PromptStructureMention } from '../../../shared/ipc/schemas/promptStructure'
import { logger } from '../../../shared/logger'
import { readWorkspaceRules } from '../context/rules'
import { memoryRoot } from '../context/memory'
import { listRuns, loadMessagesWindowAsync } from '../state'
import { readWorkspaceEntriesCached, FILE_LIST_WALK_CAP } from '../../workspace/fileListCache'
import { capAtLine, chunkMarkdown, overlapScore, selectRelevant, significantTerms } from './relevance'

/**
 * What the structurer is shown besides the instruction. Every source has its
 * own budget and is cut to what bears on this one request — a request about
 * the composer gets the composer's rules, not the whole CLAUDE.md — so the
 * call stays a few thousand tokens however big the workspace is.
 */

export const STRUCTURE_BUDGETS = {
  rules: 7_000,
  memory: 3_500,
  pastTasks: 1_500,
  thread: 5_000,
  repo: 2_000,
  relevantPaths: 2_500,
  scripts: 2_000
} as const

/** A cold walk of a huge tree can take seconds; past this the brief goes without it. */
const WALK_WAIT_MS = 4_000

export type PackageManager = 'pnpm' | 'npm' | 'yarn' | 'bun'

/** What the brief may name: checked after the model writes it. */
export type StructureKnown = {
  files: readonly string[]
  dirs: readonly string[]
  packageManager: PackageManager | null
  scripts: ReadonlySet<string>
  makeTargets: ReadonlySet<string>
  justRecipes: ReadonlySet<string>
  /** The rules' own text: a command a rule names may be named again. */
  rulesText: string
}

export type StructureContext = {
  rules: string
  memory: string
  pastTasks: string
  thread: string
  repo: string
  relevantPaths: string
  scripts: string
  known: StructureKnown
}

export type GatherInput = {
  workspacePath: string
  text: string
  mentions: readonly PromptStructureMention[]
  runId?: string
}

async function settle<T>(what: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run()
  } catch (err) {
    logger.warn(`Structure context: ${what} unavailable`, { scope: 'agent', err })
    return fallback
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      () => {
        clearTimeout(timer)
        resolve(null)
      }
    )
  })
}

// ── Rules ─────────────────────────────────────────────────────────────────

/** The rule sections that bear on the request; the rest named in one line, so the model knows they exist. */
export function formatRules(files: ReadonlyArray<{ path: string; content: string }>, query: ReadonlySet<string>): string {
  if (files.length === 0) return ''
  const all = files.flatMap((file, f) =>
    chunkMarkdown(file.content).map((chunk, c) => ({ ...chunk, path: file.path, key: `${f}:${c}` }))
  )
  const picked = selectRelevant(all, query, STRUCTURE_BUDGETS.rules - 600)
  const shown = new Set(picked.map((c) => c.key))
  const out: string[] = []
  for (const file of files) {
    const body = picked.filter((c) => c.path === file.path).map((c) => c.text)
    const others = all.filter((c) => c.path === file.path && c.heading && !shown.has(c.key)).map((c) => c.heading!)
    if (body.length === 0 && others.length === 0) continue
    out.push(`### ${file.path}`)
    if (body.length) out.push(body.join('\n\n'))
    if (others.length) out.push(capAtLine(`(Other sections, not shown: ${others.join('; ')})`, 400))
  }
  return out.join('\n\n')
}

// ── Memory ────────────────────────────────────────────────────────────────

/** `notes/x.md` in a memory line, as the note's name: the path is relative to memory, not the workspace. */
const MEMORY_LINK_RE = /\[([^\]]+)\]\(\s*notes\/([a-zA-Z0-9._-]+)\.md\s*\)/g

function memoryLineForPrompt(line: string): string {
  return line.replace(MEMORY_LINK_RE, '$1')
}

/**
 * Index lines that match, plus the one or two notes they point at most
 * strongly. Shown by name, never by path: a brief that cited `notes/x.md`
 * sent the agent to a workspace path that does not exist (the note is under
 * memory's own folder, read with the memory tools).
 */
export async function readRelevantMemory(workspacePath: string, query: ReadonlySet<string>): Promise<string> {
  const root = memoryRoot(workspacePath)
  const indexPath = join(root, 'index.md')
  if (!existsSync(indexPath)) return ''
  const index = await readFile(indexPath, 'utf8')
  const lines = index
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
  if (lines.length === 0) return ''
  const scored = lines.map((line, i) => ({ line, i, score: overlapScore(query, line) }))
  const matched = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i)
  // Nothing matches: the newest few, which are what the agent learned last.
  const chosen = (matched.length ? matched.slice(0, 12) : scored.slice(-6)).sort((a, b) => a.i - b.i)
  const parts = [chosen.map((s) => memoryLineForPrompt(s.line)).join('\n')]
  let room = STRUCTURE_BUDGETS.memory - parts[0]!.length
  for (const strong of matched.filter((s) => s.score >= 2).slice(0, 2)) {
    const name = /\]\(\s*notes\/([a-zA-Z0-9._-]+)\.md\s*\)/.exec(strong.line)?.[1]
    if (!name || room < 400) continue
    const note = await readFile(join(root, 'notes', `${name}.md`), 'utf8').catch(() => '')
    if (!note.trim()) continue
    const excerpt = capAtLine(note.trim(), Math.min(1_400, room - 40))
    parts.push(`--- Memory note "${name}"\n${excerpt}`)
    room -= excerpt.length + name.length + 22
  }
  return capAtLine(parts.join('\n\n'), STRUCTURE_BUDGETS.memory)
}

// ── Past tasks ────────────────────────────────────────────────────────────

export function formatPastTasks(
  runs: ReadonlyArray<{ runId: string; goal?: string; status: string; updatedAt: string }>,
  query: ReadonlySet<string>,
  currentRunId?: string
): string {
  const lines = runs
    .filter((r) => r.runId !== currentRunId && r.goal?.trim())
    .map((r, i) => ({ r, i, score: overlapScore(query, r.goal!) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, 6)
    .map(({ r }) => {
      const goal = r.goal!.replace(/\s+/g, ' ').trim()
      const short = goal.length > 160 ? `${goal.slice(0, 159)}…` : goal
      const outcome = r.status === 'done' ? 'finished' : r.status === 'error' ? 'failed' : r.status
      return `- ${short} — ${outcome}, ${r.updatedAt.slice(0, 10)}`
    })
  return capAtLine(lines.join('\n'), STRUCTURE_BUDGETS.pastTasks)
}

// ── Thread ────────────────────────────────────────────────────────────────

function clip(text: string, max: number): string {
  const flat = text.trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/**
 * The task so far, oldest first: what you asked, and the answer each turn
 * ended on (not every step's notes). Recent turns win the budget.
 */
export function formatThread(messages: readonly ChatMessage[]): string {
  const turns: Array<{ who: 'You' | 'Agent'; text: string }> = []
  for (const m of messages) {
    if (m.role === 'user' && !m.synthetic) {
      const text = contentDisplayText(m.content)
      if (text.trim()) turns.push({ who: 'You', text: clip(text, 700) })
    } else if (m.role === 'assistant') {
      const text = contentDisplayText(m.content)
      if (!text.trim()) continue
      const entry = { who: 'Agent' as const, text: clip(text, 900) }
      // Only a turn's last words: the answer, not the narration on the way.
      if (turns.at(-1)?.who === 'Agent') turns[turns.length - 1] = entry
      else turns.push(entry)
    }
  }
  const out: string[] = []
  let room = STRUCTURE_BUDGETS.thread
  for (const turn of turns.slice(-8).reverse()) {
    const line = `[${turn.who}] ${turn.text}`
    if (line.length > room) break
    out.unshift(line)
    room -= line.length + 1
  }
  return out.join('\n')
}

// ── Repo shape ────────────────────────────────────────────────────────────

const LOW_SIGNAL_PATH_RE =
  /(?:^|\/)(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|cargo\.lock|go\.sum|poetry\.lock|uv\.lock)$|\.min\.(?:js|css)$|\.map$|\.snap$/i

/** Top-level folders by size, the biggest ones' subfolders, top-level files, and the languages in use. */
export function formatRepoShape(files: readonly string[], capped: boolean): string {
  if (files.length === 0) return ''
  const topDirs = new Map<string, number>()
  const topFiles: string[] = []
  const subDirs = new Map<string, Map<string, number>>()
  const exts = new Map<string, number>()
  for (const file of files) {
    const parts = file.split('/')
    if (parts.length === 1) topFiles.push(file)
    else {
      topDirs.set(parts[0]!, (topDirs.get(parts[0]!) ?? 0) + 1)
      if (parts.length > 2) {
        const sub = subDirs.get(parts[0]!) ?? new Map<string, number>()
        sub.set(parts[1]!, (sub.get(parts[1]!) ?? 0) + 1)
        subDirs.set(parts[0]!, sub)
      }
    }
    const ext = /\.([a-z0-9]{1,8})$/i.exec(parts.at(-1)!)?.[1]?.toLowerCase()
    if (ext && !LOW_SIGNAL_PATH_RE.test(file)) exts.set(ext, (exts.get(ext) ?? 0) + 1)
  }
  const byCount = (m: Map<string, number>): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1])
  const lines: string[] = [`${files.length}${capped ? '+' : ''} files.`]
  const dirs = byCount(topDirs).slice(0, 15)
  if (dirs.length) lines.push(`Top-level folders: ${dirs.map(([d, n]) => `${d}/ (${n})`).join(', ')}`)
  for (const [dir] of dirs.slice(0, 3)) {
    const subs = byCount(subDirs.get(dir) ?? new Map()).slice(0, 10)
    if (subs.length) lines.push(`  ${dir}/: ${subs.map(([s, n]) => `${s}/ (${n})`).join(', ')}`)
  }
  if (topFiles.length) lines.push(`Top-level files: ${topFiles.slice(0, 20).join(', ')}`)
  const langs = byCount(exts).slice(0, 8)
  if (langs.length) lines.push(`File types: ${langs.map(([e, n]) => `.${e} ${n}`).join(', ')}`)
  return capAtLine(lines.join('\n'), STRUCTURE_BUDGETS.repo)
}

/** Files and folders whose names share words with the request — real places the brief can point to. */
export function formatRelevantPaths(
  files: readonly string[],
  dirs: readonly string[],
  query: ReadonlySet<string>,
  mentionPaths: readonly string[]
): string {
  if (query.size === 0 && mentionPaths.length === 0) return ''
  const need = query.size <= 2 ? 1 : 2
  const rank = (paths: readonly string[], limit: number): string[] =>
    paths
      .filter((p) => !LOW_SIGNAL_PATH_RE.test(p))
      .map((p, i) => {
        const base = p.slice(p.lastIndexOf('/') + 1)
        return { p, i, score: overlapScore(query, p) + overlapScore(query, base) }
      })
      .filter((s) => s.score >= need)
      .sort((a, b) => b.score - a.score || a.p.length - b.p.length || a.i - b.i)
      .slice(0, limit)
      .map((s) => s.p)
  const picked = [...new Set([...mentionPaths, ...rank(dirs, 10).map((d) => `${d}/`), ...rank(files, 25)])]
  return capAtLine(picked.join('\n'), STRUCTURE_BUDGETS.relevantPaths)
}

// ── Scripts ───────────────────────────────────────────────────────────────

export function detectPackageManager(files: readonly string[], workspacePath: string): PackageManager | null {
  const has = (name: string): boolean => files.includes(name) || existsSync(join(workspacePath, name))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('yarn.lock')) return 'yarn'
  if (has('bun.lockb') || has('bun.lock')) return 'bun'
  if (has('package-lock.json') || has('package.json')) return 'npm'
  return null
}

/** How this workspace runs a package script. */
export function scriptCommand(pm: PackageManager, name: string): string {
  return pm === 'npm' ? (name === 'test' ? 'npm test' : `npm run ${name}`) : `${pm} ${name}`
}

export function parseMakeTargets(makefile: string): string[] {
  const out = new Set<string>()
  for (const m of makefile.matchAll(/^([A-Za-z0-9][\w.-]*)\s*:(?!=)/gm)) {
    if (!m[1]!.startsWith('.')) out.add(m[1]!)
  }
  return [...out]
}

export function parseJustRecipes(justfile: string): string[] {
  const out = new Set<string>()
  // A recipe's parameters may have defaults (`build target="x":`); `name := value` is a variable.
  for (const m of justfile.matchAll(/^@?([A-Za-z_][\w-]*)(?:\s+[^:\n]*)?:(?!=)/gm)) out.add(m[1]!)
  return [...out]
}

type Scripts = { text: string; pm: PackageManager | null; scripts: string[]; make: string[]; just: string[] }

async function readScripts(workspacePath: string, files: readonly string[]): Promise<Scripts> {
  const pm = detectPackageManager(files, workspacePath)
  const lines: string[] = []
  let scripts: string[] = []
  const pkgRaw = await readFile(join(workspacePath, 'package.json'), 'utf8').catch(() => null)
  if (pkgRaw && pm) {
    try {
      const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, unknown> }
      const entries = Object.entries(pkg.scripts ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string')
      scripts = entries.map(([name]) => name)
      if (entries.length) {
        lines.push(`Package manager: ${pm}. Scripts:`)
        for (const [name, cmd] of entries.slice(0, 40)) {
          lines.push(`- \`${scriptCommand(pm, name)}\` → ${cmd.length > 120 ? `${cmd.slice(0, 119)}…` : cmd}`)
        }
      }
    } catch {
      // A package.json that does not parse names no scripts.
    }
  }
  const makefile = await readFile(join(workspacePath, 'Makefile'), 'utf8').catch(() => null)
  const make = makefile ? parseMakeTargets(makefile) : []
  if (make.length) lines.push(`Make targets: ${make.slice(0, 30).map((t) => `\`make ${t}\``).join(', ')}`)
  const justfile = await readFile(join(workspacePath, 'justfile'), 'utf8').catch(() => null)
  const just = justfile ? parseJustRecipes(justfile) : []
  if (just.length) lines.push(`just recipes: ${just.slice(0, 30).map((t) => `\`just ${t}\``).join(', ')}`)
  return { text: capAtLine(lines.join('\n'), STRUCTURE_BUDGETS.scripts), pm, scripts, make, just }
}

// ── All of it ─────────────────────────────────────────────────────────────

export async function gatherStructureContext(input: GatherInput): Promise<StructureContext> {
  const { workspacePath, text, mentions, runId } = input
  const query = significantTerms(text)
  const mentionPaths = mentions.map((m) => m.path).filter((p): p is string => Boolean(p))

  const [ruleFiles, memory, runs, messages, entries] = await Promise.all([
    settle('rules', () => readWorkspaceRules(workspacePath), [] as Array<{ path: string; content: string }>),
    settle('memory', () => readRelevantMemory(workspacePath, query), ''),
    settle('past tasks', async () => (await listRuns(workspacePath)).runs, [] as Awaited<ReturnType<typeof listRuns>>['runs']),
    runId
      ? settle('thread', async () => (await loadMessagesWindowAsync(workspacePath, runId, { limit: 40 })).messages, [] as ChatMessage[])
      : Promise.resolve([] as ChatMessage[]),
    settle('file list', () => withTimeout(readWorkspaceEntriesCached(workspacePath), WALK_WAIT_MS), null)
  ])
  const files = entries?.files ?? []
  const dirs = entries?.dirs ?? []
  const walkCapped = files.length >= FILE_LIST_WALK_CAP
  const scripts = await settle(
    'scripts',
    () => readScripts(workspacePath, files),
    { text: '', pm: null, scripts: [], make: [], just: [] } as Scripts
  )

  return {
    rules: formatRules(ruleFiles, query),
    memory,
    pastTasks: formatPastTasks(runs, query, runId),
    thread: formatThread(messages),
    repo: formatRepoShape(files, walkCapped),
    relevantPaths: formatRelevantPaths(files, dirs, query, mentionPaths),
    scripts: scripts.text,
    known: {
      files,
      dirs,
      packageManager: scripts.pm,
      scripts: new Set(scripts.scripts),
      makeTargets: new Set(scripts.make),
      justRecipes: new Set(scripts.just),
      rulesText: ruleFiles.map((f) => f.content).join('\n')
    }
  }
}
