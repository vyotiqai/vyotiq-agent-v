import { useEffect, useRef, useState } from 'react'
import type { HomeBackdrop as HomeBackdropKind } from '@shared/appearance'

/*
  The band behind Home's head (Settings › Appearance › Home backdrop):

    pixels  a dithered cloud field drawn on a canvas in the skin's colours
    field   soft pools of the accent over the page: CSS only (vy-home-field)
    image   the picture the person picked, read from main and drawn pulled
            toward the page colour so text over it stays readable

  Colours come from the --vy-* tokens where the band sits, read again when
  <html>'s skin or theme changes (a system theme flip included), so all ten
  combinations draw their own.
  Decorative: aria-hidden, no pointer events, gone under More contrast.
*/

/** `data-skin`/`data-theme` on <html>, as one string that moves when either does. */
function usePaintKey(): string {
  const read = (): string => {
    const root = document.documentElement
    return `${root.getAttribute('data-skin') ?? ''}:${root.getAttribute('data-theme') ?? ''}`
  }
  const [key, setKey] = useState(read)
  useEffect(() => {
    const mo = new MutationObserver(() => setKey(read()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })
    return () => mo.disconnect()
  }, [])
  return key
}

/**
 * Place it inside Home's scrolling page (position: relative): as an absolute
 * child of the scroller it scrolls away with the head on its own.
 */
export function HomeBackdrop({
  kind,
  imageStamp
}: {
  kind: HomeBackdropKind
  /** Moves when a new picture is picked: read it again. */
  imageStamp: string
}) {
  const paint = usePaintKey()
  const [image, setImage] = useState<string | null>(null)

  useEffect(() => {
    if (kind !== 'image' || !imageStamp) {
      setImage(null)
      return
    }
    let cancelled = false
    void window.vyotiq?.appearanceReadHomeBackdrop?.().then((res) => {
      if (!cancelled) setImage(res?.ok ? res.data.dataUrl : null)
    })
    return () => {
      cancelled = true
    }
  }, [kind, imageStamp])

  if (kind === 'none') return null
  return (
    <div aria-hidden="true" className="vy-home-band" data-home-backdrop={kind}>
      {kind === 'field' ? (
        <div className="vy-home-field absolute inset-0" />
      ) : kind === 'image' && image ? (
        <ImageLayer src={image} paint={paint} />
      ) : (
        // An image setting with no picture yet (or one that failed to read) shows the generated field.
        <PixelClouds paint={paint} />
      )}
    </div>
  )
}

/** Any CSS colour as sRGB bytes, by letting a 1×1 canvas parse it. */
function rgbOf(color: string): [number, number, number] {
  const c = document.createElement('canvas')
  c.width = c.height = 1
  const x = c.getContext('2d')
  if (!x) return [0, 0, 0]
  x.fillStyle = color
  x.fillRect(0, 0, 1, 1)
  const d = x.getImageData(0, 0, 1, 1).data
  return [d[0]!, d[1]!, d[2]!]
}

/**
 * How far a picked picture may stray from the page colour, per channel,
 * before the scrim. A picture can be pure white under a dark theme; at these
 * spreads a pure-white or pure-black picture still leaves muted text at AA
 * once the 70% scrim is on (measured 2026-10-17: ≥ 4.67:1 in every skin).
 */
export const IMAGE_SPREAD = { dark: 0.3, light: 0.22 } as const

/** Pull every pixel toward `bg` by `k`: 0 is the page colour, 1 the picture as it is. */
export function toneTowards(px: Uint8ClampedArray, bg: readonly [number, number, number], k: number): void {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = bg[0] + (px[i]! - bg[0]) * k
    px[i + 1] = bg[1] + (px[i + 1]! - bg[1]) * k
    px[i + 2] = bg[2] + (px[i + 2]! - bg[2]) * k
    px[i + 3] = 255
  }
}

/**
 * Size the backing store to device pixels and draw in CSS pixels: at 150%
 * scaling a canvas sized to its CSS box is stretched, which blurs the
 * one-pixel gaps the clouds are made of.
 */
function fitCanvas(canvas: HTMLCanvasElement, opts?: CanvasRenderingContext2DSettings) {
  const { clientWidth: w, clientHeight: h } = canvas
  if (!w || !h) return null
  const dpr = window.devicePixelRatio || 1
  canvas.width = Math.round(w * dpr)
  canvas.height = Math.round(h * dpr)
  const ctx = canvas.getContext('2d', opts)
  if (!ctx) return null
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  return { ctx, w, h }
}

function useCanvasDraw(draw: (canvas: HTMLCanvasElement) => void, deps: readonly unknown[]) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const run = (): void => draw(canvas)
    run()
    const ro = new ResizeObserver(run)
    ro.observe(canvas)
    return () => ro.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `draw` is rebuilt each render; `deps` say when it changes
  }, deps)
  return ref
}

function ImageLayer({ src, paint }: { src: string; paint: string }) {
  const [img, setImg] = useState<HTMLImageElement | null>(null)
  useEffect(() => {
    let cancelled = false
    const next = new Image()
    next.onload = () => {
      if (!cancelled) setImg(next)
    }
    next.onerror = () => {
      if (!cancelled) setImg(null)
    }
    next.src = src
    return () => {
      cancelled = true
    }
  }, [src])
  const ref = useCanvasDraw(
    (canvas) => {
      if (!img) return
      const fit = fitCanvas(canvas, { willReadFrequently: true })
      if (!fit) return
      const { ctx, w, h } = fit
      // Cover: fill the band, crop the overflow, centred.
      const scale = Math.max(w / img.naturalWidth, h / img.naturalHeight)
      const dw = img.naturalWidth * scale
      const dh = img.naturalHeight * scale
      ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh)
      const bg = rgbOf(getComputedStyle(canvas).getPropertyValue('--vy-bg').trim())
      const dark = 0.2126 * bg[0] + 0.7152 * bg[1] + 0.0722 * bg[2] < 128
      // Every device pixel, not the CSS box: getImageData ignores the transform.
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
      toneTowards(data.data, bg, dark ? IMAGE_SPREAD.dark : IMAGE_SPREAD.light)
      ctx.putImageData(data, 0, 0)
    },
    [img, paint]
  )
  if (!img) return <PixelClouds paint={paint} />
  return <canvas ref={ref} className="absolute inset-0 size-full" />
}

/** Seeded value noise, smoothed, in a few octaves: cloud banks rather than static. */
function noise2(seed: number) {
  const hash = (x: number, y: number): number => {
    let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
    h = Math.imul(h ^ (h >>> 13), 1274126177)
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295
  }
  const smooth = (t: number): number => t * t * (3 - 2 * t)
  const at = (x: number, y: number): number => {
    const xi = Math.floor(x)
    const yi = Math.floor(y)
    const tx = smooth(x - xi)
    const ty = smooth(y - yi)
    const a = hash(xi, yi)
    const b = hash(xi + 1, yi)
    const c = hash(xi, yi + 1)
    const d = hash(xi + 1, yi + 1)
    return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty
  }
  return (x: number, y: number): number => {
    let sum = 0
    let amp = 0.55
    let freq = 1
    for (let o = 0; o < 4; o++) {
      sum += at(x * freq, y * freq) * amp
      amp *= 0.5
      freq *= 2.1
    }
    return sum
  }
}

/** 4×4 ordered dither: the step pattern that makes tones read as pixel art. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5].map((v) => (v + 0.5) / 16)

function PixelClouds({ paint }: { paint: string }) {
  const ref = useCanvasDraw(
    (canvas) => {
      const fit = fitCanvas(canvas)
      if (!fit) return
      const { ctx, w, h } = fit
      const css = getComputedStyle(canvas)
      const bg = css.getPropertyValue('--vy-bg').trim()
      const accent = css.getPropertyValue('--vy-accent').trim()
      const light = css.getPropertyValue('--vy-fg-strong').trim()
      const warm = css.getPropertyValue('--vy-warning').trim()
      const field = noise2(7)
      const cell = 6
      // The sky: the page washed with the accent, deeper at the top.
      ctx.globalAlpha = 1
      ctx.fillStyle = bg
      ctx.fillRect(0, 0, w, h)
      const sky = ctx.createLinearGradient(0, 0, 0, h)
      sky.addColorStop(0, accent)
      sky.addColorStop(1, bg)
      ctx.globalAlpha = 0.32
      ctx.fillStyle = sky
      ctx.fillRect(0, 0, w, h)
      for (let y = 0; y < h; y += cell) {
        for (let x = 0; x < w; x += cell) {
          // Banks rise from the bottom: more cloud lower down.
          const lift = 0.5 + 0.55 * (y / h)
          const v = field(x / 260, y / 180) * lift
          const t = BAYER[((y / cell) % 4) * 4 + ((x / cell) % 4)]!
          const tone = v * 1.6 - 0.45
          if (tone < t * 0.6) continue
          const lit = tone > 0.62 + t * 0.3
          ctx.globalAlpha = lit ? 0.42 : 0.22
          ctx.fillStyle = lit ? light : warm
          // One pixel of gap per block: the grid that reads as pixel art.
          ctx.fillRect(x, y, cell - 1, cell - 1)
        }
      }
      ctx.globalAlpha = 1
    },
    [paint]
  )
  return <canvas ref={ref} className="absolute inset-0 size-full" />
}
