import { useEffect, useReducer, useRef } from 'react'
import { Icon } from '@renderer/lib/icons'
import { VyotiqMark } from '@renderer/lib/brand/VyotiqMark'
import { IconButton, Keys, ToastHost, cn } from '@renderer/lib/ui'
import { Home } from './Home'
import { NewTask } from './NewTask'
import { Palette } from './Palette'
import { WindowControls } from './parts'
import { Extensions, Usage } from './Places'
import { isSettled, visibleTasks } from './runtime'
import { Settings, SettingsNav, useSettingsScroll } from './Settings'
import { AgentsCtx, WS_TABS, initState, reducer, useActions, useAgents, type SceneId, type Skin, type Theme } from './store'
import { LIST_COMPACT_W, LIST_W, TaskList, TaskListCompact } from './TaskList'
import { TaskPane } from './TaskPane'
import { Workspace } from './Workspace'

/*
  The window: title band, task list, the task, the side pane. Three columns
  like Cursor's agent window, flush in every skin, one hairline between each.
*/

const WIDE_LIST_MIN = 1200

function sideWidth(w: number): number {
  if (w >= 1900) return 640
  if (w >= 1440) return 540
  if (w >= 1280) return 460
  return 400
}

export function App({ scene, width, skin, theme, onSkin, onTheme }: { scene: SceneId; width: number; skin: Skin; theme: Theme; onSkin: (s: Skin) => void; onTheme: (t: Theme) => void }) {
  const [s, d] = useReducer(reducer, scene, initState)
  return (
    <AgentsCtx.Provider value={{ s, d, width }}>
      <Window skin={skin} theme={theme} onSkin={onSkin} onTheme={onTheme} />
    </AgentsCtx.Provider>
  )
}

function Window({ skin, theme, onSkin, onTheme }: { skin: Skin; theme: Theme; onSkin: (s: Skin) => void; onTheme: (t: Theme) => void }) {
  const { s, d, width } = useAgents()
  const act = useActions()
  const wide = width >= WIDE_LIST_MIN
  const settings = useSettingsScroll()
  const keys = useRef({ s, act })
  keys.current = { s, act }

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const { s, act } = keys.current
      const k = e.key.toLowerCase()
      const typing = (e.target as HTMLElement | null)?.closest?.('input, textarea')
      if (e.ctrlKey && k === 'k') return (e.preventDefault(), d({ type: 'palette', open: !s.palette }))
      if (e.ctrlKey && k === 'n') return (e.preventDefault(), d({ type: 'view', view: 'new' }))
      if (e.ctrlKey && e.shiftKey && k === 'i') return (e.preventDefault(), d({ type: 'sideFull', on: !s.sideFull }))
      if (e.ctrlKey && k === 'i') return (e.preventDefault(), d({ type: 'ws', open: !s.wsOpen }))
      if (e.ctrlKey && k === 'b') return (e.preventDefault(), d({ type: 'listHidden', on: !s.listHidden }))
      if (e.ctrlKey && k === ',') return (e.preventDefault(), d({ type: 'view', view: 'settings' }))
      if (e.ctrlKey && k === '.' && s.view === 'agent') return (e.preventDefault(), act.stop(s.agent))
      if (e.altKey && /^[1-6]$/.test(e.key) && s.view === 'agent') return (e.preventDefault(), d({ type: 'ws', tab: WS_TABS[Number(e.key) - 1] }))
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !typing) {
        e.preventDefault()
        const list = visibleTasks(s).sort((a, b) => Number(isSettled(a)) - Number(isSettled(b)))
        const i = list.findIndex((t) => t.id === s.agent)
        const next = list[Math.max(0, Math.min(list.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]
        if (next) d({ type: 'open', agent: next.id })
        return
      }
      if (e.key === 'Escape' && !typing) {
        if (s.picking) d({ type: 'pick', on: false })
        else if (s.sideFull) d({ type: 'sideFull', on: false })
        else if (s.instance && s.view === 'agent') d({ type: 'instance', id: null })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [d])

  const inSettings = s.view === 'settings'
  // All tasks is the list at full size, so the list beside it steps aside to a rail of places.
  const onHome = s.view === 'home'
  const fullList = wide && !onHome
  const showList = !s.listHidden || inSettings
  const left = inSettings ? <SettingsNav active={settings.active} onGo={settings.go} /> : fullList ? <TaskList /> : <TaskListCompact tasks={!onHome} />
  const leftW = showList ? (inSettings || fullList ? LIST_W : LIST_COMPACT_W) : 0
  const showSide = s.view === 'agent' && s.wsOpen

  return (
    <div className="relative flex h-full flex-col bg-chrome font-sans text-sm text-fg">
      <TitleBar leftW={leftW} wide={fullList || inSettings} />
      <div className="flex min-h-0 flex-1 border-t border-border">
        {showList ? <div className="shrink-0 border-r border-border">{left}</div> : null}
        {s.view === 'agent' && !(showSide && s.sideFull) ? <TaskPane /> : null}
        {s.view === 'new' ? <NewTask /> : null}
        {s.view === 'home' ? <Home /> : null}
        {s.view === 'usage' ? <Usage /> : null}
        {s.view === 'extensions' ? <Extensions /> : null}
        {inSettings ? <Settings skin={skin} theme={theme} onSkin={onSkin} onTheme={onTheme} scroller={settings.scroller} active={settings.active} onScroll={settings.onScroll} /> : null}
        {showSide ? <Workspace width={s.sideFull ? 'full' : sideWidth(width)} /> : null}
      </div>
      {s.palette ? <Palette /> : null}
      <ToastHost />
    </div>
  )
}

function TitleBar({ leftW, wide }: { leftW: number; wide: boolean }) {
  const { s, d } = useAgents()
  return (
    <header className="relative z-titlebar flex h-9 shrink-0 items-center bg-chrome" aria-label="Window title bar">
      <div className={cn('flex h-full shrink-0 items-center gap-1.5', wide || leftW === 0 ? 'pl-3.5' : 'justify-center')} style={{ width: wide || leftW === 0 ? Math.max(leftW, 88) : leftW }}>
        <VyotiqMark size={15} className="text-fg-strong" decorative />
        {wide || leftW === 0 ? (
          <IconButton
            icon="sidebar"
            label={s.listHidden ? 'Show the task list (Ctrl+B)' : 'Hide the task list (Ctrl+B)'}
            size="sm"
            tone="muted"
            active={s.listHidden}
            onClick={() => d({ type: 'listHidden', on: !s.listHidden })}
          />
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => d({ type: 'palette', open: true })}
        className="absolute left-1/2 top-1/2 flex h-6 w-[min(400px,34%)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md bg-surface px-2 text-xs text-tertiary vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring"
      >
        <Icon name="search" size={13} />
        <span className="min-w-0 flex-1 truncate text-left">Search tasks, files and commands</span>
        <Keys keys={['Ctrl', 'K']} />
      </button>
      <span className="flex-1" />
      <WindowControls />
    </header>
  )
}
