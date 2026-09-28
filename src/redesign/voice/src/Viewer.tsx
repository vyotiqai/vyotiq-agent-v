import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SCREENS, SIZES, SKINS, type SizeId, type Skin, type Theme } from './screens'

/*
  The mockup viewer. It is scaffolding, not part of the design, so it uses
  Tailwind's stock neutral palette rather than the --vy-* tokens.

  URL: ?s=<screen>&skin=<skin>&theme=<light|dark>&size=<1440|1920|1280>&bare=1
  `bare=1` renders one window at 1:1 with no viewer chrome (screenshots).
*/

type Params = { s: string; skin: Skin; theme: Theme; size: SizeId; bare: boolean; all: boolean }

function readParams(): Params {
  const p = new URLSearchParams(window.location.search)
  const s = SCREENS.some((x) => x.id === p.get('s')) ? (p.get('s') as string) : SCREENS[0].id
  const skin = (SKINS as readonly string[]).includes(p.get('skin') ?? '') ? (p.get('skin') as Skin) : 'native'
  const theme: Theme = p.get('theme') === 'light' ? 'light' : 'dark'
  const rawSize = p.get('size') ?? '1440'
  const size: SizeId = rawSize in SIZES ? (rawSize as SizeId) : '1440'
  return { s, skin, theme, size, bare: p.get('bare') === '1', all: p.get('all') === '1' }
}

function Frame({ screen, skin, theme, size }: { screen: string; skin: Skin; theme: Theme; size: SizeId }) {
  const def = SCREENS.find((x) => x.id === screen) ?? SCREENS[0]
  const { w, h } = SIZES[size]
  const Cmp = def.Component
  return (
    <div data-skin={skin} data-theme={theme} data-density="default" className="relative overflow-hidden" style={{ width: w, height: h }}>
      <Cmp />
    </div>
  )
}

export function Viewer() {
  const initial = readParams()
  const [screen, setScreen] = useState(initial.s)
  const [skin, setSkin] = useState<Skin>(initial.skin)
  const [theme, setTheme] = useState<Theme>(initial.theme)
  const [size, setSize] = useState<SizeId>(initial.size)
  const [all, setAll] = useState(initial.all)
  const stageRef = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)

  // Tooltips and menus portal to <body>, outside the frame: give the document
  // the frame's skin and theme so they resolve the same tokens.
  useEffect(() => {
    document.documentElement.dataset.skin = skin
    document.documentElement.dataset.theme = theme
  }, [skin, theme])

  useEffect(() => {
    if (initial.bare) return
    const p = new URLSearchParams()
    p.set('s', screen)
    p.set('skin', skin)
    p.set('theme', theme)
    p.set('size', size)
    if (all) p.set('all', '1')
    window.history.replaceState(null, '', `?${p.toString()}`)
  }, [screen, skin, theme, size, all, initial.bare])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el || initial.bare) return
    const { w, h } = SIZES[size]
    const fit = (): void => {
      const pad = 40
      const cols = all ? 2 : 1
      const rows = all ? 3 : 1
      const sw = (el.clientWidth - pad * (cols + 1)) / (w * cols)
      const sh = (el.clientHeight - pad * (rows + 1)) / (h * rows)
      setScale(Math.max(0.12, Math.min(sw, sh, 1)))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [size, all, initial.bare])

  if (initial.bare) {
    return <Frame screen={screen} skin={skin} theme={theme} size={size} />
  }

  const def = SCREENS.find((x) => x.id === screen) ?? SCREENS[0]
  const groups = [...new Set(SCREENS.map((x) => x.group))]
  const { w, h } = SIZES[size]
  const pill = (on: boolean): string =>
    `h-7 rounded-md px-2.5 text-xs font-medium capitalize transition-colors ${on ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-200'}`

  return (
    <div className="flex h-full bg-neutral-100 font-sans text-neutral-900" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-white">
        <div className="px-4 pb-3 pt-4">
          <div className="text-sm font-semibold">Vyotiq · Voice</div>
          <div className="text-xs text-neutral-500">Dictation redesign · mockups</div>
        </div>
        <nav className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
          {groups.map((g) => (
            <div key={g} className="mt-3">
              <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-400">{g}</div>
              {SCREENS.filter((x) => x.group === g).map((x) => (
                <button
                  key={x.id}
                  type="button"
                  onClick={() => setScreen(x.id)}
                  className={`block w-full rounded-md px-2 py-1.5 text-left text-[13px] ${x.id === screen ? 'bg-neutral-900 text-white' : 'text-neutral-700 hover:bg-neutral-100'}`}
                >
                  {x.label}
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-4 border-b border-neutral-200 bg-white px-4">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">{def.label}</div>
            <div className="truncate text-xs text-neutral-500">{def.note}</div>
          </div>
          <div className="flex items-center gap-0.5" role="group" aria-label="Skin">
            {SKINS.map((k) => (
              <button key={k} type="button" className={pill(!all && k === skin)} onClick={() => (setSkin(k), setAll(false))}>
                {k}
              </button>
            ))}
            <button type="button" className={pill(all)} onClick={() => setAll(!all)}>
              all
            </button>
          </div>
          <div className="flex items-center gap-0.5" role="group" aria-label="Theme">
            {(['light', 'dark'] as const).map((t) => (
              <button key={t} type="button" className={pill(t === theme)} onClick={() => setTheme(t)}>
                {t}
              </button>
            ))}
          </div>
          <select
            value={size}
            onChange={(e) => setSize(e.target.value as SizeId)}
            className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-xs"
            aria-label="Window size"
          >
            {(Object.keys(SIZES) as SizeId[]).map((k) => (
              <option key={k} value={k}>
                {SIZES[k].label}
              </option>
            ))}
          </select>
        </header>

        <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden">
          {all ? (
            <div className="absolute inset-0 grid place-content-center gap-10" style={{ gridTemplateColumns: `repeat(2, ${w * scale}px)` }}>
              {SKINS.map((k) => (
                <div key={k} style={{ width: w * scale, height: h * scale + 20 }}>
                  <div className="mb-1 text-[11px] font-medium capitalize text-neutral-500">{k}</div>
                  <div className="overflow-hidden rounded-md shadow-lg" style={{ width: w * scale, height: h * scale }}>
                    <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left' }}>
                      <Frame screen={screen} skin={k} theme={theme} size={size} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div
              className="absolute left-1/2 top-1/2 overflow-hidden rounded-lg shadow-2xl ring-1 ring-black/10"
              style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${scale})` }}
            >
              <Frame screen={screen} skin={skin} theme={theme} size={size} />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
