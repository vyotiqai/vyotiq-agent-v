import { createReadStream } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { contentToText, type ChatMessage } from '../../shared/ipc'
import type { RunSearchHit, RunSearchRequest, RunSearchResult } from '../../shared/ipc/schemas/runSearch'
import { workspaceSessionsRoot } from '../storage/paths'
import { listMessageArchives } from './messageAppendQueue'

/**
 * Search inside tasks: their titles, then what was said in them — newest task
 * first, one hit per task. Reads the transcript files directly (the live file,
 * then its rotated archives, newest first) with async I/O, so a search never
 * blocks main or waits on a live run's writes. Bounded three ways: results,
 * bytes read per task, and total time; `truncated` says a bound was hit.
 */

const SNIPPET_CHARS = 120
/** The newest part of a long transcript is searched; the start of a very long one may not be. */
export const RUN_SEARCH_BYTES_PER_RUN = 16 * 1024 * 1024
export const RUN_SEARCH_BUDGET_MS = 1500

type RunStatusLite = {
  goal?: unknown
  updatedAt?: unknown
  status?: unknown
  inlineInstance?: unknown
  parentRunId?: unknown
}

type Candidate = {
  workspacePath: string
  runId: string
  dir: string
  goal: string
  updatedAt: string
  status: string
}

async function listCandidates(workspacePaths: readonly string[]): Promise<Candidate[]> {
  const out: Candidate[] = []
  for (const workspacePath of workspacePaths) {
    const root = workspaceSessionsRoot(workspacePath)
    let names: string[]
    try {
      names = await readdir(root)
    } catch {
      continue
    }
    for (const runId of names) {
      const dir = join(root, runId)
      let status: RunStatusLite
      try {
        status = JSON.parse(await readFile(join(dir, 'status.json'), 'utf8')) as RunStatusLite
      } catch {
        continue
      }
      // An instance's words belong to its task, which lists its own summary.
      if (status.inlineInstance === true || typeof status.parentRunId === 'string') continue
      out.push({
        workspacePath,
        runId,
        dir,
        goal: typeof status.goal === 'string' ? status.goal : '',
        updatedAt: typeof status.updatedAt === 'string' ? status.updatedAt : '',
        status: typeof status.status === 'string' ? status.status : 'done'
      })
    }
  }
  return out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}

/** ~120 characters around the match, on one line, with where the match sits in it. */
export function snippetAround(text: string, index: number, length: number): { snippet: string; start: number } {
  const flat = (s: string): string => s.replace(/\s+/g, ' ')
  const before = flat(text.slice(0, index))
  const match = flat(text.slice(index, index + length))
  const after = flat(text.slice(index + length))
  // A third of the room before the match, the rest after it.
  const lead = Math.max(0, Math.floor((SNIPPET_CHARS - match.length) / 3))
  const head = before.length > lead ? `…${before.slice(before.length - lead).trimStart()}` : before.trimStart()
  const room = Math.max(0, SNIPPET_CHARS - lead - match.length)
  const tail = after.length > room ? `${after.slice(0, room).trimEnd()}…` : after.trimEnd()
  return { snippet: `${head}${match}${tail}`, start: head.length }
}

function whereOf(message: ChatMessage): RunSearchHit['where'] | null {
  if (message.role === 'user') return 'you'
  if (message.role === 'assistant') return 'agent'
  if (message.role === 'tool') return 'tool'
  return null
}

/** Lines of one file, newest last, stopping once `budget` bytes were read. */
async function* fileLines(path: string, budget: { bytes: number }): AsyncGenerator<string> {
  let tail = ''
  const stream = createReadStream(path, { encoding: 'utf8', highWaterMark: 256 * 1024 })
  try {
    for await (const chunk of stream as AsyncIterable<string>) {
      budget.bytes -= Buffer.byteLength(chunk)
      const parts = (tail + chunk).split('\n')
      tail = parts.pop() ?? ''
      for (const line of parts) yield line
      if (budget.bytes <= 0) return
    }
    if (tail) yield tail
  } catch {
    // Rotated or removed mid-read: what was read stands.
  } finally {
    stream.destroy()
  }
}

/** The last match in a task's transcript files (newest file first), or null. */
async function searchTranscript(
  candidate: Candidate,
  query: string,
  deadline: number
): Promise<{ hit: Omit<RunSearchHit, keyof Candidate | 'title'> | null; cut: boolean }> {
  const lower = query.toLowerCase()
  // How the query appears inside a JSON string: a cheap test before parsing.
  const escaped = JSON.stringify(query).slice(1, -1).toLowerCase()
  const archives = await listMessageArchives(candidate.dir)
  const files = [join(candidate.dir, 'messages.jsonl'), ...archives.reverse().map((name) => join(candidate.dir, name))]
  const budget = { bytes: RUN_SEARCH_BYTES_PER_RUN }
  for (const file of files) {
    let best: Omit<RunSearchHit, keyof Candidate | 'title'> | null = null
    for await (const line of fileLines(file, budget)) {
      if (Date.now() > deadline) return { hit: best, cut: true }
      if (!line.toLowerCase().includes(escaped)) continue
      let message: ChatMessage & { synthetic?: unknown }
      try {
        message = JSON.parse(line) as ChatMessage & { synthetic?: unknown }
      } catch {
        continue
      }
      if (message.synthetic === true) continue
      const where = whereOf(message)
      if (!where) continue
      const text = contentToText(message.content)
      const index = text.toLowerCase().indexOf(lower)
      if (index < 0) continue
      const { snippet, start } = snippetAround(text, index, query.length)
      // Later lines are newer: keep the last match in the file.
      best = { where, snippet, matchStart: start, matchLength: query.length }
    }
    if (best) return { hit: best, cut: false }
    if (budget.bytes <= 0) return { hit: null, cut: true }
  }
  return { hit: null, cut: false }
}

export async function searchRuns(
  req: RunSearchRequest,
  opts: { budgetMs?: number; isCurrent?: () => boolean } = {}
): Promise<RunSearchResult> {
  const deadline = Date.now() + (opts.budgetMs ?? RUN_SEARCH_BUDGET_MS)
  const query = req.query.trim()
  const lower = query.toLowerCase()
  const candidates = await listCandidates(req.workspacePaths)
  const hits: RunSearchHit[] = []
  let truncated = false
  let scannedRuns = 0
  for (const candidate of candidates) {
    if (hits.length >= req.maxResults) {
      truncated = true
      break
    }
    // A newer query from the same window makes this one moot.
    if (opts.isCurrent && !opts.isCurrent()) break
    if (Date.now() > deadline) {
      truncated = true
      break
    }
    scannedRuns += 1
    const base = {
      workspacePath: candidate.workspacePath,
      runId: candidate.runId,
      title: candidate.goal,
      updatedAt: candidate.updatedAt,
      status: candidate.status
    }
    const titleAt = candidate.goal.toLowerCase().indexOf(lower)
    if (titleAt >= 0) {
      hits.push({ ...base, where: 'title', snippet: candidate.goal, matchStart: titleAt, matchLength: query.length })
      continue
    }
    const { hit, cut } = await searchTranscript(candidate, query, deadline)
    if (hit) hits.push({ ...base, ...hit })
    if (cut) truncated = true
  }
  return { hits, truncated, scannedRuns }
}
