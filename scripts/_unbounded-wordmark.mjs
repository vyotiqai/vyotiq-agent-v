import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import opentype from 'opentype.js'
import sharp from 'sharp'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const fontPath = join(root, 'resources', 'branding', 'fonts', 'Unbounded[wght].ttf')

const LETTERS = ['V', 'Y', 'O', 'T', 'I', 'Q']
const MASTER = 240
const MEASURE_SCALE = 6
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision"'
const TRACKING_EM = 0.05
const MIN_GAP_EM = 0.068
const PAIR_TARGET_EM = {
  VY: 0.082,
  YO: 0.128,
  OT: 0.122,
  TI: 0.118,
  IQ: 0.128
}

function paths(placed, fill) {
  return placed
    .map((g) => `<path d="${g.d}" fill="${fill}" transform="translate(${g.x.toFixed(3)} 0)"/>`)
    .join('\n  ')
}

export async function createUnboundedWordmark() {
  const buf = readFileSync(fontPath)
  const font = opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
  if (!font.variation) throw new Error('Unbounded variable table missing')
  font.variation.set({ wght: 400 })

  const UPM = font.unitsPerEm
  const SCALE = MASTER / UPM
  const CAP = 750 * SCALE
  const TOP = 764 * SCALE
  const TAIL = 52 * SCALE
  const PAD = 48
  const BASELINE = PAD + TOP
  const GLYPH_H = BASELINE + TAIL + PAD

  const pathOf = (ch) =>
    font.getPath(ch, 0, BASELINE, MASTER, { variation: { wght: 400 } }).toPathData(3)

  const advanceOf = (ch) => {
    const g = font.charToGlyph(ch)
    return font.variation.getTransform(g, { wght: 400 }).advanceWidth * SCALE
  }

  async function profile(ch) {
    const advance = advanceOf(ch)
    const d = pathOf(ch)
    const w = Math.ceil(advance + PAD * 2)
    const svg = `<svg ${SVG_NS} viewBox="0 0 ${w} ${GLYPH_H}" width="${w}" height="${GLYPH_H}">
  <rect width="${w}" height="${GLYPH_H}" fill="#000"/>
  <path d="${d}" fill="#fff" transform="translate(${PAD} 0)"/>
</svg>`
    const png = new Resvg(svg, {
      fitTo: { mode: 'width', value: Math.round(w * MEASURE_SCALE) },
      shapeRendering: 2,
      imageRendering: 0,
      font: { loadSystemFonts: false }
    })
      .render()
      .asPng()
    const { data, info } = await sharp(png).greyscale().raw().toBuffer({ resolveWithObject: true })
    const left = new Float64Array(info.height)
    const right = new Float64Array(info.height)
    left.fill(Number.POSITIVE_INFINITY)
    right.fill(Number.NEGATIVE_INFINITY)
    let minX = info.width
    let maxX = -1
    let minY = info.height
    let maxY = -1
    for (let y = 0; y < info.height; y++) {
      const row = y * info.width
      for (let x = 0; x < info.width; x++) {
        if (data[row + x] < 96) continue
        if (x < left[y]) left[y] = x
        if (x > right[y]) right[y] = x
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
    const originPx = PAD * MEASURE_SCALE
    for (let y = 0; y < info.height; y++) {
      if (Number.isFinite(left[y])) left[y] = (left[y] - originPx) / MEASURE_SCALE
      if (Number.isFinite(right[y])) right[y] = (right[y] - originPx) / MEASURE_SCALE
    }
    return {
      ch,
      d,
      advance,
      left,
      right,
      ink: {
        x1: (minX - originPx) / MEASURE_SCALE,
        x2: (maxX - originPx) / MEASURE_SCALE,
        y1: minY / MEASURE_SCALE,
        y2: maxY / MEASURE_SCALE
      }
    }
  }

  function opticalGap(a, b, xB) {
    const gaps = []
    const n = Math.min(a.right.length, b.left.length)
    for (let y = 0; y < n; y++) {
      const ra = a.right[y]
      const lb = b.left[y]
      if (!Number.isFinite(ra) || !Number.isFinite(lb)) continue
      gaps.push(xB + lb - ra)
    }
    if (!gaps.length) return xB
    gaps.sort((m, n) => m - n)
    const min = gaps[0]
    const limit = Math.max(min * 1.22, min + 0.01 * MASTER)
    const tight = gaps.filter((g) => g <= limit).slice(0, 24)
    return tight.reduce((s, g) => s + g, 0) / tight.length
  }

  function layout(glyphs, deltas) {
    const placed = []
    let x = 0
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i]
      placed.push({ ...g, x })
      x += g.advance
      if (i < glyphs.length - 1) {
        const pair = g.ch + glyphs[i + 1].ch
        x += TRACKING_EM * MASTER + (deltas[pair] ?? 0)
      }
    }
    return { placed, width: x }
  }

  const glyphs = []
  for (const ch of LETTERS) glyphs.push(await profile(ch))

  const native = layout(glyphs, {})
  const pairs = []
  for (let i = 0; i < glyphs.length - 1; i++) {
    pairs.push({
      pair: glyphs[i].ch + glyphs[i + 1].ch,
      a: glyphs[i],
      b: glyphs[i + 1],
      xB: native.placed[i + 1].x - native.placed[i].x
    })
  }

  const minGap = MIN_GAP_EM * MASTER
  const deltas = {}
  for (const { pair, a, b } of pairs) {
    const target = Math.max(minGap, (PAIR_TARGET_EM[pair] ?? 0.12) * MASTER)
    let lo = -0.18 * MASTER
    let hi = 0.04 * MASTER
    for (let n = 0; n < 32; n++) {
      const mid = (lo + hi) / 2
      const trial = layout(glyphs, { ...deltas, [pair]: mid })
      const ai = trial.placed.find((p) => p.ch === pair[0])
      const bi = trial.placed.find((p) => p.ch === pair[1])
      if (opticalGap(a, b, bi.x - ai.x) < target) lo = mid
      else hi = mid
    }
    deltas[pair] = (lo + hi) / 2
  }

  const { placed } = layout(glyphs, deltas)
  const o = placed.find((g) => g.ch === 'O')
  const q = placed.find((g) => g.ch === 'Q')
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const g of placed) {
    x1 = Math.min(x1, g.x + g.ink.x1)
    x2 = Math.max(x2, g.x + g.ink.x2)
    y1 = Math.min(y1, g.ink.y1)
    y2 = Math.max(y2, g.ch === 'Q' ? o.ink.y2 : g.ink.y2)
  }
  const box = { x1, y1, x2, y2, w: x2 - x1, h: y2 - y1 }
  const tail = Math.max(0, q.ink.y2 - o.ink.y2)

  return {
    cap: CAP,
    box,
    tail,
    group(fill, scale = 1) {
      return `<g transform="scale(${scale.toFixed(6)}) translate(${(-box.x1).toFixed(3)} ${(-box.y1).toFixed(3)})">
  ${paths(placed, fill)}
</g>`
    }
  }
}
