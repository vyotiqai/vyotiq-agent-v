import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
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
const MARK_G = 28
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

function polygon(points, fill) {
  const d = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${f(point[0])} ${f(point[1])}`).join(' ')
  return `<path d="${d} Z" fill="${fill}"/>`
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

function precisionMark(fill) {
  const outer = hexagon()
  const triangle = [mid(outer[1], outer[2]), mid(outer[3], outer[4]), mid(outer[5], outer[0])]
  const faces = [
    offsetEdges(triangle, [MARK_G, MARK_G, MARK_G]),
    offsetEdges([triangle[0], outer[2], outer[3], triangle[1]], [0, 0, 0, MARK_G]),
    offsetEdges([triangle[1], outer[4], outer[5], triangle[2]], [0, 0, 0, MARK_G]),
    offsetEdges([triangle[2], outer[0], outer[1], triangle[0]], [0, 0, 0, MARK_G])
  ]
  const centroid = areaCentroid(faces)
  const shift = [CX - centroid[0], CY - centroid[1]]
  return faces.map((face) => polygon(face.map((point) => add(point, shift)), fill)).join('\n  ')
}

function svg({ width, height, title, content }) {
  return `<svg ${SVG_NS} viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${title}">
  <title>${title}</title>
  ${content}
</svg>\n`
}

function markAsset(fill) {
  return svg({ width: 1024, height: 1024, title: 'Vyotiq mark', content: precisionMark(fill) })
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

const wordmark = await createUnboundedWordmark()
const assets = [
  ['vyotiq-mark-black', markAsset('#000000'), 1024],
  ['vyotiq-mark-white', markAsset('#ffffff'), 1024],
  ['vyotiq-wordmark-black', wordmarkAsset('#000000', wordmark), wordmark.box.w],
  ['vyotiq-wordmark-white', wordmarkAsset('#ffffff', wordmark), wordmark.box.w],
  ['vyotiq-lockup-black', lockupAsset('#000000', wordmark), 1024],
  ['vyotiq-lockup-white', lockupAsset('#ffffff', wordmark), 1024],
  ['vyotiq-stack-black', stackAsset('#000000', wordmark), 1024],
  ['vyotiq-stack-white', stackAsset('#ffffff', wordmark), 1024],
  ['vyotiq-app-icon', appIconAsset(), 256],
  ['vyotiq-social-card', socialAsset(wordmark), 300]
]

for (const [name, source, width] of assets) {
  writeAsset(name, source, width)
}

console.log(`[generate-precision-mono-brand] wrote ${assets.length * 2} assets to ${outDir}`)
