import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Resvg } from '@resvg/resvg-js'
import { createUnboundedWordmark } from './_unbounded-wordmark.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(root, 'resources', 'branding', 'precision-mono')
const SVG_NS = 'xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision"'
const RASTER_SCALE = 4
const CX = 512
const CY = 512
const MARK_R = 400
/**
 * Every gap in the mark reads this wide: the three channels between the faces,
 * and the three slots where a channel reaches the silhouette.
 *
 * The two are not drawn the same way. A channel is the triangle and a trapezoid
 * each pulling back from the edge they share, so it measures the sum of their
 * insets. A slot is the chord that same channel cuts as it crosses the hexagon's
 * edge — and it crosses at 60 degrees, so it opens 1/sin(60) wider than the
 * trapezoid pulled back. Inset both faces equally and the slots come out 64.66
 * against a 56 channel, 16% looser, which is what you see at the silhouette.
 * Splitting the gap in that ratio instead is what makes all six measure 56.
 */
/**
 * macOS draws app icons on its own grid: a squircle occupying 824 of a 1024
 * canvas, the rest transparent. It does not mask for you the way iOS does, so
 * a full-bleed square ships as a literal square in a Dock where nothing else
 * is one. Windows and Linux do want the square, so the two are separate
 * assets rather than one compromise.
 *
 * The corner is a superellipse rather than a plain `rx`: Apple's shape has
 * continuous curvature, and a circular corner reads visibly rounder beside it.
 * Exponent 5 is the usual approximation.
 */
const MACOS_CANVAS = 1024
const MACOS_SQUIRCLE = 824
const MACOS_EXPONENT = 5
/** Mark height as a share of the squircle — a hexagon reads solid at 0.55. */
const MACOS_MARK_SHARE = 0.55

const MARK_GAP = 56
const MARK_FACE_INSET = (MARK_GAP * Math.sin(Math.PI / 3)) / 2
const MARK_CORE_INSET = MARK_GAP - MARK_FACE_INSET
const MARK_SPAN = MARK_R * 2

mkdirSync(outDir, { recursive: true })

const add = (a, b) => [a[0] + b[0], a[1] + b[1]]
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]]
const mul = (a, s) => [a[0] * s, a[1] * s]
const norm = (v) => mul(v, 1 / (Math.hypot(v[0], v[1]) || 1))
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
const f = (n) => n.toFixed(3)

function lineIntersect(p, u, q, v) {
  const det = u[0] * v[1] - u[1] * v[0]
  if (Math.abs(det) < 1e-9) return p
  const t = ((q[0] - p[0]) * v[1] - (q[1] - p[1]) * v[0]) / det
  return add(p, mul(u, t))
}

function offsetEdges(points, distances) {
  const ccw = points.reduce(
    (area, point, index) => {
      const next = points[(index + 1) % points.length]
      return area + point[0] * next[1] - next[0] * point[1]
    },
    0
  ) > 0
  const edges = points.map((point, index) => {
    const next = points[(index + 1) % points.length]
    const edge = sub(next, point)
    const inward = ccw ? norm([-edge[1], edge[0]]) : norm([edge[1], -edge[0]])
    return { point: add(point, mul(inward, distances[index])), direction: norm(edge) }
  })
  return edges.map((edge, index) => {
    const previous = edges[(index - 1 + edges.length) % edges.length]
    return lineIntersect(previous.point, previous.direction, edge.point, edge.direction)
  })
}

function pathData(points) {
  const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${f(point[0])} ${f(point[1])}`).join(' ')
  return `${d} Z`
}

function hexagon() {
  const width = (MARK_R * Math.sqrt(3)) / 2
  return [
    [CX, CY - MARK_R],
    [CX + width, CY - MARK_R / 2],
    [CX + width, CY + MARK_R / 2],
    [CX, CY + MARK_R],
    [CX - width, CY + MARK_R / 2],
    [CX - width, CY - MARK_R / 2]
  ]
}

function areaCentroid(faces) {
  let area = 0
  let x = 0
  let y = 0
  for (const points of faces) {
    for (let index = 0; index < points.length; index++) {
      const point = points[index]
      const next = points[(index + 1) % points.length]
      const cross = point[0] * next[1] - next[0] * point[1]
      area += cross
      x += (point[0] + next[0]) * cross
      y += (point[1] + next[1]) * cross
    }
  }
  if (Math.abs(area) < 1e-9) return [CX, CY]
  return [x / (3 * area), y / (3 * area)]
}

/** The four faces, centred, as bare `d` strings. The one source of the mark. */
function precisionMarkFaces() {
  const outer = hexagon()
  const triangle = [mid(outer[1], outer[2]), mid(outer[3], outer[4]), mid(outer[5], outer[0])]
  const faces = [
    offsetEdges(triangle, [MARK_CORE_INSET, MARK_CORE_INSET, MARK_CORE_INSET]),
    offsetEdges([triangle[0], outer[2], outer[3], triangle[1]], [0, 0, 0, MARK_FACE_INSET]),
    offsetEdges([triangle[1], outer[4], outer[5], triangle[2]], [0, 0, 0, MARK_FACE_INSET]),
    offsetEdges([triangle[2], outer[0], outer[1], triangle[0]], [0, 0, 0, MARK_FACE_INSET])
  ]
  const centroid = areaCentroid(faces)
  const shift = [CX - centroid[0], CY - centroid[1]]
  return faces.map((face) => pathData(face.map((point) => add(point, shift))))
}

function precisionMark(fill) {
  return precisionMarkFaces()
    .map((d) => `<path d="${d}" fill="${fill}"/>`)
    .join('\n  ')
}

function svg({ width, height, viewBox, title, content }) {
  return `<svg ${SVG_NS} viewBox="${viewBox ?? `0 0 ${width} ${height}`}" width="${width}" height="${height}" role="img" aria-label="${title}">
  <title>${title}</title>
  ${content}
</svg>\n`
}

/**
 * The standalone mark is cropped to the hexagon instead of keeping the 1024
 * canvas the faces are laid out on. The hexagon is 692.82 x 800, so that canvas
 * held 166 units of nothing on each side and 112 above and below: at a 16px
 * favicon only 10.8 x 12.5px of it was ever ink. The crop is square and taken on
 * the taller axis, so the file keeps a 1:1 intrinsic ratio and `width=N
 * height=N` stays honest for Nav, the favicon and every other square slot.
 *
 * Only this asset moves. The lockups, the stack, the social card and the app
 * icon place the mark through markGroup(), which carries its own translate off
 * the 1024 layout and is unaffected.
 */
function markAsset(fill) {
  return svg({
    width: MARK_SPAN,
    height: MARK_SPAN,
    viewBox: `${CX - MARK_R} ${CY - MARK_R} ${MARK_SPAN} ${MARK_SPAN}`,
    title: 'Vyotiq mark',
    content: precisionMark(fill)
  })
}

function markGroup(fill, size, x, y) {
  const scale = size / MARK_SPAN
  return `<g transform="translate(${f(x)} ${f(y)}) scale(${f(scale)}) translate(-512 -512)">
    ${precisionMark(fill)}
  </g>`
}

function lockupAsset(fill, wordmark) {
  const markSize = 164
  const padX = 80
  const padY = 64
  const gap = 56
  const markScale = markSize / MARK_SPAN
  const markWidth = MARK_R * Math.sqrt(3) * markScale
  const typeScale = (markSize * 0.46) / wordmark.cap
  const typeWidth = wordmark.box.w * typeScale
  const typeHeight = wordmark.box.h * typeScale
  const typeTail = wordmark.tail * typeScale
  const width = Math.ceil(padX + markWidth + gap + typeWidth + padX)
  const height = Math.ceil(Math.max(markSize, typeHeight + typeTail) + padY * 2)
  const centerY = height / 2
  const markX = padX + markWidth / 2
  const typeX = padX + markWidth + gap
  const typeY = centerY - typeHeight / 2
  return svg({
    width,
    height,
    title: 'Vyotiq horizontal lockup',
    content: `${markGroup(fill, markSize, markX, centerY)}
  <g transform="translate(${f(typeX)} ${f(typeY)})">
    ${wordmark.group(fill, typeScale)}
  </g>`
  })
}

function stackAsset(fill, wordmark) {
  const markSize = 392
  const padX = 112
  const padY = 104
  const gap = 48
  const markScale = markSize / MARK_SPAN
  const markWidth = MARK_R * Math.sqrt(3) * markScale
  const typeScale = (markWidth * 0.92) / wordmark.box.w
  const typeWidth = wordmark.box.w * typeScale
  const typeHeight = wordmark.box.h * typeScale
  const typeTail = wordmark.tail * typeScale
  const width = Math.ceil(Math.max(markWidth, typeWidth) + padX * 2)
  const height = Math.ceil(padY + markSize + gap + typeHeight + typeTail + padY)
  const centerX = width / 2
  const typeX = (width - typeWidth) / 2
  const typeY = padY + markSize + gap
  return svg({
    width,
    height,
    title: 'Vyotiq stacked lockup',
    content: `${markGroup(fill, markSize, centerX, padY + markSize / 2)}
  <g transform="translate(${f(typeX)} ${f(typeY)})">
    ${wordmark.group(fill, typeScale)}
  </g>`
  })
}

function wordmarkAsset(fill, wordmark) {
  const height = wordmark.box.h + wordmark.tail
  return svg({
    width: wordmark.box.w.toFixed(3),
    height: height.toFixed(3),
    title: 'Vyotiq wordmark',
    content: wordmark.group(fill)
  })
}

/** A superellipse, sampled densely enough to be exact at 1024px. */
function squirclePath(cx, cy, half, exponent, steps = 512) {
  const points = []
  for (let i = 0; i < steps; i++) {
    const t = (i / steps) * 2 * Math.PI
    const c = Math.cos(t)
    const s = Math.sin(t)
    points.push([
      cx + half * Math.sign(c) * Math.abs(c) ** (2 / exponent),
      cy + half * Math.sign(s) * Math.abs(s) ** (2 / exponent)
    ])
  }
  return pathData(points)
}

function macosIconAsset() {
  const half = MACOS_SQUIRCLE / 2
  const centre = MACOS_CANVAS / 2
  return svg({
    width: MACOS_CANVAS,
    height: MACOS_CANVAS,
    title: 'Vyotiq app icon (macOS)',
    content: `<path d="${squirclePath(centre, centre, half, MACOS_EXPONENT)}" fill="#000000"/>
  ${markGroup('#ffffff', MACOS_SQUIRCLE * MACOS_MARK_SHARE, centre, centre)}`
  })
}

function appIconAsset() {
  return svg({
    width: 1024,
    height: 1024,
    title: 'Vyotiq app icon',
    content: `<rect width="1024" height="1024" fill="#000000"/>
  ${precisionMark('#ffffff')}`
  })
}

function socialAsset(wordmark) {
  const markSize = 216
  const gap = 76
  const markScale = markSize / MARK_SPAN
  const markWidth = MARK_R * Math.sqrt(3) * markScale
  const typeScale = (markSize * 0.46) / wordmark.cap
  const typeWidth = wordmark.box.w * typeScale
  const typeHeight = wordmark.box.h * typeScale
  const lockupWidth = markWidth + gap + typeWidth
  const markX = (1200 - lockupWidth) / 2 + markWidth / 2
  const typeX = markX + markWidth / 2 + gap
  const typeY = 315 - typeHeight / 2
  return svg({
    width: 1200,
    height: 630,
    title: 'Vyotiq social card',
    content: `<rect width="1200" height="630" fill="#000000"/>
  ${markGroup('#ffffff', markSize, markX, 315)}
  <g transform="translate(${f(typeX)} ${f(typeY)})">
    ${wordmark.group('#ffffff', typeScale)}
  </g>`
  })
}

function rasterize(source, width) {
  return new Resvg(source, {
    fitTo: { mode: 'width', value: Math.round(width * RASTER_SCALE) },
    shapeRendering: 2,
    imageRendering: 0,
    font: { loadSystemFonts: false }
  })
    .render()
    .asPng()
}

function writeAsset(name, source, width) {
  const png = rasterize(source, width)
  writeFileSync(join(outDir, `${name}.svg`), source)
  writeFileSync(join(outDir, `${name}.png`), png)
  return png
}

/*
 * The application draws the mark itself rather than loading an asset — in-app
 * chrome (VyotiqMark) and the OAuth callback page (agent/mcp/oauth.ts) both
 * need it to follow currentColor, which an <img> cannot do. Before this they
 * each carried a hand-copied snapshot of the path data, and all three had
 * drifted to different hexagon radii. Emitting one module they import keeps
 * that from happening again: change the geometry here and every consumer moves.
 */
const sharedMarkFile = join(root, 'src', 'shared', 'brand', 'vyotiqMark.ts')
function writeSharedMark() {
  const faces = precisionMarkFaces()
  const body = `/**
 * GENERATED by scripts/generate-precision-mono-brand.mjs — do not edit.
 * Run \`pnpm sync:brand\` after changing the mark's geometry.
 *
 * The same four faces the SVG kit ships, for the places that must draw the
 * mark inline to follow currentColor.
 */

/** Cropped to the hexagon, so \`width=N height=N\` renders N of real ink. */
export const VYOTIQ_MARK_VIEW_BOX = '${CX - MARK_R} ${CY - MARK_R} ${MARK_SPAN} ${MARK_SPAN}'

export const VYOTIQ_MARK_PATHS = [
${faces.map((d) => `  '${d}'`).join(',\n')}
] as const
`
  mkdirSync(dirname(sharedMarkFile), { recursive: true })
  writeFileSync(sharedMarkFile, body)
}

const wordmark = await createUnboundedWordmark()
const assets = [
  ['vyotiq-mark-black', markAsset('#000000'), MARK_SPAN],
  ['vyotiq-mark-white', markAsset('#ffffff'), MARK_SPAN],
  ['vyotiq-wordmark-black', wordmarkAsset('#000000', wordmark), wordmark.box.w],
  ['vyotiq-wordmark-white', wordmarkAsset('#ffffff', wordmark), wordmark.box.w],
  ['vyotiq-lockup-black', lockupAsset('#000000', wordmark), 1024],
  ['vyotiq-lockup-white', lockupAsset('#ffffff', wordmark), 1024],
  ['vyotiq-stack-black', stackAsset('#000000', wordmark), 1024],
  ['vyotiq-stack-white', stackAsset('#ffffff', wordmark), 1024],
  ['vyotiq-app-icon', appIconAsset(), 256],
  ['vyotiq-app-icon-macos', macosIconAsset(), 256],
  ['vyotiq-social-card', socialAsset(wordmark), 300]
]

for (const [name, source, width] of assets) {
  writeAsset(name, source, width)
}
writeSharedMark()

console.log(
  `[generate-precision-mono-brand] wrote ${assets.length * 2} assets to ${outDir}` +
    ` and ${relative(root, sharedMarkFile)}`
)
