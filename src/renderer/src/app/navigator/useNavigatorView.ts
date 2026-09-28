import { useCallback, useState } from 'react'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import type { NavFilter, NavStateFilter, NavWhereFilter } from './navigatorModel'

const VIEW_KEY = 'vyotiq.navigatorView'

const STATES: readonly NavStateFilter[] = ['needs', 'running', 'review', 'failed', 'drafts', 'done']
const WHERE: readonly NavWhereFilter[] = ['inPlace', 'worktree']

/** How the navigator is set to list tasks — the View menu's choices and the folded workspaces. */
export type NavigatorView = NavFilter & {
  showArchived: boolean
  /** Workspaces folded to their heading while every workspace is listed. */
  collapsed: readonly string[]
}

export const DEFAULT_NAVIGATOR_VIEW: NavigatorView = {
  hiddenStates: [],
  unreadOnly: false,
  hiddenWhere: [],
  showArchived: false,
  collapsed: []
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []

/** Whatever was stored, as a view: unknown entries are dropped rather than trusted. */
export function parseNavigatorView(raw: string | null): NavigatorView {
  if (!raw) return DEFAULT_NAVIGATOR_VIEW
  try {
    const data = JSON.parse(raw) as Record<string, unknown>
    return {
      hiddenStates: strings(data.hiddenStates).filter((s): s is NavStateFilter => STATES.includes(s as NavStateFilter)),
      unreadOnly: data.unreadOnly === true,
      hiddenWhere: strings(data.hiddenWhere).filter((s): s is NavWhereFilter => WHERE.includes(s as NavWhereFilter)),
      showArchived: data.showArchived === true,
      collapsed: strings(data.collapsed)
    }
  } catch {
    return DEFAULT_NAVIGATOR_VIEW
  }
}

function readView(): NavigatorView {
  try {
    return parseNavigatorView(window.localStorage.getItem(VIEW_KEY))
  } catch {
    return DEFAULT_NAVIGATOR_VIEW
  }
}

function writeView(view: NavigatorView): void {
  try {
    window.localStorage.setItem(VIEW_KEY, JSON.stringify(view))
  } catch {
    // Best effort: the view still holds for this session.
  }
}

export function isCollapsed(view: NavigatorView, path: string): boolean {
  return view.collapsed.some((p) => workspacePathsEqual(p, path))
}

/** Remembered across launches, like the workspace the navigator is filtered to. */
export function useNavigatorView(): [NavigatorView, (update: (prev: NavigatorView) => NavigatorView) => void] {
  const [view, setView] = useState<NavigatorView>(() => readView())
  const update = useCallback((fn: (prev: NavigatorView) => NavigatorView): void => {
    setView((prev) => {
      const next = fn(prev)
      writeView(next)
      return next
    })
  }, [])
  return [view, update]
}
