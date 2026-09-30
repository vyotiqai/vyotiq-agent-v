import type { TaskState } from '@renderer/lib/ui'
import {
  DIFFS,
  RECORDS,
  REPO_FILES,
  SECOND_QUESTION,
  TERMINAL_BEFORE,
  type Agent,
  type FileDiff,
  type Item,
  type RecordData,
  type Step,
  type TermRun
} from './data'
import type { State } from './store'

/*
  Everything a surface shows about a task is derived here from the base data
  plus what happened in this session (an approval, an answer, a stop), so the
  list, the record, the header, the side pane and Home can never disagree.
*/

export const taskOf = (s: State, id: string): Agent => s.tasks.find((t) => t.id === id) ?? s.tasks[0]

const isLive = (st: TaskState): boolean => st === 'running' || st === 'needs'

const RESUME_TEXT: Record<string, string> = {
  'search-cache': 'Retrying — checking Redis on 6379 first',
  'legacy-auth': 'Resuming: replacing req.legacyUser in admin.ts'
}

/** The record as it stands now. */
export function recordOf(s: State, id: string): RecordData {
  const base = s.records[id] ?? RECORDS[id]
  if (!base) return { brief: '', checks: [], steps: [] }
  const t = taskOf(s, id)
  const verdict = s.allowed[id]
  const answers = s.answers[id] ?? []
  const steers = s.steers[id] ?? []
  const resumed = s.resumed[id]

  let steps: Step[] = base.steps.map((st) => ({ ...st, items: [...st.items] }))

  // Answers replace the question they answer; the second question follows the first.
  if (answers.length) {
    steps = steps.map((st) => {
      const q = st.items.findIndex((it) => it.k === 'question')
      if (q < 0) return st
      const items: Item[] = [...st.items.slice(0, q), { k: 'you', kind: 'answer', text: answers[0] }]
      if (answers.length === 1) items.push({ k: 'question', n: 2, of: 2, q: SECOND_QUESTION.q, options: [...SECOND_QUESTION.options] })
      else items.push({ k: 'you', kind: 'answer', text: answers[1] })
      return { ...st, items, state: answers.length >= 2 ? 'done' : st.state, summary: answers.length >= 2 ? '2 answers' : st.summary }
    })
    if (answers.length >= 2) {
      const next = steps.findIndex((st) => st.state === 'queued')
      if (next >= 0) steps[next] = { ...steps[next], state: 'running', items: [{ k: 'live', text: 'Writing the usage_events migration' }] }
    }
  }

  // A denied command sends it looking for another way on the same step.
  if (verdict === 'denied') {
    steps = steps.map((st) => (st.state === 'needs' ? { ...st, state: 'running', items: [...st.items, { k: 'live', text: 'Looking for a way that does not touch staging' }] } : st))
  } else if (verdict) {
    steps = steps.map((st) => (st.state === 'needs' ? { ...st, state: 'running' } : st))
  }

  // Resume and Retry pick the stopped or failed step back up.
  if (resumed) {
    steps = steps.map((st) =>
      st.state === 'stopped' || st.state === 'failed'
        ? {
            ...st,
            state: 'running',
            items: [
              ...st.items.filter((it) => it.k !== 'error'),
              { k: 'live', text: RESUME_TEXT[id] ?? (st.state === 'failed' ? 'Retrying the step' : 'Picking up where it stopped') }
            ]
          }
        : st
    )
  }

  // Stopped this session: the live step stops where it is.
  if (t.state === 'stopped') steps = steps.map((st) => (isLive(st.state) ? { ...st, state: 'stopped' } : st))

  // Once it stops working, nothing in the record is still moving.
  if (!isLive(t.state)) {
    const settle = (items: Item[]): Item[] => items.filter((it) => it.k !== 'live').map((it): Item => (it.k === 'cmd' && it.state === 'running' ? { ...it, state: 'stopped' } : it))
    steps = steps.map((st) => ({ ...st, items: settle(st.items) }))
  }

  // Steering lands in the live step, after what it was doing.
  if (steers.length) {
    const live = steps.findIndex((st) => isLive(st.state))
    if (live >= 0) steps[live] = { ...steps[live], items: [...steps[live].items, ...steers.map((text): Item => ({ k: 'you', kind: 'steer', text }))] }
  }

  const setup = base.setup && !isLive(t.state) ? base.setup.filter((it) => it.k !== 'live') : base.setup
  return { ...base, setup, steps }
}

export type Status = { text: string; tone: 'quiet' | 'accent' | 'danger' | 'success'; step?: [number, number] }

/** The header's one word on where the task stands. */
export function statusOf(s: State, id: string): Status {
  const t = taskOf(s, id)
  const r = recordOf(s, id)
  const live = r.steps.findIndex((st) => isLive(st.state))
  const at = (st: TaskState): number => r.steps.findIndex((x) => x.state === st) + 1
  if (t.state === 'needs') return { text: t.ask?.kind === 'question' ? 'Asks you' : 'Wants approval', tone: 'accent', step: live >= 0 ? [live + 1, r.steps.length] : undefined }
  if (t.state === 'running') {
    if (live >= 0) return { text: 'Step', tone: 'quiet', step: [live + 1, r.steps.length] }
    return { text: s.followUps[id]?.length ? 'On your follow-up' : 'Planning', tone: 'quiet' }
  }
  if (t.state === 'failed') return { text: `Failed at step ${at('failed')}`, tone: 'danger' }
  if (t.state === 'stopped') return { text: `Stopped at step ${Math.max(1, at('stopped'))}`, tone: 'quiet' }
  if (t.state === 'review') return { text: 'Ready for review', tone: 'success' }
  if (t.outcome?.kind === 'committed') return { text: `Committed ${t.outcome.sha}`, tone: 'quiet' }
  if (t.outcome?.kind === 'undone') return { text: 'Undone', tone: 'quiet' }
  return { text: 'Kept', tone: 'quiet' }
}

/** The task's changes as they stand; a rerun rewinds them first, so it starts with none. */
export const diffsOf = (s: State, id: string): FileDiff[] => (s.records[id] && RECORDS[id] ? [] : (DIFFS[id] ?? []))

export function totals(diffs: FileDiff[]): { add: number; del: number } {
  return diffs.reduce((n, f) => ({ add: n.add + f.add, del: n.del + f.del }), { add: 0, del: 0 })
}

export type TermEntry = TermRun & { live?: boolean; waiting?: boolean }

/** What the task ran, in order: setup first, then every command in its record. */
export function terminalOf(s: State, id: string): TermEntry[] {
  const out: TermEntry[] = [...(TERMINAL_BEFORE[id] ?? [])]
  const r = recordOf(s, id)
  const verdict = s.allowed[id]
  for (const st of r.steps) {
    for (const it of st.items) {
      if (it.k === 'cmd') out.push({ cmd: it.cmd, exit: it.exit, time: it.state === 'stopped' ? 'stopped' : it.time, out: it.out, live: it.state === 'running' })
      if (it.k === 'approval') {
        if (verdict === 'allowed' || verdict === 'always') out.push({ cmd: it.cmd, time: '', out: ['> acme@ db:migrate', '> drizzle-kit migrate --env staging', '', 'Applying 0043_sessions.sql'], live: true })
        else if (!verdict) out.push({ cmd: it.cmd, time: '', out: [], waiting: true })
      }
    }
  }
  return out
}

export type TreeNode = { path: string; name: string; depth: number; dir: boolean; mark?: 'A' | 'M' | 'D'; open: boolean }

/** The workspace tree with this task's files marked; folders holding a change start open. */
export function treeOf(workspace: string, diffs: FileDiff[], openDirs: Set<string>): TreeNode[] {
  const marks = new Map(diffs.map((f) => [f.path, f.status] as const))
  const files = Array.from(new Set([...(REPO_FILES[workspace] ?? REPO_FILES.acme), ...diffs.map((f) => f.path)])).sort((a, b) => {
    const pa = a.split('/')
    const pb = b.split('/')
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue
      const aDir = i < pa.length - 1
      const bDir = i < pb.length - 1
      if (aDir !== bDir) return aDir ? -1 : 1
      return pa[i].localeCompare(pb[i])
    }
    return pa.length - pb.length
  })
  const changedDirs = new Set<string>()
  for (const f of marks.keys()) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) changedDirs.add(parts.slice(0, i).join('/'))
  }
  const nodes: TreeNode[] = []
  const seen = new Set<string>()
  const isOpen = (dir: string): boolean => (openDirs.has(dir) ? true : openDirs.has(`!${dir}`) ? false : changedDirs.has(dir))
  for (const f of files) {
    const parts = f.split('/')
    let hidden = false
    for (let i = 0; i < parts.length - 1; i++) {
      const dir = parts.slice(0, i + 1).join('/')
      if (hidden) break
      if (!seen.has(dir)) {
        seen.add(dir)
        nodes.push({ path: dir, name: parts[i], depth: i, dir: true, open: isOpen(dir) })
      }
      if (!isOpen(dir)) hidden = true
    }
    if (!hidden) nodes.push({ path: f, name: parts[parts.length - 1], depth: parts.length - 1, dir: false, mark: marks.get(f), open: false })
  }
  return nodes
}

/** Whether the task has a page open in the Browser tab. */
export const hasPage = (id: string): boolean => id === 'pricing-toggle'

/** Tasks the list shows for a scope, archived ones left out. */
export function visibleTasks(s: State): Agent[] {
  return s.tasks.filter((t) => !t.archived && (s.scope === 'all' || t.workspace === s.scope))
}

export const isSettled = (t: Agent): boolean => !['needs', 'running', 'queued', 'paused', 'review'].includes(t.state)
