import type { GitLogEntry, GitStatus, HomeActivityResult, PrView, TaskFileStat } from './ipc'
import { formatUsdCost } from './utils/costDisplay'
import type { ViewBlock, ViewBlockOf } from './viewSpec'

/*
  A live block's source, read by the app, drawn as an ordinary block. Pure:
  each takes what one bridge call returned and the block the view asked for,
  and returns the block to draw — or a note saying why there is nothing.
  Every figure here comes from that read; none from the model.
*/

const DEFAULT_LIMIT = 12

type Live = ViewBlockOf<'live'>

const note = (text: string, tone: 'muted' | 'danger' = 'muted'): ViewBlockOf<'note'> => ({ type: 'note', text, tone })

function splitPath(path: string): { lead?: string; title: string } {
  const p = path.replace(/\\/g, '/')
  const cut = p.lastIndexOf('/')
  return cut > 0 ? { lead: p.slice(0, cut + 1), title: p.slice(cut + 1) } : { title: p }
}

const more = (shown: number, total: number): string | undefined => (total > shown ? `${total - shown} more` : undefined)

const STATUS_WORD: Record<GitStatus['files'][number]['status'], string | undefined> = {
  modified: undefined,
  added: 'new',
  untracked: 'new',
  deleted: 'deleted',
  conflicted: 'conflict'
}

/** git.changes: the uncommitted files, biggest change first; a click opens the diff. */
export function changesBlock(status: GitStatus, live: Live): ViewBlock {
  const files = [...status.files].sort((a, b) => b.added + b.removed - (a.added + a.removed) || a.path.localeCompare(b.path))
  if (files.length === 0) return note('Nothing uncommitted', 'muted')
  const limit = live.limit ?? DEFAULT_LIMIT
  const shown = files.slice(0, limit)
  return {
    type: 'rows',
    title: live.title ?? 'Uncommitted',
    items: shown.map((f) => ({
      id: f.path,
      ...splitPath(f.path),
      meta: [STATUS_WORD[f.status], f.staged && !f.unstaged ? 'staged' : undefined, f.binary ? 'binary' : undefined].filter(Boolean).join(' · ') || undefined,
      ...(f.binary ? {} : { diff: { add: f.added, del: f.removed } }),
      path: f.path,
      ...(f.status === 'deleted' ? {} : { do: { action: 'diff' as const, path: f.path } })
    })),
    more: more(shown.length, status.truncated ? status.fileCount : files.length),
    total: status.truncated ? status.fileCount : files.length
  }
}

/** git.branch: where the branch stands. */
export function branchBlock(status: GitStatus): ViewBlock {
  const count = status.truncated ? status.fileCount : status.files.length
  const items: ViewBlockOf<'stats'>['items'] = [
    { id: 'branch', label: 'Branch', value: status.branch ?? 'detached', hint: status.upstream },
    { id: 'changed', label: 'Changed files', value: String(count), hint: count > 0 ? `+${status.added} −${status.removed}` : undefined }
  ]
  if (status.ahead != null) items.push({ id: 'ahead', label: 'Ahead', value: String(status.ahead), tone: status.ahead > 0 ? 'accent' : undefined, hint: status.ahead > 0 ? 'not pushed' : undefined })
  if (status.behind != null) items.push({ id: 'behind', label: 'Behind', value: String(status.behind), tone: status.behind > 0 ? 'danger' : undefined, hint: status.behind > 0 ? 'to pull' : undefined })
  if (!status.upstream && status.hasCommits) items.push({ id: 'remote', label: 'Upstream', value: 'none', hint: status.hasRemote ? 'not published' : 'no remote' })
  return { type: 'stats', items }
}

/** git.commits: the latest commits, newest first; a click opens the commit's files. */
export function commitsBlock(log: readonly GitLogEntry[], live: Live): ViewBlock {
  if (log.length === 0) return note('No commits yet')
  const shown = log.slice(0, live.limit ?? 8)
  return {
    type: 'table',
    title: live.title ?? 'Recent commits',
    columns: [
      { id: 'sha', label: 'Commit' },
      { id: 'subject', label: 'Subject' },
      { id: 'author', label: 'Author' },
      { id: 'when', label: 'When', align: 'end' }
    ],
    rows: shown.map((c) => ({
      id: c.sha,
      cells: { sha: c.shortSha, subject: c.subject, author: c.author, when: c.relativeDate },
      do: { action: 'commit' as const, sha: c.sha }
    }))
  }
}

/** One GitHub check's state, in the checks block's words. */
export function checkState(c: PrView['checks'][number]): 'pass' | 'fail' | 'running' | 'pending' {
  const conclusion = (c.conclusion ?? '').toUpperCase()
  const state = c.state.toUpperCase()
  if (['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(conclusion) || state === 'SUCCESS') return 'pass'
  if (['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'].includes(conclusion) || state === 'FAILURE' || state === 'ERROR')
    return 'fail'
  if (state === 'IN_PROGRESS' || state === 'PENDING') return 'running'
  return 'pending'
}

/** The most checks a live block lists; the count beside its title still covers all of them. */
const CHECKS_SHOWN_MAX = 20

/**
 * pr.checks: the branch's pull request's checks, failures first. Past the
 * limit only passing ones are left out, and "N more passed" says so: a
 * failing or running check is never the one cut.
 */
export function checksBlock(pr: PrView, live: Live): ViewBlock {
  if (pr.checks.length === 0) return note(`#${pr.number} has no checks`)
  const order = { fail: 0, running: 1, pending: 2, pass: 3 } as const
  // Two workflows may each have a job named "build": each keeps its own row.
  const seen = new Map<string, number>()
  const all = pr.checks
    .map((c) => {
      const n = (seen.get(c.name) ?? 0) + 1
      seen.set(c.name, n)
      return { id: n === 1 ? c.name : `${c.name}\u0000${n}`, label: c.name, state: checkState(c) }
    })
    .sort((a, b) => order[a.state] - order[b.state] || a.label.localeCompare(b.label))
  const limit = Math.min(live.limit ?? CHECKS_SHOWN_MAX, CHECKS_SHOWN_MAX)
  const open = all.filter((c) => c.state !== 'pass').length
  const items = all.slice(0, Math.max(limit, Math.min(open, CHECKS_SHOWN_MAX)))
  const passed = all.length - open
  const hidden = all.length - items.length
  return {
    type: 'checks',
    title: live.title ?? `Checks on #${pr.number}`,
    items,
    total: all.length,
    passed,
    ...(hidden > 0 ? { more: `${hidden} more ${all.slice(items.length).every((c) => c.state === 'pass') ? 'passed' : 'not shown'}` } : {})
  }
}

const ACTION_WORD = { created: 'new', modified: undefined, deleted: 'deleted' } as const

/** task.changes: the files this task wrote, as they stand now. */
export function taskChangesBlock(files: readonly TaskFileStat[], live: Live): ViewBlock {
  if (files.length === 0) return note('This task has not changed any files')
  const shown = files.slice(0, live.limit ?? DEFAULT_LIMIT)
  return {
    type: 'rows',
    title: live.title ?? 'Changed by this task',
    items: shown.map((f) => ({
      id: f.path,
      ...splitPath(f.path),
      meta: ACTION_WORD[f.action],
      ...(f.add != null && f.del != null ? { diff: { add: f.add, del: f.del } } : {}),
      path: f.path,
      ...(f.action === 'deleted' ? {} : { do: { action: 'diff' as const, path: f.path } })
    })),
    more: more(shown.length, files.length),
    total: files.length
  }
}

/** A day's spend: the bill where one was reported, else the estimate. */
const dayCost = (d: HomeActivityResult['days'][number]): number => (d.billedCost ?? 0) + (d.estimatedCost ?? 0)

/** The local calendar day, as the activity read keys it. */
export function localDayKey(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`
}

function daysBack(now: Date, n: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() - n)
  return localDayKey(d)
}

/** usage.spend: today, the last 7 days and the last 30, from a 30-day read. */
export function spendBlock(activity: HomeActivityResult, now = new Date()): ViewBlock {
  const sum = (fromDay: string): number => activity.days.filter((d) => d.date >= fromDay).reduce((s, d) => s + dayCost(d), 0)
  const runs = (fromDay: string): number => activity.days.filter((d) => d.date >= fromDay).reduce((s, d) => s + d.runs, 0)
  const today = localDayKey(now)
  const week = daysBack(now, 6)
  const month = daysBack(now, 29)
  const stat = (id: string, label: string, from: string): ViewBlockOf<'stats'>['items'][number] => {
    const n = runs(from)
    return { id, label, value: formatUsdCost(sum(from)), hint: `${n} ${n === 1 ? 'run' : 'runs'}` }
  }
  return { type: 'stats', items: [stat('today', 'Today', today), stat('week', 'Last 7 days', week), stat('month', 'Last 30 days', month)] }
}

/** usage.days: one bar per day for the last 14, an empty day a zero. */
export function daysBlock(activity: HomeActivityResult, live: Live, now = new Date()): ViewBlock {
  const n = Math.min(live.limit ?? 14, 30)
  const byDay = new Map(activity.days.map((d) => [d.date, dayCost(d)]))
  const keys = Array.from({ length: n }, (_, i) => daysBack(now, n - 1 - i))
  // A row of empty bars reads as a chart that failed to draw.
  if (keys.every((k) => (byDay.get(k) ?? 0) === 0)) return note(`No spend in the last ${n} days`)
  const short = (key: string): string => {
    const [, m, d] = key.split('-')
    return `${Number(d)}/${Number(m)}`
  }
  return {
    type: 'chart',
    spec: { type: 'bar', title: live.title ?? `Spend per day, last ${n} days`, labels: keys.map(short), values: keys.map((k) => Number((byDay.get(k) ?? 0).toFixed(4))) }
  }
}
