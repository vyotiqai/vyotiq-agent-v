// Renders the taskbar overlay badge PNGs into resources/badges/.
//
// The badge inherits the Vyotiq mark's pointy-top hexagon geometry so it reads
// as part of the icon rather than a generic circle stuck on it. Digits use
// Segoe UI Bold (Windows taskbar's own face) loaded from the system fonts dir.
//
// Outputs (32x32, Electron/Windows scale overlays):
//   working.png                    accent hex, no text
//   attention-1..9.png, attention-10.png ("9+")   amber hex, dark digit
//   unread-1..9.png,    unread-10.png    ("9+")   red hex, white digit
//
// Run: node scripts/gen-badge-icons.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const OUT_DIR = join(process.cwd(), 'resources', 'badges')

const ACCENT = '#4FB3E8'
const WARNING = '#FBBF24'
const DANGER = '#F87171'
const OUTLINE = '#141414'
const INK_ON_WARNING = '#231A02'
const INK_ON_DANGER = '#FFFFFF'

// Pointy-top hexagon, same orientation as the app mark.
const HEX_POINTS = '16,1.5 29,8.75 29,23.25 16,30.5 3,23.25 3,8.75'

const FONT_FILES = [
  'C:/Windows/Fonts/segoeui.ttf',
  'C:/Windows/Fonts/segoeuib.ttf'
]

function svg({ fill, ink, label }) {
  const text = label
    ? `<text x="16" y="16" text-anchor="middle" dominant-baseline="central"
         font-family="Segoe UI" font-weight="700"
         font-size="${label.length > 1 ? 13 : 17}" fill="${ink}">${label}</text>`
    : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
  <polygon points="${HEX_POINTS}" fill="${fill}" stroke="${OUTLINE}" stroke-width="2"/>
  ${text}
</svg>`
}

function render(label, outName, fill, ink) {
  const resvg = new Resvg(svg({ fill, ink, label }), {
    fitTo: { mode: 'width', value: 32 },
    font: { fontFiles: FONT_FILES, loadSystemFonts: false, defaultFontFamily: 'Segoe UI' }
  })
  const png = resvg.render().asPng()
  writeFileSync(join(OUT_DIR, outName), png)
}

mkdirSync(OUT_DIR, { recursive: true })

render('', 'working.png', ACCENT, INK_ON_WARNING)

const targets = [
  ['attention', WARNING, INK_ON_WARNING],
  ['unread', DANGER, INK_ON_DANGER]
]
for (const [name, fill, ink] of targets) {
  for (let n = 1; n <= 9; n += 1) render(String(n), `${name}-${n}.png`, fill, ink)
  render('9+', `${name}-10.png`, fill, ink)
}

console.log(`Wrote badge overlays to ${OUT_DIR}`)
