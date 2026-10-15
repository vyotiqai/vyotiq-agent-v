import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ActionsProvider } from './glass/actions'
import { AnatomyComposer } from './glass/A'
import { ShapeComposer } from './glass/B'
import { useLiquidLens, useReducedTransparency } from './glass/liquid'
import { SCENES, type SceneId } from './glass/scenes'
import { GlassProvider, useGlass } from './glass/store'

/*
  The mockup viewer — scaffolding, not part of the design, so it uses
  Tailwind's stock neutral palette rather than the --vy-* tokens.

  ?v=<a|b|both>&m=<frosted|liquid>&scene=<id>&bare=1&rt=1

  rt=1 honours the system's reduced transparency (Windows: Transparency
  effects off), as the app would. Without it the viewer previews the glass
  anyway, since judging the material is the point of the page.
*/

type View = 'a' | 'b' | 'both'
type Material = 'frosted' | 'liquid'
const VIEWS: { id: View; label: string }[] = [
  { id: 'a', label: 'A · Your anatomy' },
  { id: 'b', label: 'B · Reference shape' },
  { id: 'both', label: 'Side by side' }
]
const MATERIALS: { id: Material; label: string; title: string }[] = [
  { id: 'frosted', label: 'Frosted', title: 'Blurred and tinted, like the reference' },
  { id: 'liquid', label: 'Liquid', title: 'Clear, with a lens rim that bends the backdrop' }
]
const W = 940
const HGT = 660

function read(): { v: View; m: Material; scene: SceneId; bare: boolean; preview: boolean } {
  const p = new URLSearchParams(window.location.search)
  const v = (['a', 'b', 'both'] as View[]).includes(p.get('v') as View) ? (p.get('v') as View) : 'both'
  const m: Material = p.get('m') === 'liquid' ? 'liquid' : 'frosted'
  const scene = SCENES.some((s) => s.id === p.get('scene')) ? (p.get('scene') as SceneId) : 'idle'
  return { v, m, scene, bare: p.get('bare') === '1', preview: p.get('rt') !== '1' }
}

/**
 * Where the composer sits, by the surface it is on now: the brief at the top,
 * the line at the bottom. Start task turns the one into the other.
 */
function Stage({ variant }: { variant: 'a' | 'b' }) {
  const { scene } = useGlass()
  const top = scene.surface === 'brief'
  return (
    <>
      <div className={top ? 'gx-scrim-top pointer-events-none absolute inset-0' : 'gx-scrim-bottom pointer-events-none absolute inset-0'} />
      <div className={top ? 'relative flex min-h-0 flex-1 flex-col' : 'relative flex min-h-0 flex-1 flex-col justify-end'}>
        {variant === 'a' ? <AnatomyComposer /> : <ShapeComposer />}
      </div>
    </>
  )
}

/** One glass frame: the backdrop, a scrim where the composer sits, the composer. */
function Frame({
  variant,
  sceneId,
  material,
  preview,
  nonce = 0
}: {
  variant: 'a' | 'b'
  sceneId: SceneId
  material: Material
  preview: boolean
  /** Bumped when the scene is picked again: the frame starts over from it. */
  nonce?: number
}) {
  const [layer, setLayer] = useState<HTMLDivElement | null>(null)
  const reduce = useReducedTransparency()
  useLiquidLens(layer, material === 'liquid' && (preview || !reduce))
  const entry = SCENES.find((s) => s.id === sceneId) ?? SCENES[0]!
  return (
    <div
      ref={setLayer}
      data-skin="native"
      data-theme="dark"
      data-variant={variant}
      data-material={material}
      className={[
        'gx gx-stage relative flex flex-col overflow-hidden font-sans text-sm text-fg',
        material === 'liquid' ? 'gx-liquid' : '',
        preview ? 'gx-preview' : ''
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ width: W, height: HGT, transform: 'translateZ(0)' }}
    >
      <GlassProvider key={`${variant}-${sceneId}-${material}-${nonce}`} scene={entry.scene} layer={layer}>
        <ActionsProvider>
          <Stage variant={variant} />
        </ActionsProvider>
      </GlassProvider>
    </div>
  )
}

export function Viewer() {
  const init = read()
  const [view, setView] = useState<View>(init.v)
  const [material, setMaterial] = useState<Material>(init.m)
  const [preview, setPreview] = useState(init.preview)
  const reduce = useReducedTransparency()
  const [scene, setScene] = useState<SceneId>(init.scene)
  const [nonce, setNonce] = useState(0)
  const stage = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(1)
  const frames = view === 'both' ? 2 : 1

  // Tooltips portal to <body>: give the document the frames' skin, theme and glass.
  useEffect(() => {
    const root = document.documentElement
    root.dataset.skin = 'native'
    root.dataset.theme = 'dark'
    root.classList.add('gx')
  }, [])

  // The document is a .gx too, so it has to agree with the frames on the preview.
  useEffect(() => {
    document.documentElement.classList.toggle('gx-preview', preview)
  }, [preview])

  useEffect(() => {
    if (init.bare) return
    const q = new URLSearchParams({ v: view, m: material, scene })
    if (!preview) q.set('rt', '1')
    window.history.replaceState(null, '', `?${q.toString()}`)
  }, [view, material, scene, preview, init.bare])

  useLayoutEffect(() => {
    const el = stage.current
    if (!el) return
    const fit = (): void => {
      const across = frames * W + (frames - 1) * 24
      setScale(Math.min(1, (el.clientWidth - 32) / across, (el.clientHeight - 56) / HGT))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(el)
    return () => ro.disconnect()
  }, [frames])

  if (init.bare) {
    return (
      <div className="flex min-h-full gap-6 bg-neutral-950 p-0">
        {view !== 'b' ? <Frame variant="a" sceneId={scene} material={material} preview={preview} /> : null}
        {view !== 'a' ? <Frame variant="b" sceneId={scene} material={material} preview={preview} /> : null}
      </div>
    )
  }

  const groups = [...new Set(SCENES.map((s) => s.group))]
  const pill = (on: boolean): string =>
    `h-7 shrink-0 whitespace-nowrap rounded-md px-2.5 text-xs focus-visible:vy-focus-ring ${on ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100'}`

  return (
    <div className="flex h-full bg-neutral-950 font-sans text-neutral-200">
      <nav className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-neutral-800 p-3" aria-label="Scenes">
        <div>
          <div className="text-sm font-semibold text-neutral-100">Glass composer</div>
          <div className="mt-0.5 text-caption leading-4 text-neutral-500">The composer and its popovers, replicated from source, in the reference’s dark glass.</div>
        </div>
        {groups.map((g) => (
          <div key={g} className="flex flex-col gap-0.5">
            <div className="px-2 pb-1 text-caption font-semibold uppercase tracking-wider text-neutral-500">{g}</div>
            {SCENES.filter((s) => s.group === g).map((s) => (
              <button
                key={s.id}
                type="button"
                aria-pressed={s.id === scene}
                onClick={() => {
                  setScene(s.id)
                  setNonce((n) => n + 1)
                }}
                className={`h-7 rounded-md px-2 text-left text-xs focus-visible:vy-focus-ring ${s.id === scene ? 'bg-neutral-800 text-neutral-50' : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100'}`}
              >
                {s.label}
              </button>
            ))}
          </div>
        ))}
      </nav>
      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-11 shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-800 px-3">
          {VIEWS.map((v) => (
            <button key={v.id} type="button" aria-pressed={v.id === view} onClick={() => setView(v.id)} className={pill(v.id === view)}>
              {v.label}
            </button>
          ))}
          <span className="mx-2 h-4 w-px bg-neutral-800" aria-hidden="true" />
          {MATERIALS.map((m) => (
            <button
              key={m.id}
              type="button"
              aria-pressed={m.id === material}
              title={m.title}
              onClick={() => setMaterial(m.id)}
              className={pill(m.id === material)}
            >
              {m.label}
            </button>
          ))}
          {reduce ? (
            <>
              <span className="mx-2 h-4 w-px bg-neutral-800" aria-hidden="true" />
              <button
                type="button"
                aria-pressed={preview}
                title="Windows' Transparency effects is off, so the app would draw these surfaces solid. On: preview the glass anyway. Off: see what you would get."
                onClick={() => setPreview((v) => !v)}
                className={pill(preview)}
              >
                Preview glass
              </button>
              <span className="shrink-0 whitespace-nowrap text-caption text-neutral-500">Transparency effects are off on this PC</span>
            </>
          ) : null}
          <span className="ml-auto shrink-0 whitespace-nowrap pl-3 text-caption text-neutral-500">Every control works: click, type, @, / and the app’s keys. Pick a scene again to reset it.</span>
        </div>
        <div ref={stage} className="relative min-h-0 flex-1 overflow-hidden">
          <div
            className="absolute left-1/2 top-1/2 flex gap-6"
            style={{ transform: `translate(-50%, -50%) scale(${scale})`, transformOrigin: 'center' }}
          >
            {view !== 'b' ? (
              <figure className="m-0 flex flex-col gap-2">
                <figcaption className="text-xs text-neutral-400">A · Your anatomy</figcaption>
                <Frame variant="a" sceneId={scene} material={material} preview={preview} nonce={nonce} />
              </figure>
            ) : null}
            {view !== 'a' ? (
              <figure className="m-0 flex flex-col gap-2">
                <figcaption className="text-xs text-neutral-400">B · Reference shape</figcaption>
                <Frame variant="b" sceneId={scene} material={material} preview={preview} nonce={nonce} />
              </figure>
            ) : null}
          </div>
        </div>
      </main>
    </div>
  )
}
