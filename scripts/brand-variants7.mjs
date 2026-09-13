// Round 7: tapered-petal / calligraphic-stroke family + geometric wordmark.
// Usage: node scripts/brand-variants7.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'branding', 'v7')
mkdirSync(outDir, { recursive: true })

const themes = {
  dark: { bg: '#0a0a0a', border: '#262626', fg: '#fafafa' },
  light: { bg: '#ffffff', border: '#e5e5e5', fg: '#0a0a0a' }
}

const CX = 512, CY = 512
const P = (r, deg, cx = CX, cy = CY) => {
  const a = (deg * Math.PI) / 180
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
}
const f = (n) => Math.round(n * 10) / 10
const pt = (p) => `${f(p[0])} ${f(p[1])}`

// Tapered S-curved petal from base B to tip T: swelling middle, pointed ends.
// w = half-width at middle, bend = tangential S-curve offset.
const petalBT = (B, T, w, bend) => {
  const M = [(B[0] + T[0]) / 2, (B[1] + T[1]) / 2]
  const dx = T[0] - B[0], dy = T[1] - B[1]
  const len = Math.hypot(dx, dy)
  const dir = [dx / len, dy / len]
  const perp = [-dir[1], dir[0]]
  const c1 = [M[0] + perp[0] * w + dir[0] * bend, M[1] + perp[1] * w + dir[1] * bend]
  const c2 = [M[0] - perp[0] * w + dir[0] * bend, M[1] - perp[1] * w + dir[1] * bend]
  return `M ${pt(B)} Q ${pt(c1)} ${pt(T)} Q ${pt(c2)} ${pt(B)} Z`
}
const petal = (angle, rIn, rOut, w, bend) => petalBT(P(rIn, angle), P(rOut, angle), w, bend)

// True S-curved petal: cubic edges, spine snaking laterally by ±s.
const petalS = (B, T, w, s) => {
  const dx = T[0] - B[0], dy = T[1] - B[1]
  const len = Math.hypot(dx, dy)
  const dir = [dx / len, dy / len]
  const perp = [-dir[1], dir[0]]
  const N = (t) => [B[0] + dir[0] * len * t, B[1] + dir[1] * len * t]
  const off = (p, k) => [p[0] + perp[0] * k, p[1] + perp[1] * k]
  const n1 = N(0.33), n2 = N(0.66)
  const c1a = off(n1, w + s), c1b = off(n2, w * 0.55 - s)
  const c2b = off(n2, -(w * 0.55 + s)), c2a = off(n1, -(w - s))
  return `M ${pt(B)} C ${pt(c1a)} ${pt(c1b)} ${pt(T)} C ${pt(c2b)} ${pt(c2a)} ${pt(B)} Z`
}

// 1 — FLARE: 12 swirl petals around solid core
const flare = (c) => {
  let g = `<circle cx="${CX}" cy="${CY}" r="84" fill="${c.fg}"/>`
  for (let i = 0; i < 12; i++) {
    g += `<path d="${petal(-90 + i * 30, 162, 400, 38, 48)}" fill="${c.fg}"/>`
  }
  return g
}

// 2 — CORONA: 10 petals, open center (no core), counter-swirl, alternating length
const corona = (c) => {
  let g = ''
  for (let i = 0; i < 10; i++) {
    const long = i % 2 === 0
    g += `<path d="${petal(-90 + i * 36, 172, long ? 398 : 348, 34, -44)}" fill="${c.fg}"/>`
  }
  return g
}

// 3 — EMBLEM: 5 mirrored flame strokes, seed silhouette
const emblem = (c) => {
  const petals = [
    petalBT([512, 810], [512, 210], 78, 12),         // center, vertical
    petalBT([392, 752], [428, 296], 64, -60),        // inner left
    petalBT([632, 752], [596, 296], 64, 60),         // inner right
    petalBT([288, 662], [360, 392], 56, -100),       // outer left
    petalBT([736, 662], [664, 392], 56, 100)         // outer right
  ]
  return petals.map((d) => `<path d="${d}" fill="${c.fg}"/>`).join('')
}

// 4 — MANDALA: dual-length 16-petal ring + core, slight swirl
const mandala = (c) => {
  let g = `<circle cx="${CX}" cy="${CY}" r="68" fill="${c.fg}"/>`
  for (let i = 0; i < 16; i++) {
    const long = i % 2 === 0
    g += `<path d="${petal(-90 + i * 22.5, long ? 140 : 182, long ? 398 : 302, long ? 32 : 28, 18)}" fill="${c.fg}"/>`
  }
  return g
}

// 5 — WING: 3 swept-back strokes, asymmetric speed
const wing = (c) =>
  [
    petalBT([296, 700], [730, 320], 72, -44),
    petalBT([326, 762], [646, 462], 56, -32),
    petalBT([366, 812], [562, 596], 42, -22)
  ].map((d) => `<path d="${d}" fill="${c.fg}"/>`).join('')

// 6 — FLAME: hero S-petal + two companions
const flame = (c) =>
  [
    petalS([512, 800], [548, 235], 62, 52),
    petalS([404, 748], [396, 420], 38, -34),
    petalS([630, 738], [660, 448], 36, 38)
  ].map((d) => `<path d="${d}" fill="${c.fg}"/>`).join('')

// 7 — BLOOM-IN: 12 petals pointing inward, open core
const bloomIn = (c) => {
  let g = ''
  for (let i = 0; i < 12; i++) {
    g += `<path d="${petal(-90 + i * 30, 392, 205, 34, 30)}" fill="${c.fg}"/>`
  }
  return g
}

// 8 — CRESCENT: 7-petal fan on upper arc, longest at top
const crescent = (c) => {
  let g = ''
  for (let i = 0; i < 7; i++) {
    const t = -165 + i * 25
    const rOut = 300 + 90 * Math.sin(((i / 6) * Math.PI))
    g += `<path d="${petal(t, 155, rOut, 36, 26)}" fill="${c.fg}"/>`
  }
  return `<g transform="translate(0 84)">${g}</g>`
}

// 9 — SWAY: single bold S-stroke + satellite dot
const sway = (c) => {
  const hero = petalS([470, 800], [560, 224], 68, 62)
  return `<path d="${hero}" fill="${c.fg}"/><circle cx="676" cy="292" r="52" fill="${c.fg}"/>`
}

// 10 — WORDMARK: custom geometric VYOTIQ, wide tracking, curved-tail Q
const wordmark = (c) => {
  const L = []
  const sw = 14
  const stroke = `fill="none" stroke="${c.fg}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"`
  // letters in local coords, cap top y=40, baseline y=160
  const glyphs = {
    V: { w: 110, d: `<polyline points="0,40 55,160 110,40" ${stroke}/>` },
    Y: { w: 90, d: `<polyline points="0,40 45,100 90,40" ${stroke}/><line x1="45" y1="100" x2="45" y2="160" ${stroke}/>` },
    O: { w: 116, d: `<circle cx="58" cy="100" r="58" ${stroke}/>` },
    T: { w: 100, d: `<line x1="0" y1="40" x2="100" y2="40" ${stroke}/><line x1="50" y1="40" x2="50" y2="160" ${stroke}/>` },
    I: { w: 0, d: `<line x1="0" y1="40" x2="0" y2="160" ${stroke}/>` },
    Q: { w: 116, d: `<circle cx="58" cy="98" r="58" ${stroke}/><path d="M 80 132 Q 100 158 126 166" ${stroke}/>` }
  }
  const track = 100
  let x = 0
  for (const ch of 'VYOTIQ') {
    const g = glyphs[ch]
    L.push(`<g transform="translate(${x} 0)">${g.d}</g>`)
    x += g.w + track
  }
  const total = x - track
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 640" width="1600" height="640">
  <rect width="1600" height="640" rx="150" fill="${c.bg}"/>
  <rect x="1" y="1" width="1598" height="638" rx="149" fill="none" stroke="${c.border}" stroke-width="2"/>
  <g transform="translate(${f((1600 - total) / 2)} 220)">${L.join('')}</g>
</svg>`
}

const squareTile = (mark, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="224" fill="${c.bg}"/>
  <rect x="1" y="1" width="1022" height="1022" rx="223" fill="none" stroke="${c.border}" stroke-width="2"/>
  ${mark}
</svg>`

for (const [name, markFn] of Object.entries({ flare, corona, emblem, mandala, wing, flame, 'bloom-in': bloomIn, crescent, sway })) {
  for (const [themeName, c] of Object.entries(themes)) {
    const svg = squareTile(markFn(c), c)
    const base = `${name}-${themeName}`
    writeFileSync(join(outDir, `${base}.svg`), svg)
    writeFileSync(join(outDir, `${base}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng())
    console.log(base)
  }
}
for (const [themeName, c] of Object.entries(themes)) {
  const svg = wordmark(c)
  const base = `wordmark-${themeName}`
  writeFileSync(join(outDir, `${base}.svg`), svg)
  writeFileSync(join(outDir, `${base}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 1024 } }).render().asPng())
  console.log(base)
}
