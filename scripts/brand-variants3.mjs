// Round 3 concepts: organic continuous forms (knot / burst / loop / trefoil).
// Usage: node scripts/brand-variants3.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'branding', 'v3')
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
const pt = (...a) => P(...a).map(f).join(' ')

// 1 — BLOOM: 6 woven vesica petals, stroke-only, slight swirl
const bloom = (c) => {
  let g = ''
  for (let i = 0; i < 6; i++) {
    const t = -90 + i * 60
    const tip = pt(390, t)
    const c1 = pt(250, t - 30), c2 = pt(250, t + 30)
    g += `<path d="M ${CX},${CY} Q ${c1} ${tip} Q ${c2} ${CX},${CY}" fill="none" stroke="${c.fg}" stroke-width="46" stroke-linejoin="round"/>`
  }
  return g
}

// 2 — BURST: 12 tapered rays, alternating length, slight rotational offset
const burst = (c) => {
  let g = ''
  for (let i = 0; i < 12; i++) {
    const t = -90 + i * 30 + 7 // swirl offset
    const rOut = i % 2 === 0 ? 400 : 330
    const b1 = pt(150, t - 5.5), b2 = pt(150, t + 5.5), tip = pt(rOut, t)
    g += `<polygon points="${b1} ${tip} ${b2}" fill="${c.fg}"/>`
  }
  return g
}

// 3 — INFINITY: lemniscate, single continuous stroke
const infinityMark = (c) => {
  const r = 170
  const l1 = f(CX - 2 * r), r1 = f(CX + 2 * r)
  return `<path d="M ${CX},${CY}
    A ${r} ${r} 0 1 1 ${l1},${CY}
    A ${r} ${r} 0 1 1 ${CX},${CY}
    A ${r} ${r} 0 1 0 ${r1},${CY}
    A ${r} ${r} 0 1 0 ${CX},${CY} Z"
    fill="none" stroke="${c.fg}" stroke-width="62"/>`
}

// 4 — TRIQUETRA: three interlocking rings (mutual overlap trefoil)
const triquetra = (c) => {
  let g = ''
  for (let i = 0; i < 3; i++) {
    const ctr = P(150, -90 + i * 120)
    g += `<circle cx="${f(ctr[0])}" cy="${f(ctr[1])}" r="235" fill="none" stroke="${c.fg}" stroke-width="54"/>`
  }
  return g
}

const marks = { bloom, burst, infinity: infinityMark, triquetra }

const tile = (mark, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="224" fill="${c.bg}"/>
  <rect x="1" y="1" width="1022" height="1022" rx="223" fill="none" stroke="${c.border}" stroke-width="2"/>
  ${mark}
</svg>`

for (const [name, markFn] of Object.entries(marks)) {
  for (const [themeName, c] of Object.entries(themes)) {
    const svg = tile(markFn(c), c)
    const base = `${name}-${themeName}`
    writeFileSync(join(outDir, `${base}.svg`), svg)
    writeFileSync(join(outDir, `${base}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng())
    console.log(base)
  }
}
