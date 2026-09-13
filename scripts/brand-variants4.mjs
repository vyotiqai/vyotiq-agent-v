// Round 4: Bloom family variants.
// Usage: node scripts/brand-variants4.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'branding', 'v4')
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

const petal = (t, tipR, cR, cSpread) =>
  `M ${CX},${CY} Q ${pt(cR, t - cSpread)} ${pt(tipR, t)} Q ${pt(cR, t + cSpread)} ${CX},${CY}`

// 1 — BLOOM-8: 8 denser petals
const bloom8 = (c) => {
  let g = ''
  for (let i = 0; i < 8; i++) {
    const t = -90 + i * 45
    g += `<path d="${petal(t, 390, 250, 20)}" fill="none" stroke="${c.fg}" stroke-width="40" stroke-linejoin="round"/>`
  }
  return g
}

// 2 — BLOOM-SOLID: 8 fat filled petals, thin negative gaps between
const bloomSolid = (c) => {
  let g = ''
  for (let i = 0; i < 8; i++) {
    const t = -90 + i * 45
    g += `<path d="${petal(t, 400, 265, 19.5)} Z" fill="${c.fg}"/>`
  }
  return g
}

// 3 — BLOOM-KNOT: petals anchored on inner ring, weave gaps punched via mask
const bloomKnot = (c) => {
  let petals = '', holes = ''
  for (let i = 0; i < 6; i++) {
    const t = -90 + i * 60
    const a = pt(130, t - 17), tip = pt(390, t), b = pt(130, t + 17)
    const c1 = pt(300, t - 26), c2 = pt(300, t + 26)
    petals += `<path d="M ${a} Q ${c1} ${tip} Q ${c2} ${b}" fill="none" stroke="${c.fg}" stroke-width="46" stroke-linecap="round"/>`
    const h = P(136, t + 30)
    holes += `<circle cx="${f(h[0])}" cy="${f(h[1])}" r="24"/>`
  }
  return `<mask id="k"><rect width="1024" height="1024" fill="white"/><g fill="black">${holes}</g></mask>
    <g mask="url(#k)">${petals}</g>`
}

// 4 — BLOOM-SWIRL: asymmetric controls, rotational motion
const bloomSwirl = (c) => {
  let g = ''
  for (let i = 0; i < 6; i++) {
    const t = -90 + i * 60
    g += `<path d="M ${CX},${CY} Q ${pt(255, t - 38)} ${pt(385, t)} Q ${pt(255, t + 14)} ${CX},${CY}" fill="none" stroke="${c.fg}" stroke-width="44" stroke-linejoin="round"/>`
  }
  return g
}

// 5 — BLOOM-DUO: outer stroke petals + inner solid petal star, offset 30deg
const bloomDuo = (c) => {
  let g = ''
  for (let i = 0; i < 6; i++) {
    const t = -90 + i * 60
    g += `<path d="${petal(t, 395, 250, 26)}" fill="none" stroke="${c.fg}" stroke-width="40" stroke-linejoin="round"/>`
    g += `<path d="${petal(t + 30, 155, 105, 22)} Z" fill="${c.fg}"/>`
  }
  return g
}

// 6 — BLOOM-LOOP: 6 overlapping teardrop loops around open center
const bloomLoop = (c) => {
  let g = ''
  for (let i = 0; i < 6; i++) {
    const t = -90 + i * 60
    const ctr = P(195, t)
    g += `<ellipse cx="${f(ctr[0])}" cy="${f(ctr[1])}" rx="88" ry="185" fill="none" stroke="${c.fg}" stroke-width="40" transform="rotate(${t + 90} ${f(ctr[0])} ${f(ctr[1])})"/>`
  }
  return g
}

const marks = { bloom8, 'bloom-solid': bloomSolid, 'bloom-knot': bloomKnot, 'bloom-swirl': bloomSwirl, 'bloom-duo': bloomDuo, 'bloom-loop': bloomLoop }

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
