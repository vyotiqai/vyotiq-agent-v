// Round 8: geometric / modular / signal marks.
// Usage: node scripts/brand-variants8.mjs
import { writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'resources', 'branding', 'v8')
mkdirSync(outDir, { recursive: true })

const themes = {
  dark: { bg: '#0a0a0a', border: '#262626', fg: '#fafafa' },
  light: { bg: '#ffffff', border: '#e5e5e5', fg: '#0a0a0a' }
}

const f = (n) => Math.round(n * 10) / 10

const tile = (mark, c) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">
  <rect width="1024" height="1024" rx="224" fill="${c.bg}"/>
  <rect x="1" y="1" width="1022" height="1022" rx="223" fill="none" stroke="${c.border}" stroke-width="2"/>
  ${mark}
</svg>`

// 1 — APEX: bold upward chevron with a dot at the peak
const apex = (c) =>
  `<path d="M 352 648 L 512 360 L 672 648" fill="none" stroke="${c.fg}" stroke-width="96" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="512" cy="360" r="24" fill="${c.fg}"/>`

// 2 — PRISM: regular body-diagonal isometric cube (hexagon + three full diagonals)
const prism = (c) => {
  const R = 220, y = R / 2, x = f(R * Math.sqrt(3) / 2)
  return `<path d="M 512 ${512 - R} L ${512 + x} ${512 - y} L ${512 + x} ${512 + y} L 512 ${512 + R} L ${512 - x} ${512 + y} L ${512 - x} ${512 - y} Z" fill="${c.fg}"/>
  <path d="M 512 ${512 - R} L 512 ${512 + R} M ${512 + x} ${512 - y} L ${512 - x} ${512 + y} M ${512 + x} ${512 + y} L ${512 - x} ${512 - y}" stroke="${c.bg}" stroke-width="22" fill="none" stroke-linecap="round"/>`
}

// 3 — ORBIT: solid core + sweeping arc + satellite dot
const orbit = (c) =>
  `<circle cx="512" cy="512" r="64" fill="${c.fg}"/>
  <path d="M 512 220 A 292 292 0 1 1 512 804" fill="none" stroke="${c.fg}" stroke-width="48" stroke-linecap="round"/>
  <circle cx="512" cy="220" r="32" fill="${c.fg}"/>`

// 4 — PULSE: three rounded bars of staggered height
const pulse = (c) =>
  `<rect x="360" y="640" width="80" height="160" rx="40" fill="${c.fg}"/>
  <rect x="472" y="440" width="80" height="360" rx="40" fill="${c.fg}"/>
  <rect x="584" y="560" width="80" height="240" rx="40" fill="${c.fg}"/>`

// 5 — LAYER: three stacked, offset rounded bars
const layer = (c) =>
  `<rect x="272" y="360" width="480" height="100" rx="40" fill="${c.fg}"/>
  <rect x="312" y="480" width="480" height="100" rx="40" fill="${c.fg}"/>
  <rect x="352" y="600" width="480" height="100" rx="40" fill="${c.fg}"/>`

// 6 — BEACON: concentric arcs radiating from a core dot
const beacon = (c) =>
  `<path d="M 220 512 A 292 292 0 0 1 804 512" fill="none" stroke="${c.fg}" stroke-width="52" stroke-linecap="round"/>
  <path d="M 292 512 A 220 220 0 0 1 732 512" fill="none" stroke="${c.fg}" stroke-width="48" stroke-linecap="round"/>
  <path d="M 364 512 A 148 148 0 0 1 660 512" fill="none" stroke="${c.fg}" stroke-width="44" stroke-linecap="round"/>
  <circle cx="512" cy="512" r="28" fill="${c.fg}"/>`

// 7 — NODE: central hub connected to four outer nodes
const node = (c) =>
  `<g transform="rotate(45 512 512)">
    <circle cx="512" cy="512" r="72" fill="${c.fg}"/>
    <line x1="512" y1="512" x2="512" y2="240" stroke="${c.fg}" stroke-width="36" stroke-linecap="round"/>
    <line x1="512" y1="512" x2="240" y2="512" stroke="${c.fg}" stroke-width="36" stroke-linecap="round"/>
    <line x1="512" y1="512" x2="784" y2="512" stroke="${c.fg}" stroke-width="36" stroke-linecap="round"/>
    <line x1="512" y1="512" x2="512" y2="784" stroke="${c.fg}" stroke-width="36" stroke-linecap="round"/>
    <circle cx="512" cy="240" r="48" fill="${c.fg}"/>
    <circle cx="240" cy="512" r="48" fill="${c.fg}"/>
    <circle cx="784" cy="512" r="48" fill="${c.fg}"/>
    <circle cx="512" cy="784" r="48" fill="${c.fg}"/>
  </g>`

// 8 — FOCUS: concentric circular target rings
const focus = (c) =>
  `<circle cx="512" cy="512" r="100" fill="none" stroke="${c.fg}" stroke-width="48"/>
  <circle cx="512" cy="512" r="200" fill="none" stroke="${c.fg}" stroke-width="48"/>
  <circle cx="512" cy="512" r="300" fill="none" stroke="${c.fg}" stroke-width="48"/>`

const marks = { apex, prism, orbit, pulse, layer, beacon, node, focus }

for (const [name, markFn] of Object.entries(marks)) {
  for (const [themeName, c] of Object.entries(themes)) {
    const svg = tile(markFn(c), c)
    const base = `${name}-${themeName}`
    writeFileSync(join(outDir, `${base}.svg`), svg)
    writeFileSync(join(outDir, `${base}.png`), new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render().asPng())
    console.log(base)
  }
}
