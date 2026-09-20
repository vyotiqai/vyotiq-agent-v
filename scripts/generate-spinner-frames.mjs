// Renders the tray spinner frames into resources/tray/.
//
// The tray cannot run CSS, so the animation styles.css draws live has to be
// baked into PNGs here. Only the app-wide default variant is baked: the tray
// shows one animation, and the other variants exist for in-app callers.
//
// Every frame is sampled off that variant's own keyframes, read straight from
// the values the stylesheet declares. Change a duration or a stop there and the
// matching entry in BAKEABLE has to move with it — nothing checks that for you.
//
// Outputs (17 files per theme per size, 2 themes, 2 sizes):
//   <theme>/<size>/00..15.png   one cycle
//   <theme>/<size>/idle.png     resting pose, shown when nothing is running
//   manifest.json               what the tray needs to play them back
//
// Run: node scripts/generate-spinner-frames.mjs   (pnpm sync:spinner)

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'

const ROOT = process.cwd()
const OUT_DIR = join(ROOT, 'resources', 'tray')
const GEOMETRY_FILE = join(ROOT, 'src', 'shared', 'brand', 'vyotiqMark.ts')

// Keep in step with AGENT_V_SPINNER in src/renderer/src/lib/brand/AgentVSpinner.tsx.
// Hard-coded rather than imported because this is a .mjs build script and that
// is a .tsx; it must name a key of BAKEABLE below.
const VARIANT = 'relay'

const FRAMES = 16
const SIZES = [16, 32]

// Directory names say which app theme the frame is for, not what colour the ink
// is: a dark theme needs light ink. Both are that theme's --vy-fg in styles.css.
const THEMES = {
  dark: '#E8EDF0',
  light: '#17232B'
}

/** Solves a CSS timing function for one point in the cycle. */
function cubicBezier(x1, y1, x2, y2) {
  const curve = (a, b, t) => {
    const inv = 1 - t
    return 3 * inv * inv * t * a + 3 * inv * t * t * b + t * t * t
  }
  const slope = (a, b, t) => {
    const inv = 1 - t
    return 3 * inv * inv * a + 6 * inv * t * (b - a) + 3 * t * t * (1 - b)
  }
  return (x) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    // Newton converges in a handful of steps for these control points; the
    // bisection fallback covers the flat stretches where the slope vanishes.
    let t = x
    for (let i = 0; i < 8; i += 1) {
      const error = curve(x1, x2, t) - x
      if (Math.abs(error) < 1e-7) return curve(y1, y2, t)
      const d = slope(x1, x2, t)
      if (Math.abs(d) < 1e-7) break
      t -= error / d
    }
    let low = 0
    let high = 1
    t = x
    for (let i = 0; i < 32; i += 1) {
      const value = curve(x1, x2, t)
      if (Math.abs(value - x) < 1e-7) break
      if (value > x) high = t
      else low = t
      t = (low + high) / 2
    }
    return curve(y1, y2, t)
  }
}

const snap = cubicBezier(0.2, 0.8, 0.2, 1)
const easeInOut = cubicBezier(0.42, 0, 0.58, 1)

const lerp = (from, to, at) => from + (to - from) * at
/** CSS runs an infinite animation forever, so a delay is just a phase shift. */
const wrap = (phase) => ((phase % 1) + 1) % 1

/**
 * Opacity of one relay facet at a point in its own cycle. Mirrors
 * `@keyframes vy-agv-relay` — 0.26 up to 1 by 13%, back down by 44%, then a
 * hold — with the ease-in-out the rule applies between each pair of stops.
 */
function relayOpacity(phase) {
  const p = wrap(phase)
  if (p < 0.13) return lerp(0.26, 1, easeInOut(p / 0.13))
  if (p < 0.44) return lerp(1, 0.26, easeInOut((p - 0.13) / 0.31))
  return 0.26
}

/**
 * The variants the tray can reproduce as flat frames, and how to sample one.
 * `frame` returns the drawing state at a point in the cycle; `rest` is the
 * unanimated mark, which is what idle.png shows.
 *
 * Only the two that have been the default live here. orbit, pulse, bloom, iris
 * and vee are pure transform/opacity as well and would slot in the same way;
 * gleam would not, since its band needs a clip the flat renderer has no notion of.
 */
const BAKEABLE = {
  // One 120-degree snap per beat, then a hold. The mark has exact 3-fold
  // rotational symmetry, so 120 degrees lands back on itself: the loop closes
  // with no seam and the tail frames come out byte-identical to frame 00.
  ratchet: {
    durationMs: 820,
    rest: { rotate: 0 },
    frame: (p) => ({ rotate: 120 * snap(Math.min(p / 0.55, 1)) })
  },
  // Each facet takes the light in turn, clockwise from top-right. The delays in
  // the stylesheet are a third of a cycle apart (400ms and 800ms of 1200ms).
  relay: {
    durationMs: 1200,
    rest: { facets: { tr: 1, br: 1, l: 1 } },
    frame: (p) => ({
      facets: {
        tr: relayOpacity(p),
        br: relayOpacity(p - 400 / 1200),
        l: relayOpacity(p - 800 / 1200)
      }
    })
  }
}

/**
 * The geometry is parsed out of the generated module rather than copied, so
 * `pnpm sync:brand` stays the one place the mark's shape is defined. The file
 * is machine-written, which is what makes matching it this bluntly safe.
 *
 * The path order is positional and matches AgentVSpinner.tsx: core, then the
 * bottom-right, left and top-right facets.
 */
function readMarkGeometry() {
  const source = readFileSync(GEOMETRY_FILE, 'utf8')
  const viewBox = source.match(/VYOTIQ_MARK_VIEW_BOX\s*=\s*'([^']+)'/)?.[1]
  const block = source.match(/VYOTIQ_MARK_PATHS\s*=\s*\[([\s\S]*?)\]/)?.[1]
  if (!viewBox || !block) {
    throw new Error(`Could not read the mark geometry from ${GEOMETRY_FILE} — run \`pnpm sync:brand\`?`)
  }
  const paths = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
  if (paths.length !== 4) {
    throw new Error(`Expected 4 mark paths in ${GEOMETRY_FILE}, found ${paths.length}`)
  }
  const [core, br, l, tr] = paths
  return { viewBox, core, facets: { tr, br, l } }
}

function svgFor(geometry, state, ink) {
  const [minX, minY, width, height] = geometry.viewBox.split(/\s+/).map(Number)
  const cx = (minX + width / 2).toFixed(3)
  const cy = (minY + height / 2).toFixed(3)

  const paint = (d, opacity) =>
    `<path fill="${ink}"${opacity === undefined || opacity >= 1 ? '' : ` opacity="${opacity.toFixed(4)}"`} d="${d}"/>`

  const facets = ['tr', 'br', 'l']
    .map((key) => paint(geometry.facets[key], state.facets?.[key]))
    .join('')
  const body = `${facets}${paint(geometry.core, undefined)}`
  const open = state.rotate ? `<g transform="rotate(${state.rotate.toFixed(4)} ${cx} ${cy})">` : '<g>'

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${geometry.viewBox}">
  ${open}${body}</g>
</svg>`
}

function render(svg, size) {
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
}

const spec = BAKEABLE[VARIANT]
if (!spec) {
  throw new Error(`Variant "${VARIANT}" cannot be baked — add it to BAKEABLE or pick another default`)
}

const geometry = readMarkGeometry()
let written = 0

for (const [theme, ink] of Object.entries(THEMES)) {
  for (const size of SIZES) {
    const dir = join(OUT_DIR, theme, String(size))
    mkdirSync(dir, { recursive: true })
    for (let frame = 0; frame < FRAMES; frame += 1) {
      const png = render(svgFor(geometry, spec.frame(frame / FRAMES), ink), size)
      writeFileSync(join(dir, `${String(frame).padStart(2, '0')}.png`), png)
      written += 1
    }
    // The still mark, not a frame of the cycle: a tray with nothing running
    // should read as the app's icon rather than as a paused animation.
    writeFileSync(join(dir, 'idle.png'), render(svgFor(geometry, spec.rest, ink), size))
    written += 1
  }
}

// LF, and pinned to it in .gitattributes: a dev checkout and a packaged build
// share one userData, so a CRLF rewrite here would show up as a phantom diff.
const manifest = { variant: VARIANT, frames: FRAMES, durationMs: spec.durationMs, sizes: SIZES }
writeFileSync(join(OUT_DIR, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`.replace(/\r\n/g, '\n'))

console.log(`Wrote ${written} ${VARIANT} tray frames to ${OUT_DIR}`)
