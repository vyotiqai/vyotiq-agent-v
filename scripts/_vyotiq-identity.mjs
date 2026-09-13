import { existsSync, mkdirSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { createUnboundedWordmark } from './_unbounded-wordmark.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'branding', 'identity')
const fontFile = join(root, 'resources', 'branding', 'fonts', 'Unbounded[wght].ttf')
const typeDir = join(root, 'resources', 'branding', 'type')
const fontDir = join(root, 'resources', 'branding', 'fonts')

mkdirSync(outDir, { recursive: true })
for (const name of readdirSync(outDir)) unlinkSync(join(outDir, name))
if (existsSync(typeDir)) rmSync(typeDir, { recursive: true, force: true })

const CX = 512
const CY = 512
const f = (n) => n.toFixed(4)
const RASTER_SCALE = 4
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision"'
const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const mul = (a, s) => [a[0] * s, a[1] * s]
const hypot = (a) => Math.hypot(a[0], a[1]) || 1
const norm = (v) => mul(v, 1 / hypot(v))
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const lineIntersect = (p, u, q, v) => {
  const det = u[0] * v[1] - u[1] * v[0]
  if (Math.abs(det) < 1e-9) return p
  const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det
  return add(p, mul(u, t))
}
const signedArea = (pts) => {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    a += p[0] * q[1] - q[0] * p[1]
  }
  return a
}
const offsetEdges = (pts, dists) => {
  const n = pts.length
  const ccw = signedArea(pts) > 0
  const edges = []
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    const e = sub(b, a)
    const inward = ccw ? norm([-e[1], e[0]]) : norm([e[1], -e[0]])
    edges.push({ p: add(a, mul(inward, dists[i])), d: norm(e) })
  }
  return edges.map((e1, i) => {
    const e0 = edges[(i - 1 + n) % n]
    return lineIntersect(e0.p, e0.d, e1.p, e1.d)
  })
}
const poly = (pts, fill) =>
  `<path d="${pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${f(p[0])} ${f(p[1])}`).join(' ')} Z" fill="${fill}"/>`

const MARK_R = 384
const MARK_G = 24
const MARK_SPAN = MARK_R * 2

function hexagon(R = MARK_R, cx = CX, cy = CY) {
  const w = (R * Math.sqrt(3)) / 2
  return [
    [cx, cy - R],
    [cx + w, cy - R / 2],
    [cx + w, cy + R / 2],
    [cx, cy + R],
    [cx - w, cy + R / 2],
    [cx - w, cy - R / 2]
  ]
}

function areaCentroid(faces) {
  let A = 0
  let cx = 0
  let cy = 0
  for (const pts of faces) {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]
      const q = pts[(i + 1) % pts.length]
      const cross = p[0] * q[1] - q[0] * p[1]
      A += cross
      cx += (p[0] + q[0]) * cross
      cy += (p[1] + q[1]) * cross
    }
  }
  A *= 0.5
  if (Math.abs(A) < 1e-9) return [CX, CY]
  return [cx / (6 * A), cy / (6 * A)]
}

function vyotiq(fill) {
  const V = hexagon()
  const T = [mid(V[1], V[2]), mid(V[3], V[4]), mid(V[5], V[0])]
  const g = MARK_G
  const faces = [
    offsetEdges([T[0], T[1], T[2]], [g, g, g]),
    offsetEdges([T[0], V[2], V[3], T[1]], [0, 0, 0, g]),
    offsetEdges([T[1], V[4], V[5], T[2]], [0, 0, 0, g]),
    offsetEdges([T[2], V[0], V[1], T[0]], [0, 0, 0, g])
  ]
  const c = areaCentroid(faces)
  const shift = [CX - c[0], CY - c[1]]
  return faces.map((face) => poly(face.map((p) => add(p, shift)), fill)).join('\n  ')
}

const icon = (mark, bg, fg) => `<svg ${SVG_NS} viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" fill="${bg}"/>
  ${mark(fg)}
</svg>`

const markOnly = (mark, fg) => `<svg ${SVG_NS} viewBox="0 0 1024 1024" width="1024" height="1024">
  ${mark(fg)}
</svg>`

function lockup(mark, wm, bg, fg) {
  const markPx = 164
  const padX = 80
  const padY = 64
  const markScale = markPx / MARK_SPAN
  const hexW = MARK_R * Math.sqrt(3) * markScale
  const cap = markPx * 0.44
  const s = cap / wm.cap
  const wmW = wm.box.w * s
  const wmH = wm.box.h * s
  const tail = wm.tail * s
  const gap = 60
  const W = Math.ceil(padX + hexW + gap + wmW + padX)
  const H = Math.ceil(Math.max(markPx, wmH + tail) + padY * 2)
  const cx = padX + hexW / 2
  const cy = H / 2
  const textX = padX + hexW + gap
  const textY = cy - wmH / 2
  return {
    W,
    svg: `<svg ${SVG_NS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g transform="translate(${cx} ${cy}) scale(${markScale}) translate(-512 -512)">
    ${mark(fg)}
  </g>
  <g transform="translate(${textX.toFixed(3)} ${textY.toFixed(3)})">
    ${wm.group(fg, s)}
  </g>
</svg>`
  }
}

function stacked(mark, wm, bg, fg) {
  const markPx = 384
  const padX = 112
  const padY = 104
  const markScale = markPx / MARK_SPAN
  const hexW = MARK_R * Math.sqrt(3) * markScale
  const s = (hexW * 0.94) / wm.box.w
  const wmW = wm.box.w * s
  const wmH = wm.box.h * s
  const tail = wm.tail * s
  const gap = 48
  const W = Math.ceil(Math.max(hexW, wmW) + padX * 2)
  const H = Math.ceil(padY + markPx + gap + wmH + tail + padY)
  const mx = W / 2
  const my = padY + markPx / 2
  const textX = (W - wmW) / 2
  const textY = padY + markPx + gap
  return {
    W,
    svg: `<svg ${SVG_NS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g transform="translate(${mx} ${my}) scale(${markScale}) translate(-512 -512)">
    ${mark(fg)}
  </g>
  <g transform="translate(${textX.toFixed(3)} ${textY.toFixed(3)})">
    ${wm.group(fg, s)}
  </g>
</svg>`
  }
}

function wordmarkBoard(wm, bg, fg) {
  const padX = wm.cap * 0.78
  const padY = wm.cap * 0.56
  const W = Math.ceil(wm.box.w + padX * 2)
  const H = Math.ceil(wm.box.h + padY * 2 + wm.tail)
  return {
    W,
    svg: `<svg ${SVG_NS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  <g transform="translate(${padX.toFixed(3)} ${padY.toFixed(3)})">
    ${wm.group(fg, 1)}
  </g>
</svg>`
  }
}

function sizeProof(bg, fg, muted) {
  const SIZES = [16, 24, 32, 48, 64, 128, 256, 512]
  const pad = 56
  const gap = 36
  const labelH = 36
  const cell = 80
  const small = SIZES.filter((s) => s <= 64)
  const large = SIZES.filter((s) => s > 64)
  const row1W = small.length * cell + (small.length - 1) * gap
  const row2W = large.reduce((a, s) => a + s, 0) + (large.length - 1) * gap
  const W = pad * 2 + Math.max(row1W, row2W)
  const row2H = Math.max(...large)
  const H = pad * 2 + 28 + cell + labelH + 48 + row2H + labelH
  const inner = icon(vyotiq, bg, fg)
    .replace(/<svg[^>]*>/, '')
    .replace('</svg>', '')
    .replace(
      /<rect width="1024" height="1024"/,
      `<rect width="1024" height="1024" rx="${Math.round(1024 * 0.18)}"`
    )
  const place = (size, x, y, box) => {
    const s = size / 1024
    const ox = x + (box - size) / 2
    const oy = y + (box - size) / 2
    return `<g transform="translate(${ox} ${oy}) scale(${s})">${inner}</g>
  <text x="${x + box / 2}" y="${y + box + 22}" text-anchor="middle" font-family="Unbounded" font-weight="400" font-size="11" letter-spacing="1.4" fill="${muted}">${size}</text>`
  }
  const parts = [
    `<text x="${pad}" y="${pad + 8}" font-family="Unbounded" font-weight="400" font-size="12" letter-spacing="3.2" fill="${muted}">VYOTIQ.COM</text>`
  ]
  small.forEach((size, i) => {
    parts.push(place(size, pad + i * (cell + gap), pad + 28, cell))
  })
  let x = pad
  const y2 = pad + 28 + cell + labelH + 48
  large.forEach((size) => {
    parts.push(place(size, x, y2, size))
    x += size + gap
  })
  return {
    W,
    svg: `<svg ${SVG_NS} viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">
  <rect width="${W}" height="${H}" fill="${bg}"/>
  ${parts.join('\n  ')}
</svg>`
  }
}

const png = (svg, w) =>
  new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.round(w * RASTER_SCALE) },
    shapeRendering: 2,
    textRendering: 1,
    imageRendering: 0,
    font: {
      fontFiles: [fontFile],
      loadSystemFonts: false,
      defaultFontFamily: 'Unbounded'
    }
  })
    .render()
    .asPng()

const write = (name, svg, width) => {
  writeFileSync(join(outDir, `${name}.svg`), svg)
  writeFileSync(join(outDir, `${name}.png`), png(svg, width))
}

const wm = await createUnboundedWordmark()
const dark = ['#000000', '#ffffff']
const light = ['#ffffff', '#000000']

const markDark = icon(vyotiq, ...dark)
write('vyotiq.com-dark', markDark, 1024)
write('vyotiq.com-light', icon(vyotiq, ...light), 1024)
write('vyotiq.com-white', markOnly(vyotiq, '#ffffff'), 1024)
write('vyotiq.com-black', markOnly(vyotiq, '#000000'), 1024)
writeFileSync(join(root, 'resources', 'icon.png'), png(markDark, 1024 / RASTER_SCALE))

const lockDark = lockup(vyotiq, wm, ...dark)
const lockLight = lockup(vyotiq, wm, ...light)
write('vyotiq.com-lockup-dark', lockDark.svg, lockDark.W)
write('vyotiq.com-lockup-light', lockLight.svg, lockLight.W)

const stackDark = stacked(vyotiq, wm, ...dark)
const stackLight = stacked(vyotiq, wm, ...light)
write('vyotiq.com-stack-dark', stackDark.svg, stackDark.W)
write('vyotiq.com-stack-light', stackLight.svg, stackLight.W)

const wordDark = wordmarkBoard(wm, ...dark)
const wordLight = wordmarkBoard(wm, ...light)
write('vyotiq-wordmark-dark', wordDark.svg, wordDark.W)
write('vyotiq-wordmark-light', wordLight.svg, wordLight.W)

writeFileSync(
  join(outDir, 'vyotiq-white.svg'),
  `<svg ${SVG_NS} viewBox="0 0 ${wm.box.w.toFixed(3)} ${(wm.box.h + wm.tail).toFixed(3)}" width="${wm.box.w.toFixed(3)}" height="${(wm.box.h + wm.tail).toFixed(3)}">
  ${wm.group('#ffffff', 1)}
</svg>`
)
writeFileSync(
  join(outDir, 'vyotiq-black.svg'),
  `<svg ${SVG_NS} viewBox="0 0 ${wm.box.w.toFixed(3)} ${(wm.box.h + wm.tail).toFixed(3)}" width="${wm.box.w.toFixed(3)}" height="${(wm.box.h + wm.tail).toFixed(3)}">
  ${wm.group('#000000', 1)}
</svg>`
)

const proofDark = sizeProof('#000000', '#ffffff', '#ffffff')
const proofLight = sizeProof('#ffffff', '#000000', '#000000')
write('_proof-sizes-dark', proofDark.svg, proofDark.W)
write('_proof-sizes-light', proofLight.svg, proofLight.W)

for (const name of readdirSync(fontDir)) {
  if (name !== 'Unbounded[wght].ttf') unlinkSync(join(fontDir, name))
}

console.log(outDir)
console.log(readdirSync(outDir).join('\n'))
