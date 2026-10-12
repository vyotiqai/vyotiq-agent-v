import { useEffect, useState } from 'react'

/*
  Liquid glass: the backdrop is bent, not just blurred.

  Every `.gx-glass` / `.gx-pop` in the frame gets its own SVG filter, used as
  its backdrop-filter (Chromium — and so Electron — renders `url()` there).
  The filter displaces the backdrop by a map drawn from the element's real
  shape: flat in the middle, and over a bezel along the edge a convex rim
  that refracts like a lens, so what sits under the rim is pulled in from
  further inside. The map is redrawn whenever the element's size or radius
  changes (the pill growing as words wrap, a popover opening).

  The rim's highlight follows the pointer (`--gx-lx` / `--gx-ly`, read by
  styles.css). The caller turns it off when the reader asks for less
  transparency, and the solid fallback stands in.
*/

const NS = 'http://www.w3.org/2000/svg'
const LENSES = '.gx-glass, .gx-pop'
const STEPS = 256

/**
 * The rim's sideways shift across the bezel, 0 at the edge to 1 inside, as
 * a fraction of the largest. The surface is a convex squircle,
 * h(t) = (1 − (1 − t)⁴)^¼: steep at the edge, flat by the bezel's end. Each
 * point's tilt refracts through glass of index 1.5, and the shift follows
 * tan(θ − θᵣ).
 */
const SHIFT: Float32Array = (() => {
  const out = new Float32Array(STEPS)
  const n = 1.5
  let max = 0
  for (let i = 0; i < STEPS; i++) {
    const t = Math.max(0.015, i / (STEPS - 1))
    const u = 1 - t
    const slope = u ** 3 * (1 - u ** 4) ** -0.75
    const theta = Math.atan(slope * 0.35)
    const v = Math.tan(theta - Math.asin(Math.sin(theta) / n))
    out[i] = v
    max = Math.max(max, v)
  }
  for (let i = 0; i < STEPS; i++) out[i] = out[i]! / max
  return out
})()

type Lens = { id: string; filter: SVGFilterElement; key: string }

/** The displacement map for a rounded rectangle, as a data URL, and the filter scale it is encoded for. */
function drawMap(w: number, h: number, r: number, bezel: number, reach: number): { url: string; scale: number } {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) return { url: '', scale: 0 }
  const img = ctx.createImageData(w, h)
  const px = img.data
  const scale = reach * 2
  const hx = w / 2 - r
  const hy = h / 2 - r
  for (let y = 0; y < h; y++) {
    const py = y + 0.5 - h / 2
    const qy = Math.abs(py) - hy
    for (let x = 0; x < w; x++) {
      const pxx = x + 0.5 - w / 2
      const qx = Math.abs(pxx) - hx
      // Signed distance to the rounded rectangle; depth is how far inside the edge.
      const depth = r - Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) - Math.min(Math.max(qx, qy), 0)
      let dx = 0
      let dy = 0
      if (depth > 0 && depth < bezel) {
        let nx = 0
        let ny = 0
        if (qx > 0 && qy > 0) {
          const l = Math.hypot(qx, qy)
          nx = qx / l
          ny = qy / l
        } else if (qx > qy) nx = 1
        else ny = 1
        const m = SHIFT[Math.min(STEPS - 1, Math.floor((depth / bezel) * STEPS))]! * reach
        // Sample from further in: the convex rim magnifies what is under it.
        dx = -Math.sign(pxx) * nx * m
        dy = -Math.sign(py) * ny * m
      }
      const i = (y * w + x) * 4
      px[i] = Math.round(255 * (0.5 + dx / scale))
      px[i + 1] = Math.round(255 * (0.5 + dy / scale))
      px[i + 2] = 128
      px[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
  return { url: canvas.toDataURL(), scale }
}

function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** One filter: soften a touch (popovers more, so rows read), bend, then lift the colour the way glass does. */
function buildFilter(id: string, w: number, h: number, map: { url: string; scale: number }, soften: number): SVGFilterElement {
  const box = { x: 0, y: 0, width: w, height: h }
  const filter = el('filter', {
    id,
    ...box,
    filterUnits: 'userSpaceOnUse',
    primitiveUnits: 'userSpaceOnUse',
    'color-interpolation-filters': 'sRGB'
  })
  filter.append(
    el('feGaussianBlur', { in: 'SourceGraphic', stdDeviation: soften, result: 'soft' }),
    el('feImage', { href: map.url, ...box, preserveAspectRatio: 'none', result: 'map' }),
    el('feDisplacementMap', { in: 'soft', in2: 'map', scale: map.scale, xChannelSelector: 'R', yChannelSelector: 'G', result: 'bent' }),
    el('feColorMatrix', { in: 'bent', type: 'saturate', values: 1.25 })
  )
  return filter
}

/** Whether the reader asked for less transparency (on Windows: Transparency effects off). */
export function useReducedTransparency(): boolean {
  const query = '(prefers-reduced-transparency: reduce)'
  const [reduce, setReduce] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = (): void => setReduce(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return reduce
}

/** Bends the backdrop under every glass surface in `layer` while `on`. */
export function useLiquidLens(layer: HTMLElement | null, on: boolean): void {
  useEffect(() => {
    if (!layer || !on) return undefined
    const svg = el('svg', { 'aria-hidden': 'true', width: 0, height: 0 })
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
    const defs = el('defs', {})
    svg.append(defs)
    layer.append(svg)
    const lenses = new Map<HTMLElement, Lens>()
    let next = 0

    const fit = (node: HTMLElement): void => {
      const w = node.offsetWidth
      const h = node.offsetHeight
      if (!w || !h) return
      const r = Math.min(parseFloat(getComputedStyle(node).borderTopLeftRadius) || 0, w / 2, h / 2)
      const key = `${w}x${h}r${r}`
      const cur = lenses.get(node)
      if (cur?.key === key) return
      const pop = node.classList.contains('gx-pop')
      const bezel = Math.max(8, Math.min(18, r * 0.65))
      const reach = bezel * 0.85
      const id = cur?.id ?? `gx-lens-${++next}`
      const filter = buildFilter(id, w, h, drawMap(w, h, r, bezel, reach), pop ? 5 : 0.7)
      if (cur) cur.filter.replaceWith(filter)
      else defs.append(filter)
      lenses.set(node, { id, filter, key })
      node.style.setProperty('backdrop-filter', `url(#${id})`)
      node.style.setProperty('-webkit-backdrop-filter', `url(#${id})`)
    }

    const ro = new ResizeObserver((entries) => {
      for (const e of entries) fit(e.target as HTMLElement)
    })
    const scan = (): void => {
      layer.querySelectorAll<HTMLElement>(LENSES).forEach((node) => {
        if (lenses.has(node)) return
        ro.observe(node)
        fit(node)
      })
      for (const [node, lens] of lenses) {
        if (node.isConnected) continue
        ro.unobserve(node)
        lens.filter.remove()
        lenses.delete(node)
      }
    }
    const mo = new MutationObserver(scan)
    mo.observe(layer, { childList: true, subtree: true })
    scan()

    // The light follows the pointer: each surface's rim brightens nearest it.
    const move = (e: PointerEvent): void => {
      for (const node of lenses.keys()) {
        const b = node.getBoundingClientRect()
        node.style.setProperty('--gx-lx', `${(((e.clientX - b.left) / b.width) * 100).toFixed(1)}%`)
        node.style.setProperty('--gx-ly', `${(((e.clientY - b.top) / b.height) * 100).toFixed(1)}%`)
      }
    }
    const leave = (): void => {
      for (const node of lenses.keys()) {
        node.style.removeProperty('--gx-lx')
        node.style.removeProperty('--gx-ly')
      }
    }
    layer.addEventListener('pointermove', move)
    layer.addEventListener('pointerleave', leave)

    return () => {
      mo.disconnect()
      ro.disconnect()
      layer.removeEventListener('pointermove', move)
      layer.removeEventListener('pointerleave', leave)
      for (const node of lenses.keys()) {
        for (const p of ['backdrop-filter', '-webkit-backdrop-filter', '--gx-lx', '--gx-ly']) node.style.removeProperty(p)
      }
      svg.remove()
    }
  }, [layer, on])
}
