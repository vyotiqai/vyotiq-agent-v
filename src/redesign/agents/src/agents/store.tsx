import { createContext, useContext, useMemo, type Dispatch } from 'react'
import { pushToast } from '@renderer/lib/ui'
import { AGENTS, RECORDS, SECOND_QUESTION, filesChanged, type Agent, type Effort, type RecordData } from './data'

export const SKINS = ['native', 'default', 'proof', 'bench', 'gild'] as const
export type Skin = (typeof SKINS)[number]
export type Theme = 'light' | 'dark'

export type SceneId =
  | 'running'
  | 'needs'
  | 'question'
  | 'review'
  | 'commit'
  | 'browser'
  | 'instances'
  | 'failed'
  | 'new'
  | 'home'
  | 'inbox'
  | 'usage'
  | 'extensions'
  | 'settings'
  | 'palette'
  | 'models'

export const SCENES: { id: SceneId; label: string; note: string }[] = [
  { id: 'running', label: 'Running', note: 'A task mid-run: the header hairline is the plan, the live step breathes, tests stream in a bordered card, the diff grows on the right.' },
  { id: 'needs', label: 'Needs you', note: 'An approval you can answer from the list, the record or the Inbox. Allow it anywhere and every surface moves with it.' },
  { id: 'question', label: 'Question', note: 'Two questions before it builds: pick with 1–3, Enter continues, or type your own answer in the box.' },
  { id: 'review', label: 'Review', note: 'A finished task. Review leads with the check still open; Keep, Undo and Commit settle it (each with Undo in the toast).' },
  { id: 'commit', label: 'Commit', note: 'The commit message is drafted when Review opens. Edit it, or commit as is.' },
  { id: 'browser', label: 'Browser', note: 'The page the task checked, live. Pick an element (mouse or keyboard) and it rides into the box as context.' },
  { id: 'instances', label: 'Instances', note: 'A task split across three instances. Each is a line under its task; one opens in place of the record with its own work, and Back returns.' },
  { id: 'failed', label: 'Failed', note: 'What broke, in words, where it broke, with Retry and a follow-up that changes the approach.' },
  { id: 'new', label: 'New task', note: 'Where it runs in the header, the brief with its done-when checks, and what the agent will see on the right.' },
  { id: 'home', label: 'All tasks', note: 'Every workspace at once, sorted by what needs you. Approve or answer without leaving the page.' },
  { id: 'inbox', label: 'Inbox', note: 'What changed while you were away: asks first, then results. Answer in place.' },
  { id: 'usage', label: 'Usage', note: 'Tasks, tokens and spend by day, the model mix, and what failed most.' },
  { id: 'extensions', label: 'Extensions', note: 'MCP servers, skills and rules in one list, each with the one control it needs.' },
  { id: 'settings', label: 'Settings', note: 'Rows, not cards. Defaults are quiet; what you changed is in ink with Reset beside it.' },
  { id: 'palette', label: 'Palette', note: 'Ctrl K: tasks first, then actions, then files. Type > for actions only.' },
  { id: 'models', label: 'Model', note: 'Model and effort in one popover. Effort says what it costs before you pick it.' }
]

export type View = 'agent' | 'new' | 'home' | 'settings' | 'usage' | 'extensions'
/** The side pane's six tabs, always there, in this order (Alt 1–6), as in the app's inspector. */
export const WS_TABS = ['review', 'files', 'terminal', 'browser', 'pr', 'plan'] as const
export type WsTab = (typeof WS_TABS)[number]
export type Scope = 'acme' | 'acme-mobile' | 'all'
export type ContextItem = { kind: 'file' | 'element'; label: string }
export type Verdict = 'allowed' | 'always' | 'denied'

export type State = {
  view: View
  agent: string
  scope: Scope
  tasks: Agent[]
  /** Records for tasks started in this session. */
  records: Record<string, RecordData>
  wsOpen: boolean
  wsTab: WsTab
  /** The file open in the Files tab; null shows the tree. */
  file: string | null
  /** The instance open in place of the record; null shows the record. */
  instance: string | null
  sideFull: boolean
  listHidden: boolean
  palette: boolean
  models: boolean
  inbox: boolean
  commit: boolean
  mode: 'Agent' | 'Ask'
  model: string
  effort: Effort
  draft: string
  context: ContextItem[]
  allowed: Record<string, Verdict>
  choice: Record<string, number | null>
  answers: Record<string, string[]>
  queued: Record<string, string[]>
  steers: Record<string, string[]>
  followUps: Record<string, string[]>
  resumed: Record<string, boolean>
  fileMarks: Record<string, 'kept' | 'undone'>
  picking: boolean
  listening: boolean
  homeGroup: 'status' | 'workspace'
  /** Settings → Agent: where a new task starts. New task opens on it. */
  worktreeDefault: boolean
  nextId: number
}

export type Action =
  | { type: 'open'; agent: string }
  | { type: 'view'; view: View }
  | { type: 'scope'; scope: Scope }
  | { type: 'ws'; open?: boolean; tab?: WsTab }
  | { type: 'file'; path: string | null }
  | { type: 'instance'; id: string | null }
  | { type: 'sideFull'; on: boolean }
  | { type: 'listHidden'; on: boolean }
  | { type: 'palette'; open: boolean }
  | { type: 'models'; open: boolean }
  | { type: 'inbox'; open: boolean }
  | { type: 'commit'; open: boolean }
  | { type: 'mode'; mode: 'Agent' | 'Ask' }
  | { type: 'model'; model: string }
  | { type: 'effort'; effort: Effort }
  | { type: 'draft'; text: string }
  | { type: 'context'; add?: ContextItem; remove?: string }
  | { type: 'decide'; agent: string; verdict: Verdict }
  | { type: 'choose'; agent: string; n: number | null }
  | { type: 'answer'; agent: string; text: string }
  | { type: 'send'; agent: string; text: string; steer: boolean }
  | { type: 'unqueue'; agent: string; text: string; steer: boolean }
  | { type: 'stop'; agent: string }
  | { type: 'resume'; agent: string }
  | { type: 'settle'; agent: string; kind: 'kept' | 'undone' | 'committed'; sha?: string }
  | { type: 'restore'; task: Agent }
  | { type: 'markFile'; agent: string; path: string; mark: 'kept' | 'undone' | null }
  | { type: 'pin'; agent: string }
  | { type: 'archive'; agent: string; on: boolean }
  | { type: 'start'; brief: string; checks: string[]; worktree: boolean }
  | { type: 'rerun'; agent: string; brief: string }
  | { type: 'pick'; on: boolean }
  | { type: 'listen'; on: boolean }
  | { type: 'homeGroup'; by: 'status' | 'workspace' }
  | { type: 'worktreeDefault'; on: boolean }
  | { type: 'readAll' }

/** The tab a task opens on: whatever it is doing now. */
export function defaultTab(id: string): WsTab {
  switch (id) {
    case 'plan-billing':
    case 'audit-auth':
      return 'plan'
    case 'search-cache':
    case 'migrate-sessions':
    case 'flaky-checkout':
      return 'terminal'
    default:
      return 'review'
  }
}

function openTask(s: State, id: string): State {
  return {
    ...s,
    view: 'agent',
    agent: id,
    wsTab: defaultTab(id),
    file: null,
    instance: null,
    palette: false,
    inbox: false,
    models: false,
    commit: false,
    picking: false,
    listening: false,
    context: [],
    draft: '',
    sideFull: false,
    tasks: patchTasks(s.tasks, id, { unread: false })
  }
}

export function initState(scene: SceneId): State {
  const base: State = {
    view: 'agent',
    agent: 'rate-limits',
    scope: 'acme',
    tasks: AGENTS.map((a) => ({ ...a })),
    records: {},
    wsOpen: true,
    wsTab: 'review',
    file: null,
    instance: null,
    sideFull: false,
    listHidden: false,
    palette: false,
    models: false,
    inbox: false,
    commit: false,
    mode: 'Agent',
    model: 'Opus 5.5',
    effort: 'High',
    draft: '',
    context: [],
    allowed: {},
    choice: {},
    answers: {},
    queued: { 'rate-limits': ['Also cover /v1/public/search'] },
    steers: {},
    followUps: {},
    resumed: {},
    fileMarks: {},
    picking: false,
    listening: false,
    homeGroup: 'status',
    worktreeDefault: true,
    nextId: 1
  }
  const open = (id: string, extra: Partial<State> = {}): State => ({ ...openTask(base, id), ...extra })
  switch (scene) {
    case 'needs':
      return open('migrate-sessions', { model: 'GPT-5.6 Sol' })
    case 'question':
      return open('plan-billing')
    case 'review':
      return open('webhook-retry', { model: 'GPT-5.6 Sol' })
    case 'commit':
      return open('webhook-retry', { model: 'GPT-5.6 Sol', commit: true })
    case 'browser':
      return open('pricing-toggle', {
        wsTab: 'browser',
        picking: true,
        context: [{ kind: 'element', label: 'BillingToggle' }],
        draft: 'Make the saved-percent badge sit on the toggle, not under it'
      })
    case 'instances':
      return open('audit-auth', { instance: 'i-billing' })
    case 'failed':
      return open('search-cache')
    case 'new':
      return { ...base, view: 'new' }
    case 'home':
      return { ...base, view: 'home' }
    case 'inbox':
      return { ...base, inbox: true }
    case 'usage':
      return { ...base, view: 'usage' }
    case 'extensions':
      return { ...base, view: 'extensions' }
    case 'settings':
      return { ...base, view: 'settings' }
    case 'palette':
      return { ...base, palette: true }
    case 'models':
      return { ...base, models: true }
    default:
      return base
  }
}

function patchTasks(tasks: Agent[], id: string, p: Partial<Agent>): Agent[] {
  return tasks.map((t) => (t.id === id ? { ...t, ...p } : t))
}

const push = <T,>(m: Record<string, T[]>, id: string, v: T): Record<string, T[]> => ({ ...m, [id]: [...(m[id] ?? []), v] })

export function reducer(s: State, a: Action): State {
  const task = (id: string): Agent | undefined => s.tasks.find((t) => t.id === id)
  const patch = (id: string, p: Partial<Agent>): Agent[] => patchTasks(s.tasks, id, p)

  switch (a.type) {
    case 'open':
      return openTask(s, a.agent)
    case 'view':
      return { ...s, view: a.view, palette: false, models: false, inbox: false, commit: false, draft: a.view === 'new' ? '' : s.draft }
    case 'scope':
      return { ...s, scope: a.scope }
    case 'ws':
      return { ...s, wsOpen: a.open ?? true, wsTab: a.tab ?? s.wsTab }
    case 'file':
      return { ...s, file: a.path, wsTab: 'files', wsOpen: true }
    case 'instance':
      return { ...s, instance: a.id }
    case 'sideFull':
      return { ...s, sideFull: a.on, wsOpen: a.on ? true : s.wsOpen }
    case 'listHidden':
      return { ...s, listHidden: a.on }
    case 'palette':
      return { ...s, palette: a.open, models: false, inbox: false }
    case 'models':
      return { ...s, models: a.open, palette: false, inbox: false }
    case 'inbox':
      return { ...s, inbox: a.open, palette: false, models: false }
    case 'commit':
      return { ...s, commit: a.open }
    case 'mode':
      return { ...s, mode: a.mode }
    case 'model':
      return { ...s, model: a.model }
    case 'effort':
      return { ...s, effort: a.effort }
    case 'draft':
      return { ...s, draft: a.text }
    case 'context':
      return {
        ...s,
        context: a.add
          ? s.context.some((c) => c.label === a.add!.label)
            ? s.context
            : [...s.context, a.add]
          : s.context.filter((c) => c.label !== a.remove)
      }

    case 'decide': {
      const t = task(a.agent)
      if (!t?.ask) return s
      const line = a.verdict === 'denied' ? 'Looking for a way that does not touch staging' : `Running ${t.ask.text}`
      return { ...s, allowed: { ...s.allowed, [a.agent]: a.verdict }, tasks: patch(a.agent, { state: 'running', line, age: 'now' }) }
    }
    case 'choose':
      return { ...s, choice: { ...s.choice, [a.agent]: a.n } }
    case 'answer': {
      const answers = push(s.answers, a.agent, a.text)
      const done = answers[a.agent].length >= 2
      return {
        ...s,
        answers,
        choice: { ...s.choice, [a.agent]: null },
        tasks: patch(a.agent, done ? { state: 'running', line: 'Writing the usage_events migration', step: [2, 4], age: 'now' } : { line: `Asks: ${SECOND_QUESTION.q.toLowerCase()}` })
      }
    }
    case 'send': {
      const t = task(a.agent)
      if (!t) return s
      const cleared = { ...s, draft: '', context: [] as ContextItem[] }
      if (t.state === 'needs' && t.ask?.kind === 'question' && (s.answers[a.agent]?.length ?? 0) < 2) {
        return reducer(cleared, { type: 'answer', agent: a.agent, text: a.text })
      }
      if (t.state === 'running' || t.state === 'needs') {
        return a.steer ? { ...cleared, steers: push(s.steers, a.agent, a.text) } : { ...cleared, queued: push(s.queued, a.agent, a.text) }
      }
      return {
        ...cleared,
        followUps: push(s.followUps, a.agent, a.text),
        tasks: patch(a.agent, { state: 'running', line: 'Working on your follow-up', outcome: undefined, age: 'now', day: undefined })
      }
    }
    case 'unqueue': {
      const queued = { ...s.queued, [a.agent]: (s.queued[a.agent] ?? []).filter((q) => q !== a.text) }
      return a.steer ? { ...s, queued, steers: push(s.steers, a.agent, a.text) } : { ...s, queued }
    }
    case 'stop': {
      const t = task(a.agent)
      const at = t?.step?.[0] ?? 1
      return { ...s, tasks: patch(a.agent, { state: 'stopped', line: `Stopped by you at step ${at}`, day: 'Today', age: 'now' }) }
    }
    case 'resume': {
      const t = task(a.agent)
      const at = t?.step?.[0] ?? 1
      const line = t?.state === 'failed' ? `Retrying step ${at}` : `Resuming step ${at}`
      return { ...s, resumed: { ...s.resumed, [a.agent]: true }, tasks: patch(a.agent, { state: 'running', line, day: undefined, age: 'now' }) }
    }
    case 'settle': {
      const t = task(a.agent)
      if (!t) return s
      const files = filesChanged(a.agent)
      const line =
        a.kind === 'kept' ? `Kept · ${files} files` : a.kind === 'undone' ? `Undone · ${files} files` : `Committed ${a.sha} · ${files} files`
      return {
        ...s,
        commit: false,
        tasks: patch(a.agent, { state: 'done', outcome: { kind: a.kind, files, sha: a.sha }, line, day: 'Today', age: 'now' })
      }
    }
    case 'restore':
      return { ...s, tasks: s.tasks.map((t) => (t.id === a.task.id ? a.task : t)) }
    case 'markFile': {
      const key = `${a.agent}:${a.path}`
      const fileMarks = { ...s.fileMarks }
      if (a.mark) fileMarks[key] = a.mark
      else delete fileMarks[key]
      return { ...s, fileMarks }
    }
    case 'pin': {
      const t = task(a.agent)
      return { ...s, tasks: patch(a.agent, { pinned: !t?.pinned }) }
    }
    case 'archive':
      return { ...s, tasks: patch(a.agent, { archived: a.on, pinned: a.on ? false : task(a.agent)?.pinned }), agent: a.on && s.agent === a.agent ? 'rate-limits' : s.agent }
    case 'start': {
      const id = `new-${s.nextId}`
      const words = a.brief.replace(/\s+/g, ' ').trim().split(' ')
      const title = words.slice(0, 7).join(' ').replace(/[.,;:]$/, '') + (words.length > 7 ? '…' : '')
      const t: Agent = {
        id,
        title: title.charAt(0).toUpperCase() + title.slice(1),
        state: 'running',
        age: 'now',
        workspace: s.scope === 'all' ? 'acme' : s.scope,
        branch: a.worktree ? `vyotiq/${words.slice(0, 3).join('-').toLowerCase().replace(/[^a-z0-9-]/g, '')}` : 'main',
        worktree: a.worktree,
        line: 'Reading the workspace',
        model: s.model,
        cost: '$0.00'
      }
      const record: RecordData = {
        brief: a.brief,
        checks: a.checks.map((text) => ({ text, state: 'open' })),
        setup: [{ k: 'live', text: 'Reading the workspace' }],
        steps: []
      }
      return openTask({ ...s, tasks: [t, ...s.tasks], records: { ...s.records, [id]: record }, nextId: s.nextId + 1 }, id)
    }
    case 'rerun': {
      const base = s.records[a.agent] ?? RECORDS[a.agent]
      const record: RecordData = {
        brief: a.brief,
        checks: (base?.checks ?? []).map((c) => ({ text: c.text, state: 'open' })),
        setup: [{ k: 'live', text: 'Planning from the edited brief' }],
        steps: []
      }
      return {
        ...s,
        records: { ...s.records, [a.agent]: record },
        answers: { ...s.answers, [a.agent]: [] },
        steers: { ...s.steers, [a.agent]: [] },
        followUps: { ...s.followUps, [a.agent]: [] },
        tasks: patch(a.agent, { state: 'running', line: 'Planning from the edited brief', step: undefined, outcome: undefined, day: undefined, age: 'now', ask: undefined })
      }
    }
    case 'pick':
      return { ...s, picking: a.on }
    case 'listen':
      return { ...s, listening: a.on }
    case 'homeGroup':
      return { ...s, homeGroup: a.by }
    case 'worktreeDefault':
      return { ...s, worktreeDefault: a.on }
    case 'readAll':
      return { ...s, tasks: s.tasks.map((t) => ({ ...t, unread: false })) }
  }
}

export type Ctx = { s: State; d: Dispatch<Action>; width: number }
export const AgentsCtx = createContext<Ctx | null>(null)

export function useAgents(): Ctx {
  const c = useContext(AgentsCtx)
  if (!c) throw new Error('useAgents outside AgentsCtx')
  return c
}

/**
 * Actions that also speak: each settles the task and says so in a toast with
 * Undo, the way the app's toasts work. Toasts live here, not in the reducer,
 * so StrictMode's double reduce never shows two.
 */
export function useActions() {
  const { s, d } = useAgents()
  return useMemo(() => {
    const find = (id: string): Agent | undefined => s.tasks.find((t) => t.id === id)
    const settle = (id: string, kind: 'kept' | 'undone' | 'committed', sha?: string): void => {
      const before = find(id)
      if (!before) return
      d({ type: 'settle', agent: id, kind, sha })
      const files = filesChanged(id)
      const message = kind === 'kept' ? `Kept ${files} files` : kind === 'undone' ? `Undid ${files} files` : `Committed ${sha} to ${before.branch}`
      pushToast(message, {
        kind: 'success',
        detail: before.title,
        action: { label: 'Undo', onClick: () => d({ type: 'restore', task: before }) }
      })
    }
    return {
      keepAll: (id: string) => settle(id, 'kept'),
      undoAll: (id: string) => settle(id, 'undone'),
      commit: (id: string) => settle(id, 'committed', ['a41c9e2', 'b7d0f13', 'c2e8a90'][id.length % 3]),
      stop: (id: string) => {
        const before = find(id)
        d({ type: 'stop', agent: id })
        if (before) pushToast('Stopped', { detail: before.title, state: 'stopped', action: { label: 'Resume', onClick: () => d({ type: 'resume', agent: id }) } })
      },
      archive: (id: string) => {
        const before = find(id)
        d({ type: 'archive', agent: id, on: true })
        if (before) pushToast('Archived', { detail: before.title, icon: 'archive', action: { label: 'Undo', onClick: () => d({ type: 'archive', agent: id, on: false }) } })
      },
      decide: (id: string, verdict: Verdict) => {
        const t = find(id)
        d({ type: 'decide', agent: id, verdict })
        if (verdict === 'always' && t?.ask) pushToast(`Always allowed ${t.ask.text.split(' ').slice(0, 2).join(' ')}`, { detail: 'For this workspace · Settings › Agent', icon: 'shield' })
      }
    }
  }, [s.tasks, d])
}
