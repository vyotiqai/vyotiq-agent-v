import { useMemo, useRef, type JSX } from 'react'
import { pushToast } from '@renderer/lib/ui'
import { useConfirm } from '@renderer/lib/hooks/useConfirm'
import { requestRunInTerminal } from '@renderer/features/chat/terminalRequests'
import { requestOpenCommit } from '@renderer/features/chat/commitOpenRequests'
import type { RunSessionValue } from '@renderer/features/chat/RunSessionContext'
import type { ViewDo } from '@shared/viewSpec'
import type { ViewActions } from './blocks'
import { refreshLiveSources } from './live'

/*
  What a view's clicks reach. `say` is words for the agent, the same channel
  as typing; `do` is the app itself, from a closed list (VIEW_DO): open a file
  or its diff or a commit, stage, open an inspector tab, open a web page, or
  run a command in your terminal. A command asks first, showing what it
  would run. So does a web page, unless the button names its site: the
  address came from the model, which may have read it somewhere untrusted.

  An action this place can't take — no workspace, or a tab this record can't
  open — is not offered: its button is plain, its row is just a row.
*/

/** A second click on the same request this soon is the same request, not a new one. */
const REPEAT_MS = 1500

export function useViewActions(session: RunSessionValue): { act: ViewActions; dialog: JSX.Element } {
  const { confirm, dialog } = useConfirm()
  const last = useRef<{ key: string; at: number } | null>(null)
  const { workspacePath, onSay, onOpenWorkspaceFile, onOpenPanel } = session

  const act = useMemo<ViewActions>(() => {
    const once = (key: string): boolean => {
      const now = Date.now()
      if (last.current && last.current.key === key && now - last.current.at < REPEAT_MS) return false
      last.current = { key, at: now }
      return true
    }

    const can = (d: ViewDo): boolean => {
      switch (d.action) {
        case 'open':
        case 'diff':
          return Boolean(onOpenWorkspaceFile)
        case 'stage':
        case 'unstage':
          return Boolean(workspacePath && window.vyotiq?.gitStagePaths)
        case 'run':
        case 'commit':
          // The command lands in the Terminal tab and the commit in Changes, which only this record's own inspector can open.
          return Boolean(workspacePath && onOpenPanel)
        case 'panel':
          return Boolean(onOpenPanel)
        case 'link':
          return Boolean(window.vyotiq?.shellOpenExternal)
      }
    }

    const run = async (d: ViewDo, seen: boolean): Promise<void> => {
      if (!can(d) || !once(`do:${JSON.stringify(d)}`)) return
      switch (d.action) {
        case 'open':
          onOpenWorkspaceFile?.(d.path)
          return
        case 'diff':
          onOpenWorkspaceFile?.(d.path, { mode: 'diff' })
          return
        case 'stage':
        case 'unstage': {
          if (!workspacePath) return
          // Git's own account, not the request's: a path it refused leaves "Nothing to stage".
          const res =
            d.action === 'stage'
              ? await window.vyotiq.gitStagePaths({ workspacePath, paths: d.paths }).then((r) => (r.ok ? { ...r, done: r.data.staged } : r))
              : await window.vyotiq.gitUnstagePaths({ workspacePath, paths: d.paths }).then((r) => (r.ok ? { ...r, done: r.data.unstaged } : r))
          pushToast(res.ok ? res.data.detail : res.error, res.ok && res.done ? 'success' : res.ok ? 'info' : 'error')
          refreshLiveSources()
          return
        }
        case 'commit':
          if (!workspacePath) return
          requestOpenCommit(workspacePath, d.sha)
          onOpenPanel?.('changes')
          return
        case 'run': {
          if (!workspacePath) return
          const ok = await confirm('It runs in your own terminal, in this workspace, as if you typed it.', {
            title: 'Run this command?',
            confirmLabel: 'Run',
            details: <pre className="m-0 mt-2 whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs text-fg">{d.command}</pre>
          })
          if (!ok) return
          requestRunInTerminal(workspacePath, d.command)
          onOpenPanel?.('terminal')
          return
        }
        case 'panel':
          onOpenPanel?.(d.panel)
          return
        case 'link': {
          if (!seen) {
            const ok = await confirm('It opens in your browser. The address came from the agent, so check the site is the one you expect.', {
              title: `Open ${linkHost(d.url)}?`,
              confirmLabel: 'Open',
              details: <pre className="m-0 mt-2 whitespace-pre-wrap break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs text-fg">{d.url}</pre>
            })
            if (!ok) return
          }
          void window.vyotiq.shellOpenExternal(d.url)
          return
        }
      }
    }

    return {
      say: onSay
        ? (said: string) => {
            if (once(`say:${said}`)) onSay(said)
          }
        : undefined,
      open: onOpenWorkspaceFile ? (path: string) => onOpenWorkspaceFile(path) : undefined,
      can,
      run: (d: ViewDo, seen = false) => void run(d, seen)
    }
  }, [workspacePath, onSay, onOpenWorkspaceFile, onOpenPanel, confirm])

  return { act, dialog }
}

/** A web page's site, as a button names it: "github.com". */
export function linkHost(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return url
  }
}

/**
 * What a click on an item does, or null when nothing here can: `do` first,
 * then `say`, then its file. `seen`: the control itself shows a link's site.
 */
export function clickOf(item: { do?: ViewDo; say?: string; path?: string }, act: ViewActions, seen = false): (() => void) | null {
  if (item.do && act.can?.(item.do)) {
    const d = item.do
    return () => act.run?.(d, seen)
  }
  if (item.say && act.say) {
    const s = item.say
    return () => act.say!(s)
  }
  if (item.path && act.open) {
    const p = item.path
    return () => act.open!(p)
  }
  return null
}

/** The hover title for a click: what it will do, said plainly. */
export function clickTitle(item: { do?: ViewDo; say?: string }, act: ViewActions): string | undefined {
  if (item.do && act.can?.(item.do)) {
    const d = item.do
    switch (d.action) {
      case 'open':
        return `Opens ${d.path}`
      case 'diff':
        return `Opens the diff of ${d.path}`
      case 'stage':
        return `Stages ${d.paths.join(', ')}`
      case 'unstage':
        return `Unstages ${d.paths.join(', ')}`
      case 'commit':
        return `Opens commit ${d.sha.slice(0, 7)} in Changes`
      case 'run':
        return `Runs “${d.command}” in your terminal (asks first)`
      case 'panel':
        return `Opens ${d.panel === 'pr' ? 'Pull request' : d.panel[0]!.toUpperCase() + d.panel.slice(1)}`
      case 'link':
        return `Opens ${d.url}`
    }
  }
  if (item.say && act.say) return `Sends “${item.say}”`
  return undefined
}
