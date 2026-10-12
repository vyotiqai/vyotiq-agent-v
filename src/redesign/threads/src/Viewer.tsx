import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { App, DIRECTIONS, SCENES, type Direction, type SceneId } from './threads/App'

/*
  The mockup viewer — scaffolding, not part of the design, so it uses
  Tailwind's stock neutral palette rather than the --vy-* tokens.

  ?d=<a|b|c>&scene=<id>&skin=<skin>&theme=<light|dark>&size=<1024|1280|1440|1920>&bare=1
*/

const SKINS = ['native', 'default', 'proof', 'bench', 'gild'] as const
type Skin = (typeof SKINS)[number]
type Theme = 'light' | 'dark'
const SIZES = { '1024': { w: 1024, h: 720 }, '1280': { w: 1280, h: 800 }, '1440': { w: 1440, h: 900 }, '1920': { w: 1920, h: 1080 } } as const
type Size = keyof typeof SIZES

function pick<T extends string>(v: string | null, all: readonly T[], fallback: T): T {
  return all.includes(v as T) ? (v as T) : fallback
}

function read() {
  const p = new URLSearchParams(window.location.search)
  return {
    d: pick<Direction>(p.get('d'), DIRECTIONS.map((x) => x.id), 'aplus'),
    scene: pick<SceneId>(p.get('scene'), SCENES.map((x) => x.id), 'rate'),
    skin: pick<Skin>(p.get('skin'), SKINS, 'native'),
    theme: pick<Theme>(p.get('theme'), ['light', 'dark'], 'dark'),
    size: pick<Size>(p.get('size'), Object.keys(SIZES) as Size[], '1440'),
    bare: p.get('bare') === '1'
  }
}

export function Viewer() {
  const init = read()
  const [d, setD] = useState<Direction>(init.d)
  const [scene, setScene] = useState<SceneId>(init.scene)
  const [skin, setSkin] = useState<Skin>(init.skin)
  const [theme, setTheme] = useState<Theme>(init.theme)
  const [size, setSize] = useState<Size>(init.size)
  const [run, setRun] = useState(0)
  const stage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const { w, h } = SIZES[size]

  // Tooltips and menus portal to <body>: give the document the frame's skin and theme.
  useEffect(() => {
    document.documentElement.dataset.skin = skin
    document.documentElement.dataset.theme = theme
  }, [skin, theme])

  useEffect(() => {
    if (init.bare) return
    window.history.replaceState(null, '', `?${new URLSearchParams({ d, scene, skin, theme, size }).toString()}`)
  }, [d, scene, skin, theme, size, init.bare])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = (): void => setScale(Math.min(1, (el.clientWidth - 32) / w, (el.clientHeight - 32) / h))
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [w, h])

  const frame = (
    <div data-skin={skin} data-theme={theme} className="relative overflow-hidden" style={{ width: w, height: h }}>
      <App key={`${d}-${scene}-${run}`} direction={d} scene={scene} />
    </div>
  )
  if (init.bare) return frame

  const pill = (on: boolean): string =>
    `h-7 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors ${on ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-200'}`

  return (
    <div className="flex h-full flex-col bg-neutral-100 text-neutral-900" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 bg-white px-4 py-2">
        <div className="mr-2">
          <div className="text-sm font-semibold">Agent V · Threads</div>
          <div className="text-xs text-neutral-500">Three directions · mockup</div>
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Direction">
          {DIRECTIONS.map((x) => (
            <button key={x.id} type="button" className={pill(x.id === d)} onClick={() => setD(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label="Scene">
          {SCENES.map((x) => (
            <button key={x.id} type="button" className={pill(x.id === scene)} onClick={() => (setScene(x.id), setRun(run + 1))}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5" role="group" aria-label="Skin">
          {SKINS.map((k) => (
            <button key={k} type="button" className={`${pill(k === skin)} capitalize`} onClick={() => setSkin(k)}>
              {k}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Theme">
          {(['dark', 'light'] as const).map((t) => (
            <button key={t} type="button" className={`${pill(t === theme)} capitalize`} onClick={() => setTheme(t)}>
              {t}
            </button>
          ))}
        </div>
        <select value={size} onChange={(e) => setSize(e.target.value as Size)} className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-xs" aria-label="Window size">
          {(Object.keys(SIZES) as Size[]).map((k) => (
            <option key={k} value={k}>
              {SIZES[k].w} × {SIZES[k].h}
            </option>
          ))}
        </select>
        <button type="button" className={pill(false)} onClick={() => setRun(run + 1)}>
          Replay
        </button>
      </header>
      <div className="shrink-0 border-b border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-600">{DIRECTIONS.find((x) => x.id === d)?.note}</div>
      <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
        <div
          className="absolute left-1/2 top-1/2 overflow-hidden rounded-lg shadow-2xl ring-1 ring-black/10"
          style={{ width: w, height: h, transform: `translate(-50%, -50%) scale(${scale})` }}
        >
          {frame}
        </div>
      </div>
    </div>
  )
}
