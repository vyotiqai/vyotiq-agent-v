import { createContext, useContext, type Dispatch } from 'react'
import type { IconName } from '@renderer/lib/icons'
import { FILE_TREE, TASKS, type Task } from '../data'

/*
  The Rail's whole state.

  A place fills the work area: a task (its rail of sheets), a new task, Home,
  Usage or Extensions. Inside it, sheets stand side by side, each a fraction
  of the visible width, so a sheet keeps its proportion when the navigator
  folds. Settings is a sheet too: it opens beside whatever you are doing.
*/

export const SKINS = ['native', 'default', 'proof', 'bench', 'gild'] as const
export type Skin = (typeof SKINS)[number]
export type Theme = 'light' | 'dark'

export type Place = 'task' | 'new' | 'home' | 'usage' | 'extensions'

export type SheetKind =
  | 'record'
  | 'brief'
  | 'changes'
  | 'files'
  | 'file'
  | 'terminal'
  | 'browser'
  | 'pr'
  | 'plan'
  | 'home'
  | 'usage'
  | 'extensions'
  | 'settings'

export type Sheet = { id: string; kind: SheetKind; frac: number; path?: string }
export type TrayItem = { id: string; kind: 'file' | 'folder' | 'quote' | 'terminal'; label: string; detail?: string }
export type Steer = { text: string; mode: 'steer' | 'queue' | 'ask' | 'run'; context: number; target?: string }
export type GateChoice = 'once' | 'task' | 'deny'
export type NavMode = 'auto' | 'full' | 'compact'

export type State = {
  place: Place
  taskId: string
  navMode: NavMode
  sheets: Sheet[]
  focus: string
  gate: Record<string, GateChoice>
  steers: Record<string, Steer[]>
  tray: TrayItem[]
  lensNonce: number
  keysOpen: boolean
  paletteOpen: boolean
  skin: Skin
  theme: Theme
}

export type Action =
  | { type: 'selectTask'; id: string }
  | { type: 'place'; place: Exclude<Place, 'task'> }
  | { type: 'focus'; id: string }
  | { type: 'focusStep'; dir: -1 | 1 }
  | { type: 'move'; dir: -1 | 1 }
  | { type: 'open'; kind: SheetKind; path?: string }
  | { type: 'close'; id: string }
  | { type: 'width'; id: string; frac: number }
  | { type: 'widthStep'; dir: -1 | 1 }
  | { type: 'fit' }
  | { type: 'nav'; wide: boolean }
  | { type: 'pin'; item: Omit<TrayItem, 'id'> }
  | { type: 'unpin'; id: string }
  | { type: 'send'; text: string; mode: Steer['mode']; target?: string }
  | { type: 'gate'; choice: GateChoice }
  | { type: 'lens' }
  | { type: 'keys'; open?: boolean }
  | { type: 'palette'; open?: boolean }
  | { type: 'appearance'; skin?: Skin; theme?: Theme }

export const SNAPS = [1 / 3, 1 / 2, 2 / 3, 1] as const
export const SNAP_LABEL = ['⅓', '½', '⅔', 'Full'] as const

const DEFAULT_FRAC: Record<SheetKind, number> = {
  record: 2 / 3,
  brief: 1,
  changes: 1 / 3,
  files: 1 / 3,
  file: 1 / 2,
  terminal: 1 / 3,
  browser: 1 / 2,
  pr: 1 / 3,
  plan: 1 / 2,
  home: 1,
  usage: 1,
  extensions: 1,
  settings: 1 / 2
}

export const SHEET_NAME: Record<SheetKind, string> = {
  record: 'Record',
  brief: 'New task',
  changes: 'Changes',
  files: 'Files',
  file: 'File',
  terminal: 'Terminal',
  browser: 'Browser',
  pr: 'Pull request',
  plan: 'Plan',
  home: 'Home',
  usage: 'Usage',
  extensions: 'Extensions',
  settings: 'Settings'
}

export const SHEET_ICON: Record<SheetKind, IconName> = {
  record: 'list',
  brief: 'plus',
  changes: 'diff',
  files: 'tree',
  file: 'file',
  terminal: 'terminal',
  browser: 'browser',
  pr: 'pullRequest',
  plan: 'plan',
  home: 'home',
  usage: 'chart',
  extensions: 'extensions',
  settings: 'gear'
}

/** The sheets the shelf offers beside a task — the old inspector's tabs. */
export const SHELF: SheetKind[] = ['changes', 'files', 'terminal', 'browser', 'pr', 'plan']

/** Sheets that stand in for a whole place; the lens has nothing to look at there. */
export const PLACE_KINDS: SheetKind[] = ['brief', 'home', 'usage', 'extensions', 'settings']

let seq = 0
const nid = (k: string): string => `${k}-${++seq}`

const sheet = (kind: SheetKind, frac = DEFAULT_FRAC[kind], path?: string): Sheet => ({ id: nid(kind), kind, frac, path })

export function taskById(id: string): Task {
  return TASKS.find((t) => t.id === id) ?? TASKS[1]
}

function sheetsFor(task: Task): Sheet[] {
  return task.files.length > 0 ? [sheet('record'), sheet('changes')] : [sheet('record', 1)]
}

export type SceneId = 'running' | 'wide' | 'needs' | 'review' | 'new' | 'home' | 'usage'

export const SCENES: Array<{ id: SceneId; label: string; note: string }> = [
  { id: 'running', label: 'Running task', note: 'Record ⅔ beside Changes ⅓. Type in the lens to see where a steer lands; click Changes and the lens slides under it.' },
  { id: 'wide', label: 'Four sheets', note: 'More sheets than fit: the ones out of reach fold into spines. Alt+← → walks the rail; the shelf on the right opens more.' },
  { id: 'needs', label: 'Needs you', note: 'An approval inside the record, answered where it stands.' },
  { id: 'review', label: 'Ready for review', note: 'Result and proof beside the changes; commit from the sheet.' },
  { id: 'new', label: 'New task', note: 'The lens at full size: brief, context tray, done-when.' },
  { id: 'home', label: 'Home', note: 'What needs you, every workspace, the week.' },
  { id: 'usage', label: 'Usage', note: 'Where the tokens and the failures went.' }
]

const PLACE_SHEET: Record<Exclude<Place, 'task'>, SheetKind> = { new: 'brief', home: 'home', usage: 'usage', extensions: 'extensions' }

export function initState({ scene, skin, theme }: { scene: SceneId; skin: Skin; theme: Theme }): State {
  const blank = { navMode: 'auto' as NavMode, gate: {}, steers: {}, tray: [], lensNonce: 0, keysOpen: false, paletteOpen: false, skin, theme }
  if (scene === 'wide') {
    const sheets = [sheet('record', 1 / 2), sheet('changes', 1 / 3), sheet('file', 1 / 2, FILE_TREE[0]), sheet('terminal', 1 / 3)]
    return { ...blank, place: 'task', taskId: 'composer', sheets, focus: sheets[2].id }
  }
  if (scene === 'new' || scene === 'home' || scene === 'usage') {
    const sheets = [sheet(PLACE_SHEET[scene])]
    return { ...blank, place: scene, taskId: 'composer', sheets, focus: sheets[0].id }
  }
  const taskId = scene === 'needs' ? 'keys' : scene === 'review' ? 'diffs' : 'composer'
  const sheets = scene === 'review' ? [sheet('record', 1 / 2), sheet('changes', 1 / 2)] : sheetsFor(taskById(taskId))
  return { ...blank, place: 'task', taskId, sheets, focus: sheets[0].id }
}

function nearestSnap(frac: number): number {
  return SNAPS.reduce((a, b) => (Math.abs(b - frac) < Math.abs(a - frac) ? b : a))
}

export function reducer(s: State, a: Action): State {
  switch (a.type) {
    case 'selectTask': {
      if (a.id === s.taskId && s.place === 'task') return s
      const sheets = sheetsFor(taskById(a.id))
      return { ...s, place: 'task', taskId: a.id, sheets, focus: sheets[0].id, tray: [], paletteOpen: false }
    }
    case 'place': {
      if (s.place === a.place) return { ...s, paletteOpen: false }
      const sheets = [sheet(PLACE_SHEET[a.place])]
      return { ...s, place: a.place, sheets, focus: sheets[0].id, tray: [], paletteOpen: false }
    }
    case 'focus':
      return s.focus === a.id ? s : { ...s, focus: a.id }
    case 'focusStep': {
      const i = s.sheets.findIndex((x) => x.id === s.focus)
      const next = s.sheets[Math.max(0, Math.min(s.sheets.length - 1, i + a.dir))]
      return next ? { ...s, focus: next.id } : s
    }
    case 'move': {
      const i = s.sheets.findIndex((x) => x.id === s.focus)
      const j = i + a.dir
      if (i < 0 || j < 0 || j >= s.sheets.length) return s
      const sheets = [...s.sheets]
      ;[sheets[i], sheets[j]] = [sheets[j], sheets[i]]
      return { ...s, sheets }
    }
    case 'open': {
      const hit = s.sheets.find((x) => x.kind === a.kind && (a.kind !== 'file' || x.path === a.path))
      if (hit) return { ...s, focus: hit.id, paletteOpen: false }
      const i = s.sheets.findIndex((x) => x.id === s.focus)
      const add = sheet(a.kind, DEFAULT_FRAC[a.kind], a.path)
      const sheets = [...s.sheets]
      sheets.splice(i + 1, 0, add)
      return { ...s, sheets, focus: add.id, paletteOpen: false }
    }
    case 'close': {
      const target = s.sheets.find((x) => x.id === a.id)
      if (!target || s.sheets.length === 1 || target.kind === 'record') return s
      const i = s.sheets.findIndex((x) => x.id === a.id)
      const sheets = s.sheets.filter((x) => x.id !== a.id)
      const focus = s.focus === a.id ? (sheets[Math.max(0, i - 1)]?.id ?? sheets[0].id) : s.focus
      return { ...s, sheets, focus }
    }
    case 'width':
      return { ...s, sheets: s.sheets.map((x) => (x.id === a.id ? { ...x, frac: Math.max(0.22, Math.min(1, a.frac)) } : x)) }
    case 'widthStep':
      return {
        ...s,
        sheets: s.sheets.map((x) => {
          if (x.id !== s.focus) return x
          const at = SNAPS.indexOf(nearestSnap(x.frac) as (typeof SNAPS)[number])
          return { ...x, frac: SNAPS[Math.max(0, Math.min(SNAPS.length - 1, at + a.dir))] }
        })
      }
    case 'fit':
      return { ...s, sheets: s.sheets.map((x) => ({ ...x, frac: 1 / s.sheets.length })) }
    case 'nav':
      // Toggling pins the choice; until then the window width decides.
      return { ...s, navMode: a.wide ? 'compact' : 'full' }
    case 'pin': {
      if (s.tray.some((t) => t.label === a.item.label && t.detail === a.item.detail)) return s
      return { ...s, tray: [...s.tray, { ...a.item, id: nid('pin') }] }
    }
    case 'unpin':
      return { ...s, tray: s.tray.filter((t) => t.id !== a.id) }
    case 'send': {
      const list = s.steers[s.taskId] ?? []
      return { ...s, steers: { ...s.steers, [s.taskId]: [...list, { text: a.text, mode: a.mode, context: s.tray.length, target: a.target }] }, tray: [] }
    }
    case 'gate':
      return { ...s, gate: { ...s.gate, [s.taskId]: a.choice } }
    case 'lens':
      return { ...s, lensNonce: s.lensNonce + 1 }
    case 'keys':
      return { ...s, keysOpen: a.open ?? !s.keysOpen, paletteOpen: false }
    case 'palette':
      return { ...s, paletteOpen: a.open ?? !s.paletteOpen, keysOpen: false }
    case 'appearance':
      return { ...s, skin: a.skin ?? s.skin, theme: a.theme ?? s.theme }
  }
}

export type Rail = { s: State; d: Dispatch<Action>; root: () => HTMLElement | null; wideNav: boolean }

export const RailCtx = createContext<Rail | null>(null)

export function useRail(): Rail {
  const v = useContext(RailCtx)
  if (!v) throw new Error('useRail outside the Rail')
  return v
}

/** A rect relative to the window frame, undoing the viewer's scale. */
export function relRect(r: DOMRect, root: HTMLElement): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const rr = root.getBoundingClientRect()
  const k = rr.width / root.offsetWidth || 1
  return {
    left: (r.left - rr.left) / k,
    top: (r.top - rr.top) / k,
    right: (r.right - rr.left) / k,
    bottom: (r.bottom - rr.top) / k,
    width: r.width / k,
    height: r.height / k
  }
}

export function frameScale(root: HTMLElement): number {
  return root.getBoundingClientRect().width / root.offsetWidth || 1
}
