import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { SCENES, scene as sceneOf, type SceneId } from './vv/data'
import { DirectionA } from './vv/A'
import { DirectionB } from './vv/B'
import { DirectionC } from './vv/C'
import { Gallery } from './vv/Gallery'
import { VOICE_ORB_LOOKS, type VoiceOrbLook } from '@shared/ipc/schemas/voice'
import { ORB_LOOK_OPTIONS } from '@renderer/features/voice/orb/AnimatedOrb'
import { OrbLookContext } from './vv/orbShared'
import { NavigatorStub } from './vv/parts'
import { Shipped } from './vv/Shipped'
import { NextFrame } from './vv/next/placements'
import { CaptionsContext, PlacementContext, PopContext, StyleContext } from './vv/next/kit'
import type { Placement, Pop, VoiceStyle } from './vv/next/model'

/*
  The mockup viewer — scaffolding, not part of the design, so it uses
  Tailwind's stock neutral palette rather than the --vy-* tokens.

  ?v=<a|b|c|orb>&scene=<id>&orb=<look>&skin=<skin>&theme=<light|dark>&size=<1024|1280|1440>&bare=1
*/

type Direction = 'a' | 'b' | 'c' | 'orb' | 'app-conversation' | 'app-orb' | 'app-split' | `next-${Placement}`
const DIRECTIONS: { id: Direction; label: string; note: string }[] = [
  { id: 'next-inline', label: 'Next · Inline', note: 'Voice stays in the task thread, as in Claude: no orb, no panel. Replies light up word by word in place; a glow rises behind the composer, which says the state and holds the controls.' },
  { id: 'next-companion', label: 'Next · Companion', note: 'A wide column docked right of the task record: the orb, the words as they are spoken, and the task’s last three steps.' },
  { id: 'next-conversation', label: 'Next · Takeover: Conversation', note: 'The whole window, sidebar included. What was just said is the hero at display size, spoken word by word; the orb above it.' },
  { id: 'next-orb', label: 'Next · Takeover: Orb', note: 'The whole window. The liquid sphere is the hero; the exchange and the task strip under it.' },
  { id: 'next-split', label: 'Next · Takeover: Split', note: 'The whole window. The stage on the left, the task’s every step, question and full answer on the right.' },
  { id: 'next-capsule', label: 'Next · Capsule', note: 'A pill just above the composer on any view: state, the words being said, Mute, open, End.' },
  { id: 'next-capsule-open', label: 'Next · Capsule open', note: 'The capsule opened into a card above the composer.' },
  { id: 'next-mini', label: 'Next · Mini window', note: 'Its own always-on-top window over your editor: a pill at rest. Hover it (or it needs you) and it opens.' },
  { id: 'next-mini-open', label: 'Next · Mini open', note: 'The mini window opened: hovered, focused, a popover open, or waiting on you. It mirrors the main window’s session.' },
  { id: 'next-summary', label: 'Next · After End', note: 'What End leaves: the task outcomes (each opens its task) and two buttons, Talk again and Conversation.' },
  {
    id: 'a',
    label: 'A · Conversation',
    note: 'The conversation is the page; the orb docks in the bar under it. Each hand-off owns its task’s live steps and turns into its result in place.'
  },
  {
    id: 'b',
    label: 'B · Orb',
    note: 'The orb and what’s happening now fill the pane: your words, its words, the live steps, the result. The conversation opens beside it.'
  },
  {
    id: 'c',
    label: 'C · Split',
    note: 'Two columns: the conversation under the orb on the left, the task’s every step, question and full result on the right.'
  },
  {
    id: 'app-conversation',
    label: 'App · Conversation',
    note: 'What shipped: the app’s own voice view (features/voice/view) in its Conversation layout, on this scene. Settings › Voice mode › Layout picks it.'
  },
  {
    id: 'app-orb',
    label: 'App · Orb',
    note: 'What shipped: the app’s own voice view in its Orb layout, on this scene.'
  },
  {
    id: 'app-split',
    label: 'App · Split',
    note: 'What shipped: the app’s own voice view in its Split layout, on this scene.'
  },
  {
    id: 'orb',
    label: 'The orb',
    note: 'The orb alone: one living through a conversation, and every state side by side. Rendered live (WebGL), coloured by the skin.'
  }
]
// The app's looks, as Settings › Voice mode › Orb lists them.
const LOOKS = ORB_LOOK_OPTIONS.map((o) => ({ id: o.value, label: o.label }))
const SKINS = ['native', 'default', 'proof', 'bench', 'gild'] as const
type Skin = (typeof SKINS)[number]
type Theme = 'light' | 'dark'
const SIZES = { '1024': { w: 1024, h: 720 }, '1280': { w: 1280, h: 800 }, '1440': { w: 1440, h: 900 } } as const
type Size = keyof typeof SIZES

function pick<T extends string>(v: string | null, all: readonly T[], fallback: T): T {
  return all.includes(v as T) ? (v as T) : fallback
}

function read() {
  const p = new URLSearchParams(window.location.search)
  return {
    v: pick<Direction>(p.get('v'), DIRECTIONS.map((d) => d.id), 'next-companion'),
    scene: pick<SceneId>(p.get('scene'), SCENES.map((x) => x.id), 'working'),
    orb: pick<VoiceOrbLook>(p.get('orb'), VOICE_ORB_LOOKS, 'glow'),
    skin: pick<Skin>(p.get('skin'), SKINS, 'native'),
    theme: pick<Theme>(p.get('theme'), ['light', 'dark'], 'dark'),
    size: pick<Size>(p.get('size'), Object.keys(SIZES) as Size[], '1280'),
    bare: p.get('bare') === '1',
    style: pick<VoiceStyle>(p.get('style'), ['quiet', 'ambient'], 'quiet'),
    pop: pick<Pop>(p.get('pop'), ['none', 'voice', 'devices', 'history', 'layout'], 'none'),
    captions: p.get('captions') !== 'off'
  }
}

function Frame({ v, sceneId }: { v: Direction; sceneId: SceneId }) {
  const s = sceneOf(sceneId)
  if (v === 'orb') return <Gallery />
  if (v.startsWith('next-')) {
    const placement = v.slice(5) as Placement
    // The summary reads a whole session; the mini window floats over another app; a Takeover is the whole window.
    const scene = placement === 'summary' ? sceneOf('long') : s
    const bleed = placement === 'mini' || placement === 'mini-open' || placement === 'conversation' || placement === 'orb' || placement === 'split'
    return (
      <div className="flex h-full font-sans text-sm text-fg">
        {bleed ? null : <NavigatorStub scene={scene} />}
        <NextFrame placement={placement} scene={scene} sceneId={placement === 'summary' ? 'long' : sceneId} />
      </div>
    )
  }
  return (
    <div className="flex h-full font-sans text-sm text-fg">
      <NavigatorStub scene={s} />
      {v === 'app-conversation' ? (
        <Shipped scene={s} layout="conversation" />
      ) : v === 'app-orb' ? (
        <Shipped scene={s} layout="orb" />
      ) : v === 'app-split' ? (
        <Shipped scene={s} layout="split" />
      ) : v === 'a' ? (
        <DirectionA scene={s} />
      ) : v === 'b' ? (
        <DirectionB scene={s} />
      ) : (
        <DirectionC scene={s} />
      )}
    </div>
  )
}

export function Viewer() {
  const init = read()
  const [v, setV] = useState<Direction>(init.v)
  const [scene, setScene] = useState<SceneId>(init.scene)
  const [orb, setOrb] = useState<VoiceOrbLook>(init.orb)
  const [skin, setSkin] = useState<Skin>(init.skin)
  const [theme, setTheme] = useState<Theme>(init.theme)
  const [size, setSize] = useState<Size>(init.size)
  const [run, setRun] = useState(0)
  const [style, setStyle] = useState<VoiceStyle>(init.style)
  const [pop, setPop] = useState<Pop>(init.pop)
  const [captions, setCaptions] = useState(init.captions)
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
    window.history.replaceState(null, '', `?${new URLSearchParams({ v, scene, orb, skin, theme, size, style, pop, captions: captions ? 'on' : 'off' }).toString()}`)
  }, [v, scene, orb, skin, theme, size, style, pop, captions, init.bare])

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
    <div data-skin={skin} data-theme={theme} className="relative overflow-hidden bg-bg" style={{ width: w, height: h }}>
      <OrbLookContext.Provider value={orb}>
        <StyleContext.Provider value={style}>
          <PopContext.Provider value={{ pop, setPop }}>
            <CaptionsContext.Provider value={captions}>
              <PlacementContext.Provider
                value={{
                  placement: v.startsWith('next-') ? (v.slice(5) as Placement) : 'orb',
                  setPlacement: (next) => {
                    setV(`next-${next}`)
                    setPop('none')
                  },
                  setStyle
                }}
              >
                <Frame key={v.startsWith('next-') ? `${v}-${run}` : `${v}-${scene}-${run}`} v={v} sceneId={scene} />
              </PlacementContext.Provider>
            </CaptionsContext.Provider>
          </PopContext.Provider>
        </StyleContext.Provider>
      </OrbLookContext.Provider>
    </div>
  )
  if (init.bare) return frame

  const pill = (on: boolean): string =>
    `h-7 shrink-0 rounded-md px-2.5 text-xs font-medium transition-colors ${on ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:bg-neutral-200'}`

  return (
    <div className="flex h-full flex-col bg-neutral-100 text-neutral-900" style={{ fontFamily: 'system-ui, sans-serif' }}>
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2 border-b border-neutral-200 bg-white px-4 py-2">
        <div className="mr-2">
          <div className="text-sm font-semibold">Agent V · Voice view</div>
          <div className="text-xs text-neutral-500">Next: every placement, Quiet or Ambient · mockup</div>
        </div>
        <div className="flex items-center gap-0.5" role="group" aria-label="Direction">
          {DIRECTIONS.map((x) => (
            <button key={x.id} type="button" className={pill(x.id === v)} onClick={() => setV(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-0.5" role="group" aria-label="Scene">
          {SCENES.map((x) => (
            <button key={x.id} type="button" className={pill(x.id === scene)} onClick={() => setScene(x.id)}>
              {x.label}
            </button>
          ))}
        </div>
        <span className="flex-1" />
        <div className="flex items-center gap-0.5" role="group" aria-label="Style">
          {(['quiet', 'ambient'] as const).map((k) => (
            <button key={k} type="button" className={`${pill(k === style)} capitalize`} onClick={() => setStyle(k)}>
              {k}
            </button>
          ))}
        </div>
        <select value={pop} onChange={(e) => setPop(e.target.value as Pop)} className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-xs" aria-label="Open">
          {(['none', 'voice', 'devices', 'history', 'layout'] as const).map((k) => (
            <option key={k} value={k}>
              {k === 'none' ? 'Nothing open' : k === 'voice' ? 'Settings · Voice' : k === 'devices' ? 'Settings · Devices' : k === 'history' ? 'History drawer' : 'Settings · Layout'}
            </option>
          ))}
        </select>
        <button type="button" className={pill(!captions)} onClick={() => setCaptions(!captions)}>
          {captions ? 'Captions on' : 'Captions off'}
        </button>
        <select value={orb} onChange={(e) => setOrb(e.target.value as VoiceOrbLook)} className="h-7 rounded-md border border-neutral-300 bg-white px-2 text-xs" aria-label="Orb">
          {LOOKS.map((x) => (
            <option key={x.id} value={x.id}>
              Orb · {x.label}
            </option>
          ))}
        </select>
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
      </header>
      <div className="shrink-0 border-b border-neutral-200 bg-white px-4 py-1.5 text-xs text-neutral-600">{DIRECTIONS.find((x) => x.id === v)?.note}</div>
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
