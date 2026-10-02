import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import { Icon } from '@renderer/lib/icons'
import { VyotiqMark } from '@renderer/lib/brand/VyotiqMark'
import { IconButton, Keys, cn } from '@renderer/lib/ui'
import { MENU_LABEL, MENU_SURFACE } from '@renderer/lib/ui/menuStyles'
import { SIDEBAR_WIDTH_PX } from '@renderer/lib/utils/layout'
import { NAV_COMPACT_PX, Navigator } from './Navigator'
import { Palette } from './Palette'
import { KEYS } from './parts'
import { SelectionAsk } from './SelectionAsk'
import { Strip } from './Strip'
import { RailCtx, initState, reducer, useRail, type SceneId, type Skin, type Theme } from './store'

/*
  The whole window: title bar · navigator · the rail of sheets.
  The window owns its skin and theme (Settings › Appearance changes them
  live), and below 1200px the navigator folds to its compact column unless
  Ctrl+B has pinned it open.
*/

const WIDE_NAV_MIN = 1200

function TitleBar() {
  const { s, d, wideNav } = useRail()
  return (
    <header className="relative z-titlebar flex h-9 shrink-0 items-center bg-chrome" aria-label="Window title bar">
      <div
        className={cn('flex h-full shrink-0 items-center whitespace-nowrap', wideNav ? 'gap-1 pl-3' : 'justify-center')}
        style={{ width: wideNav ? SIDEBAR_WIDTH_PX : NAV_COMPACT_PX }}
      >
        <VyotiqMark size={15} className="text-fg-strong" decorative />
        {wideNav ? (
          <>
            <span className="ml-1.5 text-xs font-semibold tracking-[var(--vy-tracking-tight)] text-fg-strong">Agent V</span>
            <span className="flex-1" />
            <IconButton icon="sidebar" label="Compact navigator (Ctrl+B)" size="sm" tone="muted" className="mr-2" onClick={() => d({ type: 'nav', wide: true })} />
          </>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => d({ type: 'palette', open: true })}
        className="absolute left-1/2 top-1/2 flex h-6 w-[min(380px,34%)] -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-md bg-surface px-2 text-xs text-tertiary vy-transition hover:bg-surface-2 focus-visible:vy-focus-ring"
      >
        <Icon name="search" size={14} />
        <span className="min-w-0 flex-1 truncate text-left">Search tasks, sheets and commands</span>
        <Keys keys={['Ctrl', 'K']} />
      </button>
      <div className="ml-auto flex h-full items-center gap-0.5 pr-2">
        {s.place === 'task' ? <IconButton icon="columns" label="Fit every sheet" size="sm" tone="muted" onClick={() => d({ type: 'fit' })} /> : null}
        <IconButton icon="keyboard" label="Keys" size="sm" tone="muted" active={s.keysOpen} onClick={() => d({ type: 'keys' })} />
      </div>
      <div className="flex h-full" aria-hidden>
        {(['min', 'max', 'close'] as const).map((k) => (
          <span key={k} className="grid h-full w-[46px] place-items-center text-secondary">
            <svg width="10" height="10" viewBox="0 0 10 10">
              {k === 'min' ? <path d="M0 5h10" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'max' ? <rect x="0.5" y="0.5" width="9" height="9" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1" /> : null}
              {k === 'close' ? <path d="M0.5 0.5l9 9M9.5 0.5l-9 9" stroke="currentColor" strokeWidth="1" /> : null}
            </svg>
          </span>
        ))}
      </div>
    </header>
  )
}

function KeysPopover() {
  const { s, d } = useRail()
  if (!s.keysOpen) return null
  return (
    <div role="dialog" aria-label="Keys" className={cn(MENU_SURFACE, 'absolute right-[146px] top-10 w-[340px]')}>
      <div className="flex h-10 items-center border-b border-border pl-3 pr-2">
        <span className="flex-1 text-sm font-medium text-fg-strong">Keys</span>
        <IconButton icon="close" label="Close" size="sm" tone="muted" onClick={() => d({ type: 'keys', open: false })} />
      </div>
      <div className="p-1">
        <div className={MENU_LABEL}>The rail and the lens</div>
        {KEYS.map(([k, what]) => (
          <div key={what} className="flex h-7 items-center gap-2 px-2 text-xs">
            <span className="min-w-0 flex-1 truncate text-fg">{what}</span>
            <Keys keys={k} />
          </div>
        ))}
      </div>
    </div>
  )
}

export function App({ scene, skin, theme }: { scene: SceneId; skin: Skin; theme: Theme }) {
  const [s, d] = useReducer(reducer, { scene, skin, theme }, initState)
  const frame = useRef<HTMLDivElement>(null)
  const root = useCallback(() => frame.current, [])
  const [width, setWidth] = useState(1440)

  // The viewer's pickers still drive the window; Settings can too.
  useEffect(() => d({ type: 'appearance', skin, theme }), [skin, theme])
  useEffect(() => {
    document.documentElement.dataset.skin = s.skin
    document.documentElement.dataset.theme = s.theme
  }, [s.skin, s.theme])

  useLayoutEffect(() => {
    const el = frame.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.offsetWidth))
    ro.observe(el)
    setWidth(el.offsetWidth)
    return () => ro.disconnect()
  }, [])
  const wideNav = s.navMode === 'full' || (s.navMode === 'auto' && width >= WIDE_NAV_MIN)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const k = e.key
      if (e.altKey && !e.ctrlKey) {
        if (k === 'ArrowLeft' || k === 'ArrowRight') {
          e.preventDefault()
          const dir = k === 'ArrowLeft' ? -1 : 1
          d(e.shiftKey ? { type: 'move', dir } : { type: 'focusStep', dir })
          return
        }
        if (k === '[' || k === ']') return e.preventDefault(), d({ type: 'widthStep', dir: k === '[' ? -1 : 1 })
        if (k.toLowerCase() === 'w') return e.preventDefault(), d({ type: 'close', id: s.focus })
      }
      if (e.ctrlKey && !e.altKey) {
        if (k.toLowerCase() === 'k') return e.preventDefault(), d({ type: 'palette' })
        if (k.toLowerCase() === 'b') return e.preventDefault(), d({ type: 'nav', wide: wideNav })
        if (k.toLowerCase() === 'l') return e.preventDefault(), d({ type: 'lens' })
      }
      if (k === 'Escape' && s.keysOpen) d({ type: 'keys', open: false })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [s.focus, s.keysOpen, wideNav])

  return (
    <RailCtx.Provider value={{ s, d, root, wideNav }}>
      <div ref={frame} data-skin={s.skin} data-theme={s.theme} className="relative flex h-full flex-col overflow-hidden bg-chrome font-sans text-fg">
        <TitleBar />
        <div className="flex min-h-0 flex-1 border-t border-border">
          <Navigator />
          <Strip />
        </div>
        <KeysPopover />
        <Palette />
        <SelectionAsk />
      </div>
    </RailCtx.Provider>
  )
}
